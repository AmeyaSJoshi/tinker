/**
 * Asset manifest loader + matching helpers (SERVER-ONLY).
 *
 * The manifest is DATA, not code: `npm run fetch-assets` writes
 * lib/assetManifest.generated.json, and this module loads it, merges the
 * hand-written overrides in lib/assetOverrides.ts on top, and exposes typed
 * lookups so routes can resolve a build request to a real GLB.
 *
 * Freshness: we read the generated JSON from disk on every call so that assets
 * appended at runtime by the live-fetch route are visible immediately. If the
 * filesystem isn't readable (e.g. a locked-down serverless bundle), we fall back
 * to the version that was statically imported at build time.
 */
import fs from "node:fs";
import path from "node:path";
import type { AnchorMap, BoundingBox } from "./autoManifest";
import { assetOverrides, type AssetOverride } from "./assetOverrides";
import staticManifest from "./assetManifest.generated.json";

/** Metadata about a single component in a GLB (for semantic naming). */
export interface ComponentMetadata {
  /** Raw mesh/material name from the GLB. */
  rawName: string;
  /** LLM-generated semantic name (e.g., "Nosecone", "Fin (left)"). */
  semanticName: string;
}

/** A virtual component (for single-mesh models with no submeshes). */
export interface VirtualComponentMetadata {
  name: string;
  position: [number, number, number]; // normalized -1..1
  whatItIs: string;
}

/** A complete manifest entry: everything needed to place + teach one base model. */
export interface AssetEntry {
  /** Slug id, also the GLB filename stem (e.g. "space-shuttle"). */
  id: string;
  name: string;
  /** Web path to the GLB, e.g. "/models/volcano.glb". */
  url: string;
  scale: number;
  yOffset: number;
  boundingBox: BoundingBox;
  anchors: AnchorMap;
  aliases: string[];
  concepts: string[];
  intro: string;
  license: string;
  author: string;
  authorUrl?: string;
  attributionUrl: string;
  triCount?: number;
  /** How this entry got here — prefetched offline or fetched live at runtime. */
  source: "prefetch" | "live";
  /** Poly Pizza's own model id (the `m/<id>` in attributionUrl), for rejection-exclusion. */
  sourceModelId?: string;
  /** LLM-generated semantic names for submeshes (Phase 3.4B). Cached per asset. */
  componentMetadata?: ComponentMetadata[];
  /** Virtual components for single-mesh models (Phase 3.4B). */
  virtualComponents?: VirtualComponentMetadata[];
}

/** One cached semantic-validation outcome, keyed by normalized request phrase. */
export interface ValidationCacheEntry {
  /** Poly Pizza model id of the validated winner, or null = "no valid match". */
  modelId: string | null;
  ts: string;
}

export interface GeneratedManifest {
  version: number;
  generatedAt: string | null;
  assets: Record<string, AssetEntry>;
  /** Cached asset-candidate validation verdicts, so repeat phrases skip the LLM call. */
  validationCache?: Record<string, ValidationCacheEntry>;
}

