/**
 * Single-object asset resolution (SERVER-ONLY).
 *
 * The shared "resolve one phrase to a real GLB, or fall back to primitives"
 * pipeline: library exact-match -> validated live fetch -> primitives. Used
 * by both /api/resolve-asset (one object) and /api/compose-scene (each
 * component of a compound build), so there is exactly one place that owns
 * the library/cache/live-fetch/in-flight-dedupe rules.
 */
import type { BaseAsset } from "./schema";
import {
  appendAssetEntry,
  getAsset,
  getValidationVerdict,
  matchAsset,
  setValidationVerdict,
  sourceModelIdOf,
  type AssetEntry,
} from "./assetManifest";
import { computeAutoManifest } from "./autoManifest";
import { resolveValidatedModel } from "./assetResolver";
import { extractNoun } from "./nounExtractor";
import {
  appendCredit,
  creditFor,
  downloadGlb,
  hasApiKey,
  OversizeError,
  searchModels,
  type PolyModel,
  slugify,
} from "./polypizza";

/** How long a caller will wait for a live fetch before treating it as "primitives". */
export const DEFAULT_LIVE_BUDGET_MS = 10_000;

export interface AssetResolutionResult {
  status: "library" | "live" | "primitives";
  entry?: AssetEntry;
  /** For "primitives" via timeout: a download is still finishing in the background. */
  pending?: boolean;
  /** The core noun extracted from the phrase (always populated). */
  noun: string;
}

/** Narrow a full server-side entry to the client-safe base-asset shape. */
export function toBaseAsset(entry: AssetEntry): BaseAsset {
  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    scale: entry.scale,
    yOffset: entry.yOffset,
    intro: entry.intro,
    concepts: entry.concepts,
    boundingBox: entry.boundingBox,
    sourceModelId: sourceModelIdOf(entry) ?? undefined,
    componentMetadata: entry.componentMetadata,
    virtualComponents: entry.virtualComponents,
    provenance: entry.provenance,
  };
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A simple teacherly intro for live-fetched assets (prefetch generates richer ones). */
function templatedIntro(noun: string): string {
  return `Here's a realistic ${noun} to explore. Click it to learn more, and tell me what to add or ask how any part works — we'll build up the science together.`;
}

/**
 * Find a genuinely-matching model for `noun`, backed by the LLM semantic
 * validator (never a plain title-substring check — that's exactly what let
 * "bear" match "Bear Trap" and "peanut" match "Peanut Butter" before).
 *
 * A clean request (no exclusions) checks the validation cache first, so a
 * repeat phrase never re-spends an LLM call: a null cached verdict means "we
 * already confirmed nothing qualifies," so we go straight to primitives.
 * The cache is keyed by the NOUN, not the raw phrase.
 */
async function findValidatedModel(
  phrase: string,
  noun: string,
  excludeIds: string[],
): Promise<PolyModel | null> {
  const excludeSet = new Set(excludeIds);

  if (excludeSet.size === 0) {
    const cached = getValidationVerdict(noun);
    if (cached) {
      if (cached.modelId === null) return null;
      try {
        const raw = await searchModels(noun, 24);
        const found = raw.find((m) => m.id === cached.modelId);
        if (found) return found;
      } catch {
        // Fall through to a fresh validation below.
      }
    }
  }

  const winner = await resolveValidatedModel(phrase, noun, excludeSet);

  // Only cache "clean" resolutions — an exclusion-driven retry is a one-off
  // rejection, not the general verdict for this phrase.
  if (excludeSet.size === 0) {
    await setValidationVerdict(noun, winner ? winner.id : null);
  }

  return winner;
}

/**
 * In-flight de-dupe: two requests for the same (slug, exclusion set) share one
 * download promise, and the promise outlives a timed-out caller so the file
 * still lands for next time. Each entry resolves to the finished asset or null
 * (never rejects).
 */
const inFlight = new Map<string, Promise<AssetEntry | null>>();

