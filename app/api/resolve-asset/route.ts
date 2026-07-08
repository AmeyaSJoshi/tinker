import { NextResponse } from "next/server";
import type { BaseAsset } from "@/lib/schema";
import {
  DEFAULT_LIVE_BUDGET_MS,
  resolveAssetForPhrase,
  toBaseAsset,
} from "@/lib/assetResolutionService";

// GLB processing needs the Node runtime (fs, @gltf-transform/core), never edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const result = await resolveAssetForPhrase(phrase, excludeIds, DEFAULT_LIVE_BUDGET_MS);

  return NextResponse.json<ResolveResponse>({
    status: result.status,
    asset: result.entry ? toBaseAsset(result.entry) : undefined,
    pending: result.pending,
    noun: result.noun,
  });
}
