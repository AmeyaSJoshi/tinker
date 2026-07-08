/**
 * Poly Pizza API client (SERVER-ONLY — never import from a client component).
 *
 * Thin, typed wrapper over the Poly Pizza v1.1 REST API. It knows how to search
 * for models, rank candidates by license + poly-count, download a GLB to
 * public/models/, and keep public/models/CREDITS.json in sync so we stay
 * attribution-compliant with zero manual effort.
 *
 * API facts (confirmed against a LIVE response, not just docs — the API returns
 * PascalCase fields that don't match some third-party client examples):
 *   - Base URL:  https://api.poly.pizza/v1.1
 *   - Auth:      header `x-auth-token: <key>`  (key from poly.pizza/settings/api)
 *   - Search:    GET /search/<url-encoded-keyword>?limit=<n>&page=<n>  (limit ≤ 32)
 *   - Response:  { total: number, results: RawPolyModel[] }
 *   - RawPolyModel: { ID, Title, Description, Attribution, Thumbnail, Download
 *                     (GLB url), "Tri Count", Creator: { Username, DPURL },
 *                     Category, Tags, Licence (British spelling), Animated }
 *     Note: there is no author profile URL in the response, only Licence
 *     (not "License") and a "Tri Count" key containing a literal space.
 *
 * `searchModels` normalizes the raw shape into the camelCase `PolyModel` below
 * so every other module in this app can use a stable, sane shape.
 *
 * Env is read LAZILY inside functions so a build-time script can load a dotenv
 * file AFTER these modules are imported.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const API_BASE_URL = "https://api.poly.pizza/v1.1";

/** Poly Pizza caps a single search page at 32 results. */
export const MAX_SEARCH_LIMIT = 32;

/** Hard ceiling on a downloaded GLB. Anything bigger is skipped as too heavy. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Where downloaded GLBs and the credits ledger live (served statically). */
export const MODELS_DIR = path.join(process.cwd(), "public", "models");
export const CREDITS_PATH = path.join(MODELS_DIR, "CREDITS.json");

/** A model's creator, normalized. The API gives no author profile URL. */
export interface PolyCreator {
  name: string;
  url?: string;
}

/** A single search result, normalized to camelCase for the rest of the app. */
export interface PolyModel {
  id: string;
  title: string;
  description?: string;
  /** Pre-formatted attribution string the API hands back for CC-BY compliance. */
  attribution?: string;
  thumbnail?: string;
  /** Direct GLB download URL — the whole reason we're here. */
  download: string;
  /** Triangle count; used to prefer lighter models. May be absent. */
  triCount?: number;
  creator: PolyCreator;
  license: string;
  animated?: boolean;
  category?: string;
  tags?: string[];
}

/** The API's actual on-the-wire shape (PascalCase, "Tri Count" has a space). */
interface RawPolyModel {
  ID: string;
  Title: string;
  Description?: string;
  Attribution?: string;
  Thumbnail?: string;
  Download: string;
  "Tri Count"?: number;
  Creator?: { Username?: string; DPURL?: string };
  Category?: string;
  Tags?: string[];
  Licence?: string;
  Animated?: boolean;
}

interface PolySearchResponse {
  total: number;
  results: RawPolyModel[];
}

/** Map the API's raw PascalCase model onto our stable, camelCase PolyModel. */
function normalizeModel(raw: RawPolyModel): PolyModel {
  return {
    id: raw.ID,
    title: raw.Title,
    description: raw.Description,
    attribution: raw.Attribution,
    thumbnail: raw.Thumbnail,
    download: raw.Download,
    triCount: raw["Tri Count"],
    creator: { name: raw.Creator?.Username ?? "Unknown" },
    license: raw.Licence ?? "Unknown",
    animated: raw.Animated,
    category: raw.Category,
    tags: raw.Tags,
  };
}

/** One row in public/models/CREDITS.json. */
export interface CreditEntry {
  slug: string;
  name: string;
  author: string;
  license: string;
  url: string;
  /** The API's pre-formatted CC-BY credit line — the actual compliance text. */
  attribution: string;
}

/** Result of a successful GLB download. */
export interface DownloadResult {
  slug: string;
  filePath: string;
  /** Web path the app serves the GLB from, e.g. "/models/volcano.glb". */
  publicPath: string;
  bytes: number;
}

/** Thrown when a candidate GLB exceeds MAX_FILE_BYTES so callers can try the next one. */
export class OversizeError extends Error {
  constructor(bytes: number) {
    super(`GLB is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`);
    this.name = "OversizeError";
  }
}

function apiKey(): string {
  return (process.env.POLY_PIZZA_API_KEY || "").trim();
}