function startFetch(
  phrase: string,
  noun: string,
  slug: string,
  excludeIds: string[],
): Promise<AssetEntry | null> {
  const key = `${slug}::${excludeIds.slice().sort().join(",")}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<AssetEntry | null> => {
    try {
      // Never download a bad match just because it's the best available: the
      // validator either hands back a real single-object winner or nothing.
      const model = await findValidatedModel(phrase, noun, excludeIds);
      if (!model) {
        console.log(`[assetResolutionService] no validated model for "${noun}" — using primitives`);
        return null;
      }
      try {
        const dl = await downloadGlb(model, slug);
        const geo = await computeAutoManifest(dl.filePath);
        const entry: AssetEntry = {
          id: slug,
          name: titleCase(noun),
          url: dl.publicPath,
          scale: geo.scale,
          yOffset: geo.yOffset,
          boundingBox: geo.boundingBox,
          anchors: geo.anchors,
          aliases: [],
          concepts: [],
          intro: templatedIntro(noun),
          license: model.license,
          author: model.creator?.name ?? "Unknown",
          authorUrl: model.creator?.url,
          attributionUrl: `https://poly.pizza/m/${model.id}`,
          triCount: model.triCount,
          sourceModelId: model.id,
          source: "live",
          provenance: "poly_pizza",
        };
        await appendAssetEntry(entry);
        await appendCredit(creditFor(model, slug));
        return entry;
      } catch (err) {
        if (err instanceof OversizeError) {
          console.warn(`[assetResolutionService] validated model for "${noun}" was oversized`);
        } else {
          console.warn(`[assetResolutionService] download failed for "${noun}":`, err);
        }
        return null;
      }
    } catch (err) {
      console.warn(`[assetResolutionService] live fetch failed for "${noun}":`, err);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}

const TIMEOUT = Symbol("timeout");

/**
 * Resolve `phrase` to a real GLB through the library -> live-fetch -> nothing
 * pipeline, budgeted at `budgetMs` for the live-fetch tier. `excludeIds`
 * (Poly Pizza model ids) are never re-picked, e.g. so a rejected model can't
 * come back. Never throws — a hard failure degrades to `{ status:
 * "primitives" }` so the caller can fall back to a primitives build.
 */
export async function resolveAssetForPhrase(
  phrase: string,
  excludeIds: string[] = [],
  budgetMs: number = DEFAULT_LIVE_BUDGET_MS,
): Promise<AssetResolutionResult> {
  const trimmedPhrase = phrase.trim();
  const noun = extractNoun(trimmedPhrase) || trimmedPhrase;

  if (noun === "") {
    return { status: "primitives", noun };
  }

  // Exclusions mean the caller just rejected the current match ("no, a real
  // bike") — they want something DIFFERENT, so the instant library/cache
  // shortcuts (which would just hand back the same rejected model) are
  // skipped in favor of a fresh, validated live search.
  if (excludeIds.length === 0) {
    // 1. Local library — instant, but ONLY on an exact match to the noun. A
    // more specific compound noun ("peanut jar") is NOT the same request as
    // a known shorter asset ("peanut") and must go to a live, validated
    // search instead of silently collapsing onto the wrong model.
    const local = matchAsset(noun);
    if (local) {
      return { status: "library", entry: local, noun };
    }
  }

  const slug = slugify(noun);
  if (slug === "") {
    return { status: "primitives", noun };
  }

  if (excludeIds.length === 0) {
    // A previous live fetch may already have cached this exact slug.
    const cached = getAsset(slug);
    if (cached) {
      return { status: "library", entry: cached, noun };
    }
  }

  // 2. Live fetch — but only if we have a key, and only within the budget.
  if (!hasApiKey()) {
    return { status: "primitives", noun };
  }

  const task = startFetch(trimmedPhrase, noun, slug, excludeIds);
  const timer = new Promise<typeof TIMEOUT>((resolve) =>
    setTimeout(() => resolve(TIMEOUT), budgetMs),
  );
  const result = await Promise.race([task, timer]);

  if (result === TIMEOUT) {
    // Over budget: fall back now; the download keeps going for next time.
    return { status: "primitives", pending: true, noun };
  }
  if (result) {
    return { status: "live", entry: result, noun };
  }
  // No usable model found — quietly fall back to primitives.
  return { status: "primitives", noun };
}
