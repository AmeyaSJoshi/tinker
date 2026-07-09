/**
 * Sketchfab Data API client (SERVER-ONLY).
 *
 * Used only by the offline library-building script. Live per-request asset
 * resolution intentionally remains Poly Pizza-only.
 */

export const SKETCHFAB_API_BASE = "https://api.sketchfab.com/v3";

export interface SketchfabLicense {
  slug: string;
  label: string;
  url?: string;
}

export interface SketchfabModel {
  uid: string;
  title: string;
  description?: string;
  viewerUrl: string;
  author: string;
  authorUrl?: string;
  license: SketchfabLicense;
  faceCount?: number;
}

export interface SketchfabDownloadArchive {
  url: string;
  size?: number;
  expires?: string;
  format: "glb" | "gltf" | "source";
}

interface RawSketchfabUser {
  displayName?: string;
  username?: string;
  profileUrl?: string;
}

interface RawSketchfabLicense {
  slug?: string;
  label?: string;
  url?: string;
}

interface RawSketchfabModel {
  uid?: string;
  name?: string;
  title?: string;
  description?: string;
  viewerUrl?: string;
  uri?: string;
  user?: RawSketchfabUser;
  license?: RawSketchfabLicense;
  faceCount?: number;
}

interface RawSketchfabSearch {
  results?: RawSketchfabModel[];
}

interface RawSketchfabDownload {
  gltf?: SketchfabDownloadArchive;
  glb?: SketchfabDownloadArchive;
  source?: SketchfabDownloadArchive;
}

function token(): string {
  return (process.env.SKETCHFAB_API_TOKEN || "").trim();
}

export function hasSketchfabToken(): boolean {
  return token() !== "";
}

function authHeaders(): HeadersInit {
  const apiToken = token();
  if (!apiToken) throw new Error("SKETCHFAB_API_TOKEN is not set");
  return { Authorization: `Token ${apiToken}` };
}

function normalizeLicense(raw: RawSketchfabLicense | undefined): SketchfabLicense {
  return {
    slug: raw?.slug ?? "",
    label: raw?.label ?? raw?.slug ?? "Unknown",
    url: raw?.url,
  };
}

function isAllowedLicense(license: SketchfabLicense): boolean {
  const slug = license.slug.toLowerCase();
  const label = license.label.toLowerCase();
  return slug === "cc0" || slug === "by" || label.includes("cc0") || label === "cc attribution";
}

function normalizeModel(raw: RawSketchfabModel): SketchfabModel | null {
  if (!raw.uid) return null;
  const license = normalizeLicense(raw.license);
  if (!isAllowedLicense(license)) return null;
  const title = raw.name ?? raw.title;
  if (!title) return null;
  return {
    uid: raw.uid,
    title,
    description: raw.description,
    viewerUrl: raw.viewerUrl ?? `https://sketchfab.com/3d-models/${raw.uid}`,
    author: raw.user?.displayName ?? raw.user?.username ?? "Unknown",
    authorUrl: raw.user?.profileUrl,
    license,
    faceCount: raw.faceCount,
  };
}

export async function searchSketchfabModels(
  query: string,
  limit = 12,
): Promise<SketchfabModel[]> {
  const requestedCount = Math.max(1, Math.min(24, Math.floor(limit)));
  const fetchSearch = (count: number) => {
    const params = new URLSearchParams({
      type: "models",
      q: query,
      downloadable: "true",
      count: String(count),
    });
    return fetch(`${SKETCHFAB_API_BASE}/search?${params.toString()}`, {
      headers: authHeaders(),
    });
  };
  let res = await fetchSearch(requestedCount);
  if (res.status === 408 && requestedCount > 3) {
    res = await fetchSearch(3);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sketchfab search failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as RawSketchfabSearch;
  return (data.results ?? [])
    .map(normalizeModel)
    .filter((model): model is SketchfabModel => model !== null)
    .filter((model) => model.faceCount === undefined || model.faceCount <= 50_000);
}

export async function getSketchfabDownloadArchive(
  uid: string,
): Promise<SketchfabDownloadArchive> {
  const res = await fetch(`${SKETCHFAB_API_BASE}/models/${encodeURIComponent(uid)}/download`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sketchfab download lookup failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as RawSketchfabDownload;
  const format = data.glb ? "glb" : data.gltf ? "gltf" : data.source ? "source" : null;
  if (format === null) throw new Error(`Sketchfab model ${uid} has no downloadable archive URL`);
  const archive = data[format];
  if (!archive?.url) throw new Error(`Sketchfab model ${uid} has no downloadable archive URL`);
  return { ...archive, format };
}

export function sketchfabCredit(model: SketchfabModel, slug: string) {
  return {
    slug,
    name: model.title,
    author: model.author,
    license: model.license.label,
    url: model.viewerUrl,
    attribution: `"${model.title}" by ${model.author} on Sketchfab, ${model.viewerUrl}. License: ${model.license.label}${model.license.url ? ` (${model.license.url})` : ""}.`,
  };
}