/** True when a Poly Pizza key is configured — gates all live network calls. */
export function hasApiKey(): boolean {
  return apiKey() !== "";
}

/**
 * Turn a phrase into a filesystem/URL-safe slug: lowercase, alphanumerics only,
 * collapsed dashes. "Space Shuttle!" -> "space-shuttle".
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * Rank licenses so we always prefer the most permissive: CC0 first (no
 * attribution needed), then CC-BY and its variants, then everything else last.
 * The API appends a version number (e.g. "CC-BY 3.0", "CC0 1.0"), so match on
 * the leading token rather than the whole string.
 */
function licenseRank(license: string): number {
  const variant = (license || "").toUpperCase().trim().split(/\s+/)[0];
  if (variant.startsWith("CC0")) return 0;
  if (variant === "CC-BY") return 1;
  if (variant.startsWith("CC-BY")) return 2;
  return 3;
}

/**
 * Search Poly Pizza for a keyword. Returns the raw result list (unranked).
 * Throws if no API key is configured or the request fails.
 */
export async function searchModels(
  keyword: string,
  limit = 24,
): Promise<PolyModel[]> {
  if (!hasApiKey()) {
    throw new Error("POLY_PIZZA_API_KEY is not set");
  }
  const capped = Math.min(Math.max(1, Math.floor(limit)), MAX_SEARCH_LIMIT);
  const url = `${API_BASE_URL}/search/${encodeURIComponent(keyword)}?limit=${capped}`;

  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "x-auth-token": apiKey(),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Poly Pizza search failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as PolySearchResponse;
  return Array.isArray(data?.results) ? data.results.map(normalizeModel) : [];
}

/**
 * Order candidates best-first: CC0 before CC-BY before the rest, and within a
 * license tier the lowest triangle count wins (lighter = faster to load).
 * Static, non-downloadable entries are dropped.
 */
export function rankModels(models: PolyModel[]): PolyModel[] {
  return models
    .filter((m) => typeof m.download === "string" && m.download.length > 0)
    .slice()
    .sort((a, b) => {
      const lr = licenseRank(a.license) - licenseRank(b.license);
      if (lr !== 0) return lr;
      const ta = a.triCount ?? Number.POSITIVE_INFINITY;
      const tb = b.triCount ?? Number.POSITIVE_INFINITY;
      return ta - tb;
    });
}

async function ensureModelsDir(): Promise<void> {
  await fs.mkdir(MODELS_DIR, { recursive: true });
}

/** True if a GLB for this slug already sits in public/models/. */
export async function modelExists(slug: string): Promise<boolean> {
  try {
    await fs.access(path.join(MODELS_DIR, `${slug}.glb`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Download a model's GLB to public/models/<slug>.glb. Enforces the 20 MB cap
 * (throws OversizeError so the caller can fall through to the next candidate).
 */
export async function downloadGlb(
  model: PolyModel,
  slug: string,
): Promise<DownloadResult> {
  await ensureModelsDir();

  const res = await fetch(model.download);
  if (!res.ok) {
    throw new Error(`GLB download failed (${res.status}) for ${model.title}`);
  }

  // Fast reject via Content-Length when the server provides it.
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_FILE_BYTES) {
    throw new OversizeError(declared);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new OversizeError(buffer.byteLength);
  }

  const filePath = path.join(MODELS_DIR, `${slug}.glb`);
  await fs.writeFile(filePath, buffer);

  return {
    slug,
    filePath,
    publicPath: `/models/${slug}.glb`,
    bytes: buffer.byteLength,
  };
}

/** Build the attribution ledger row for a downloaded model. */
export function creditFor(model: PolyModel, slug: string): CreditEntry {
  const url = `https://poly.pizza/m/${model.id}`;
  return {
    slug,
    name: model.title,
    author: model.creator?.name ?? "Unknown",
    license: model.license ?? "Unknown",
    url,
    attribution: model.attribution ?? `"${model.title}" by ${model.creator?.name ?? "Unknown"}, ${url}`,
  };
}

/**
 * Append a credit to public/models/CREDITS.json, de-duped by slug. Every
 * download flows through here, so the app's credits list is always complete —
 * that's what keeps us CC-BY compliant automatically.
 */
export async function appendCredit(entry: CreditEntry): Promise<void> {
  await ensureModelsDir();
  let credits: CreditEntry[] = [];
  try {
    const raw = await fs.readFile(CREDITS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) credits = parsed;
  } catch {
    // No ledger yet — start a fresh one.
  }
  const next = credits.filter((c) => c.slug !== entry.slug);
  next.push(entry);
  next.sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(CREDITS_PATH, JSON.stringify(next, null, 2));
}
