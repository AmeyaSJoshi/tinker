import { NextResponse } from "next/server";
import type { BaseAsset } from "@/lib/schema";
import {
  appendAssetEntry,
  getAsset,
  matchAsset,
  type AssetEntry,
} from "@/lib/assetManifest";
import { computeAutoManifest } from "@/lib/autoManifest";
import {
  appendCredit,
  creditFor,
  downloadGlb,
  hasApiKey,
  OversizeError,
  type PolyModel,
  rankModels,
  searchModels,
  slugify,
} from "@/lib/polypizza";

// GLB processing needs the Node runtime (fs, @gltf-transform/core), never edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long the client will wait for a live fetch before we say "use primitives". */
const LIVE_BUDGET_MS = 10_000;
/** How many ranked candidates to try before giving up on a keyword. */
const MAX_CANDIDATES = 6;

interface ResolveRequestBody {
  phrase: string;
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
 * Keep only candidates whose TITLE plausibly names the requested noun. Poly
 * Pizza's relevance ordering is noisy and rankModels re-sorts purely by
 * license/poly-count, so without this a fictional or unknown noun (e.g. "flux
 * capacitor") would grab an unrelated low-poly CC0 model and mislabel it — first
 * a "Sci Fi Wall Power Cell", then a "Capacitor Rifle".
 *
 * We require EVERY significant token of the noun to appear in the title. A real
 * "Flux Capacitor" model would still qualify (and beat primitives), but a
 * "Capacitor Rifle" (only "capacitor") won't. An empty result means "no real
 * match" → the caller falls back to letting the LLM build it from primitives.
 */
function relevantCandidates(models: PolyModel[], noun: string): PolyModel[] {
  const tokens = noun
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  if (tokens.length === 0) return models;
  return models.filter((m) => {
    const title = (m.title ?? "").toLowerCase();
    return tokens.every((t) => title.includes(t));
  });
}

/** A simple teacherly intro for live-fetched assets (prefetch generates richer ones). */
function templatedIntro(noun: string): string {
  return `Here's a realistic ${noun} to explore. Click it to learn more, and tell me what to add or ask how any part works — we'll build up the science together.`;
}

/**
 * In-flight de-dupe: two requests for the same slug share one download promise,
 * and the promise outlives a timed-out request so the file still lands for next
 * time. Each entry resolves to the finished asset or null (never rejects).
 */
const inFlight = new Map<string, Promise<AssetEntry | null>>();

function startFetch(noun: string, slug: string): Promise<AssetEntry | null> {
  const existing = inFlight.get(slug);
  if (existing) return existing;

  const task = (async (): Promise<AssetEntry | null> => {
    try {
      const models = await searchModels(noun, 24);
      // Only accept models whose title actually names the noun; otherwise fall
      // back to primitives rather than surfacing a mislabeled random model.
      const ranked = relevantCandidates(rankModels(models), noun).slice(0, MAX_CANDIDATES);
      if (ranked.length === 0) {
        console.log(`[resolve-asset] no title-relevant model for "${noun}" — using primitives`);
        return null;
      }
      for (const model of ranked) {
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
            source: "live",
          };
          await appendAssetEntry(entry);
          await appendCredit(creditFor(model, slug));
          return entry;
        } catch (err) {
          if (err instanceof OversizeError) continue; // try the next candidate
          console.warn(`[resolve-asset] candidate failed for "${noun}":`, err);
        }
      }
      return null;
    } catch (err) {
      console.warn(`[resolve-asset] live fetch failed for "${noun}":`, err);
      return null;
    } finally {
      inFlight.delete(slug);
    }
  })();

  inFlight.set(slug, task);
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

  // 1. Local library — instant.
  const local = matchAsset(phrase);
  if (local) {
    return NextResponse.json<ResolveResponse>({
      status: "library",
      asset: toBaseAsset(local),
    });
  }

  const noun = extractNoun(phrase) || phrase;
  const slug = slugify(noun);
  if (slug === "") {
    return NextResponse.json<ResolveResponse>({ status: "primitives", noun });
  }

  // A previous live fetch may already have cached this exact slug.
  const cached = getAsset(slug);
  if (cached) {
    return NextResponse.json<ResolveResponse>({
      status: "library",
      asset: toBaseAsset(cached),
    });
  }

  // 2. Live fetch — but only if we have a key, and only within the budget.
  if (!hasApiKey()) {
    return NextResponse.json<ResolveResponse>({ status: "primitives", noun });
  }

  const task = startFetch(noun, slug);
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