function normalizePhraseKey(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Look up a cached validation verdict for this exact request phrase, if any. */
export function getValidationVerdict(phrase: string): ValidationCacheEntry | null {
  const generated = readGenerated();
  return generated.validationCache?.[normalizePhraseKey(phrase)] ?? null;
}

/** Persist a validation verdict (winning model id, or null for "no match"). */
export function setValidationVerdict(
  phrase: string,
  modelId: string | null,
): Promise<void> {
  const key = normalizePhraseKey(phrase);
  writeChain = writeChain.then(async () => {
    const current = readGenerated();
    const next: GeneratedManifest = {
      ...current,
      version: current.version ?? 1,
      validationCache: {
        ...(current.validationCache ?? {}),
        [key]: { modelId, ts: new Date().toISOString() },
      },
    };
    await fs.promises.writeFile(GENERATED_PATH, JSON.stringify(next, null, 2));
  });
  return writeChain;
}

/** The Poly Pizza model id an asset came from, from its own field or the attribution URL. */
export function sourceModelIdOf(entry: AssetEntry): string | null {
  if (entry.sourceModelId) return entry.sourceModelId;
  const match = entry.attributionUrl.match(/\/m\/([^/]+)$/);
  return match ? match[1] : null;
}

const GENERATED_PATH = path.join(
  process.cwd(),
  "lib",
  "assetManifest.generated.json",
);

/** Read the generated manifest fresh from disk, falling back to the static import. */
function readGenerated(): GeneratedManifest {
  try {
    const raw = fs.readFileSync(GENERATED_PATH, "utf8");
    return JSON.parse(raw) as GeneratedManifest;
  } catch {
    return staticManifest as unknown as GeneratedManifest;
  }
}

/** Serializes concurrent writes so two live fetches can't clobber the file. */
let writeChain: Promise<void> = Promise.resolve();

/** Overwrite the entire generated manifest (used by the fetch-assets script). */
export function writeGeneratedManifest(manifest: GeneratedManifest): void {
  fs.writeFileSync(GENERATED_PATH, JSON.stringify(manifest, null, 2));
}

/**
 * Append (or replace) a single asset entry on disk, read-modify-write under a
 * mutex. Used by the live-fetch route so a brand-new asset is queryable on the
 * very next request. Returns a promise that resolves once the write lands.
 */
export function appendAssetEntry(entry: AssetEntry): Promise<void> {
  writeChain = writeChain.then(async () => {
    const current = readGenerated();
    const next: GeneratedManifest = {
      version: current.version ?? 1,
      generatedAt: new Date().toISOString(),
      assets: { ...current.assets, [entry.id]: entry },
    };
    await fs.promises.writeFile(GENERATED_PATH, JSON.stringify(next, null, 2));
  });
  return writeChain;
}

/** Apply one override on top of a base entry (anchors + aliases merge, not replace). */
function applyOverride(base: AssetEntry, override: AssetOverride): AssetEntry {
  const { anchors, aliases, ...rest } = override;
  return {
    ...base,
    ...rest,
    anchors: anchors
      ? ({ ...base.anchors, ...anchors } as AnchorMap)
      : base.anchors,
    aliases: aliases
      ? Array.from(new Set([...base.aliases, ...aliases]))
      : base.aliases,
  };
}

/** Load the full manifest with overrides merged in. */
export function loadManifest(): Record<string, AssetEntry> {
  const generated = readGenerated();
  const assets: Record<string, AssetEntry> = {};
  for (const [id, entry] of Object.entries(generated.assets ?? {})) {
    const override = assetOverrides[id];
    assets[id] = override ? applyOverride(entry, override) : entry;
  }
  return assets;
}

/** Every known asset, id-keyed. */
export function listAssets(): AssetEntry[] {
  return Object.values(loadManifest());
}

/** Fetch one asset by exact id (with overrides applied), or null. */
export function getAsset(id: string): AssetEntry | null {
  const assets = loadManifest();
  return assets[id] ?? null;
}

/** Normalize to a space-padded, alphanumeric-token string for whole-word matching. */
function normalize(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/**
 * Match a build request's core NOUN to a library asset by EXACT name/alias
 * match (after normalization) — not a substring check against the whole
 * sentence. A substring check is exactly what let a MORE SPECIFIC, compound
 * request like "peanut jar" silently collapse onto the plain "peanut" asset,
 * just because "peanut" happens to be a whole word inside it: the request
 * never even reached a live search, so "peanut jar" could never be validated
 * against a real jar/container model. The caller should pass the already
 * noun-extracted phrase (not the raw sentence) so "build me a spaceship"
 * still matches "spaceship" exactly. Returns null on no exact match — the
 * caller then tries a live, validated search for the full noun.
 */
export function matchAsset(noun: string): AssetEntry | null {
  const target = normalize(noun).trim();
  if (target === "") return null;

  for (const asset of Object.values(loadManifest())) {
    const candidates = [asset.id.replace(/-/g, " "), asset.name, ...asset.aliases];
    for (const candidate of candidates) {
      if (normalize(candidate).trim() === target) return asset;
    }
  }
  return null;
}
