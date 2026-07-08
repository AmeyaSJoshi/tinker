import { NextResponse } from "next/server";
import type { BaseAsset } from "@/lib/schema";
import {
  appendAssetEntry,
  getAsset,
  getValidationVerdict,
  matchAsset,
  setValidationVerdict,
  sourceModelIdOf,
  type AssetEntry,
} from "@/lib/assetManifest";
import { computeAutoManifest } from "@/lib/autoManifest";
import { resolveValidatedModel } from "@/lib/assetResolver";
import {
  appendCredit,
  creditFor,
  downloadGlb,
  hasApiKey,
  OversizeError,
  searchModels,
  type PolyModel,
  slugify,
} from "@/lib/polypizza";

// GLB processing needs the Node runtime (fs, @gltf-transform/core), never edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long the client will wait for a live fetch before we say "use primitives". */
const LIVE_BUDGET_MS = 10_000;

interface ResolveRequestBody {
  phrase: string;
  /** Poly Pizza model ids the learner already rejected — never re-pick these. */
  excludeIds?: string[];
}

/**
 * Response the client acts on:
 *  - library: matched a prefetched asset (instant)
 *  - live:    fetched + processed a new asset just now
 *  - primitives: nothing usable / no key / timed out — fall back to the LLM build
 */
interface ResolveResponse {
  status: "library" | "live" | "primitives";
  asset?: BaseAsset;
  /** For "primitives" via timeout: a download is still finishing in the background. */
  pending?: boolean;
  noun?: string;
}

/** Narrow a full server-side entry to the client-safe base-asset shape. */
function toBaseAsset(entry: AssetEntry): BaseAsset {
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
  };
}

/** Strip build verbs and articles to get the core noun: "build a lighthouse" -> "lighthouse". */
function extractNoun(phrase: string): string {
  let s = phrase.toLowerCase().trim().replace(/[.?!]+$/g, "");
  s = s.replace(
    /^(please\s+)?(can you\s+|could you\s+)?(i\s+(want|wanna|would like|'?d like)\s+(to\s+)?)?(build|make|create|design|show me|give me|draw|model|render|let'?s\s+(build|make|create)|add)\s+/,
    "",
  );
  s = s.replace(/^(a|an|the|some|my)\s+/, "");
  s = s.replace(/\s+(please|for me|now)$/g, "");
  return s.trim();
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Find a genuinely-matching model for `noun`, backed by the LLM semantic
 * validator (never a plain title-substring check — that's exactly what let
 * "bear" match "Bear Trap" and "peanut" match "Peanut Butter" before).
 *
 * A clean request (no exclusions) checks the validation cache first, so a
 * repeat phrase never re-spends an LLM call: a null cached verdict means "we
 * already confirmed nothing qualifies," so we go straight to primitives.
 */
async function findValidatedModel(
  phrase: string,
  noun: string,
  excludeIds: string[],
): Promise<PolyModel | null> {
  const excludeSet = new Set(excludeIds);

  if (excludeSet.size === 0) {
    const cached = getValidationVerdict(phrase);
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
    await setValidationVerdict(phrase, winner ? winner.id : null);
  }

  return winner;
}

/** A simple teacherly intro for live-fetched assets (prefetch generates richer ones). */
function templatedIntro(noun: string): string {
  return `Here's a realistic ${noun} to explore. Click it to learn more, and tell me what to add or ask how any part works — we'll build up the science together.`;
}

/**
 * In-flight de-dupe: two requests for the same (slug, exclusion set) share one
 * download promise, and the promise outlives a timed-out request so the file
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
        console.log(`[resolve-asset] no validated model for "${noun}" — using primitives`);
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
        };
        await appendAssetEntry(entry);
        await appendCredit(creditFor(model, slug));
        return entry;
      } catch (err) {
        if (err instanceof OversizeError) {
          console.warn(`[resolve-asset] validated model for "${noun}" was oversized`);
        } else {
          console.warn(`[resolve-asset] download failed for "${noun}":`, err);
        }
        return null;
      }
    } catch (err) {
      console.warn(`[resolve-asset] live fetch failed for "${noun}":`, err);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}

const TIMEOUT = Symbol("timeout");

export async function POST(request: Request) {
  let body: ResolveRequestBody;
  try {
    body = (await request.json()) as ResolveRequestBody;
  } catch {
    return NextResponse.json<ResolveResponse>({ status: "primitives" });
  }

  const phrase = (body?.phrase ?? "").trim();
  if (phrase === "") {
    return NextResponse.json<ResolveResponse>({ status: "primitives" });
  }

  const excludeIds = Array.isArray(body?.excludeIds)
    ? body.excludeIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];

  // Exclusions mean the learner just rejected the current match ("no, a real
  // bike") — they want something DIFFERENT, so the instant library/cache
  // shortcuts (which would just hand back the same rejected model) are skipped
  // in favor of a fresh, validated live search.
  if (excludeIds.length === 0) {
    // 1. Local library — instant.
    const local = matchAsset(phrase);
    if (local) {
      return NextResponse.json<ResolveResponse>({
        status: "library",
        asset: toBaseAsset(local),
      });
    }
  }

  const noun = extractNoun(phrase) || phrase;
  const slug = slugify(noun);
  if (slug === "") {
    return NextResponse.json<ResolveResponse>({ status: "primitives", noun });
  }

  if (excludeIds.length === 0) {
    // A previous live fetch may already have cached this exact slug.
    const cached = getAsset(slug);
    if (cached) {
      return NextResponse.json<ResolveResponse>({
        status: "library",
        asset: toBaseAsset(cached),
      });
    }
  }

  // 2. Live fetch — but only if we have a key, and only within the budget.
  if (!hasApiKey()) {
    return NextResponse.json<ResolveResponse>({ status: "primitives", noun });
  }

  const task = startFetch(phrase, noun, slug, excludeIds);
  const timer = new Promise<typeof TIMEOUT>((resolve) =>
    setTimeout(() => resolve(TIMEOUT), LIVE_BUDGET_MS),
  );
  const result = await Promise.race([task, timer]);

  if (result === TIMEOUT) {
    // Over budget: fall back now; the download keeps going for next time.
    return NextResponse.json<ResolveResponse>({
      status: "primitives",
      pending: true,
      noun,
    });
  }
  if (result) {
    return NextResponse.json<ResolveResponse>({
      status: "live",
      asset: toBaseAsset(result),
      noun,
    });
  }
  // No usable model found — quietly fall back to primitives.
  return NextResponse.json<ResolveResponse>({ status: "primitives", noun });
}
