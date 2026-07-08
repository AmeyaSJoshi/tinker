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
}

export interface GeneratedManifest {
  version: number;
  generatedAt: string | null;
  assets: Record<string, AssetEntry>;
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
 * Match a free-text build request to a library asset. Checks the asset's id,
 * display name, and aliases as whole-word phrases inside the request; the
 * longest matching phrase wins (so "space shuttle" beats a bare "space").
 * Returns null on no match — the caller then tries a live fetch.
 */
export function matchAsset(phrase: string): AssetEntry | null {
  const hay = normalize(phrase);
  let best: AssetEntry | null = null;
  let bestScore = 0;

  for (const asset of Object.values(loadManifest())) {
    const candidates = [asset.id.replace(/-/g, " "), asset.name, ...asset.aliases];
    for (const candidate of candidates) {
      const token = normalize(candidate);
      if (token.trim() === "") continue;
      if (hay.includes(token) && token.length > bestScore) {
        best = asset;
        bestScore = token.length;
      }
    }
  }
  return best;
}
