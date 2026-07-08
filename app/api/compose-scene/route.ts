import { NextResponse } from "next/server";
import {
  buildComposeScenePrompt,
  compoundLayoutSchema,
  type CompoundComponent,
} from "@/lib/composeScenePrompt";
import { buildPrimitivesFallbackPrompt } from "@/lib/tutorPrompt";
import { tutorResponseSchema, type Part, type PlacedAsset } from "@/lib/schema";
import { callTutor, generateText, LlmError, type LlmMessage } from "@/lib/llm";
import { extractJsonObject } from "@/lib/jsonExtract";
import {
  DEFAULT_LIVE_BUDGET_MS,
  resolveAssetForPhrase,
  toBaseAsset,
} from "@/lib/assetResolutionService";
import { TARGET_HEIGHT } from "@/lib/autoManifest";
import type { AssetEntry } from "@/lib/assetManifest";

// GLB processing needs the Node runtime (fs, @gltf-transform/core), never edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** World-space distance one floor-grid unit covers. */
const GRID_SPACING = 1.7;
/** Minimum world-space gap enforced between two floor-standing components. */
const MIN_FLOOR_GAP = 1.4;
/** Fallback "surface height" when we truly can't estimate one. */
const DEFAULT_SURFACE_HEIGHT = 0.75;
/** Sane clamps on the GLB placement multiplier so a bad targetHeight can't blow up the scene. */
const MIN_PLACEMENT_SCALE = 0.02;
const MAX_PLACEMENT_SCALE = 5;

interface ComposeSceneRequestBody {
  phrase: string;
}

interface ComposeSceneResponse {
  status: "ok" | "failed";
  baseAssets?: PlacedAsset[];
  parts?: Part[];
  reply?: string;
  suggestedActions?: string[];
  followUpQuestion?: string | null;
  concepts?: string[];
}

const FAILED: ComposeSceneResponse = { status: "failed" };

/** Internal per-component working state through decomposition -> resolution -> layout -> render. */
interface WorkingComponent extends CompoundComponent {
  worldX: number;
  worldZ: number;
  worldY: number;
  resolvedEntry?: AssetEntry;
  /** GLB placement multiplier (targetHeight / TARGET_HEIGHT, clamped) — only set when resolvedEntry is. */
  resolvedScale?: number;
  /** Already rescaled to targetHeight — only set when the component fell back to primitives. */
  resolvedParts?: Part[];
}

/** Ask the tutor model to decompose the phrase into components + floor layout. */
async function decompose(phrase: string, signal: AbortSignal): Promise<{
  components: CompoundComponent[];
  intro: string;
} | null> {
  try {
    const raw = await generateText(buildComposeScenePrompt(phrase), signal);
    const block = extractJsonObject(raw);
    if (!block) return null;
    const parsed = JSON.parse(block);
    const result = compoundLayoutSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") throw err;
    console.warn("[compose-scene] decomposition failed:", err);
    return null;
  }
}

/**
 * Simple grid/AABB sanity pass (Task 4.4 — "nothing fancy"):
 *  - onSurface components inherit their surface's grid position, spread by a
 *    small deterministic jitter so multiple items on one surface don't stack.
 *  - Floor components that land too close to each other get nudged apart
 *    along the vector between their centers.
 */
function layoutSanityPass(components: CompoundComponent[]): CompoundComponent[] {
  const byName = new Map(components.map((c) => [c.name, c]));
  const resolved = components.map((c) => ({ ...c }));

  // onSurface components: inherit the surface's grid slot, jittered so
  // several items on the same surface don't sit exactly on top of each other.
  const onSameSurface = new Map<string, number>();
  for (const c of resolved) {
    if (!c.onSurface) continue;
    const surface = byName.get(c.onSurface);
    if (!surface) {
      c.onSurface = null; // named a surface that doesn't exist — treat as floor
      continue;
    }
    const idx = onSameSurface.get(c.onSurface) ?? 0;
    onSameSurface.set(c.onSurface, idx + 1);
    const jitter = idx === 0 ? 0 : (idx % 2 === 1 ? 1 : -1) * 0.35 * Math.ceil(idx / 2);
    c.gridX = surface.gridX + jitter;
    c.gridZ = surface.gridZ;
  }

  // Floor components: nudge apart anything closer than MIN_FLOOR_GAP (a few
  // relaxation passes is plenty for up to 6 components).
  const floor = resolved.filter((c) => !c.onSurface);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < floor.length; i++) {
      for (let j = i + 1; j < floor.length; j++) {
        const a = floor[i];
        const b = floor[j];
        const dx = b.gridX - a.gridX;
        const dz = b.gridZ - a.gridZ;
        const dist = Math.hypot(dx, dz);
        if (dist >= MIN_FLOOR_GAP || dist < 1e-6) continue;
        const push = (MIN_FLOOR_GAP - dist) / 2;
        const ux = dx / dist;
        const uz = dz / dist;
        a.gridX -= ux * push;
        a.gridZ -= uz * push;
        b.gridX += ux * push;
        b.gridZ += uz * push;
      }
    }
  }

  return resolved;
}

/** Approximate top-of-bounding-box Y for one primitive part. */
function partTopY(part: Part): number {
  return part.position[1] + partHalfHeight(part);
}

function partHalfHeight(part: Part): number {
  const d = part.dimensions;
  switch (part.shape) {
    case "sphere":
      return d.radius ?? 0.5;
    case "box":
    case "cylinder":
    case "cone":
      return (d.height ?? 1) / 2;
    case "capsule":
      return (d.height ?? 1) / 2 + (d.radius ?? 0.3);
    case "torus":
      return d.radius ?? 0.5;
    default:
      return 0.5;
  }
}

/** Uniformly scale one part's position and dimensions about the origin by `factor`. */
function scalePart(part: Part, factor: number): Part {
  const d = part.dimensions;
  return {
    ...part,
    position: [part.position[0] * factor, part.position[1] * factor, part.position[2] * factor] as Part["position"],
    dimensions: {
      width: d.width != null ? d.width * factor : undefined,
      height: d.height != null ? d.height * factor : undefined,
      depth: d.depth != null ? d.depth * factor : undefined,
      radius: d.radius != null ? d.radius * factor : undefined,
      radiusTop: d.radiusTop != null ? d.radiusTop * factor : undefined,
      radiusBottom: d.radiusBottom != null ? d.radiusBottom * factor : undefined,
    },
  };
}

/**
 * Rescale a freshly-built primitives group so its natural height matches
 * `targetHeight` — every asset in this app is otherwise on its own arbitrary
 * scale, so without this a primitives-fallback "mouse" and "desk" within the
 * same compound scene would render at whatever size the LLM happened to pick.
 */
function rescaleToTargetHeight(parts: Part[], targetHeight: number): Part[] {
  const naturalHeight = Math.max(0.01, ...parts.map(partTopY));
  const factor = targetHeight / naturalHeight;
  return parts.map((p) => scalePart(p, factor));
}

/** Resolve one component to either a real GLB or a quality primitives build. */
async function resolveComponent(
  component: CompoundComponent,
  signal: AbortSignal,
): Promise<Pick<WorkingComponent, "resolvedEntry" | "resolvedScale" | "resolvedParts">> {
  const result = await resolveAssetForPhrase(component.searchPhrase, [], DEFAULT_LIVE_BUDGET_MS);
  if (result.entry) {
    const rawScale = component.targetHeight / TARGET_HEIGHT;
    const resolvedScale = Math.min(MAX_PLACEMENT_SCALE, Math.max(MIN_PLACEMENT_SCALE, rawScale));
    return { resolvedEntry: result.entry, resolvedScale };
  }

  // No realistic model — fall back to a quality primitives build for this
  // one component (Task 3's dedicated prompt), same standard as a solo build,
  // then rescale it to the requested real-world height.
  try {
    const messages: LlmMessage[] = [
      { role: "system", content: buildPrimitivesFallbackPrompt(component.name) },
      { role: "user", content: `Build: ${component.name}` },
    ];
    const text = await callTutor(messages, signal);
    const parsed = JSON.parse(text);
    const validated = tutorResponseSchema.safeParse(parsed);
    if (validated.success && validated.data.parts.length > 0) {
      return { resolvedParts: rescaleToTargetHeight(validated.data.parts, component.targetHeight) };
    }
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") throw err;
    console.warn(`[compose-scene] primitives fallback failed for "${component.name}":`, err);
  }
  return {};
}

export async function POST(request: Request) {
  let body: ComposeSceneRequestBody;
  try {
    body = (await request.json()) as ComposeSceneRequestBody;
  } catch {
    return NextResponse.json<ComposeSceneResponse>(FAILED);
  }

  const phrase = (body?.phrase ?? "").trim();
  if (phrase === "") {
    return NextResponse.json<ComposeSceneResponse>(FAILED);
  }

  const signal = request.signal;

  let layout: { components: CompoundComponent[]; intro: string } | null;
  try {
    layout = await decompose(phrase, signal);
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") {
      return NextResponse.json<ComposeSceneResponse>(FAILED);
    }
    throw err;
  }
  if (!layout) {
    return NextResponse.json<ComposeSceneResponse>(FAILED);
  }

  const laidOut = layoutSanityPass(layout.components);

  // Resolve every component IN PARALLEL — the 10s live-fetch budget applies
  // per component but since they all run concurrently, wall-clock time stays
  // bounded by the slowest single one, not the sum.
  let resolutions: Pick<WorkingComponent, "resolvedEntry" | "resolvedScale" | "resolvedParts">[];
  try {
    resolutions = await Promise.all(laidOut.map((c) => resolveComponent(c, signal)));
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") {
      return NextResponse.json<ComposeSceneResponse>(FAILED);
    }
    throw err;
  }

  const working: WorkingComponent[] = laidOut.map((c, i) => ({
    ...c,
    worldX: 0,
    worldZ: 0,
    worldY: 0,
    ...resolutions[i],
  }));
  const byName = new Map(working.map((c) => [c.name, c]));

  // Two-pass world placement: floor items first (Y=0, X/Z from the grid),
  // then onSurface items (X/Z from the grid too — already snapped onto the
  // surface's slot by layoutSanityPass — with Y lifted to the surface's top).
  for (const c of working) {
    if (c.onSurface) continue;
    c.worldX = c.gridX * GRID_SPACING;
    c.worldZ = c.gridZ * GRID_SPACING;
    c.worldY = 0;
  }
  for (const c of working) {
    if (!c.onSurface) continue;
    const surface = byName.get(c.onSurface);
    if (!surface) {
      c.worldX = c.gridX * GRID_SPACING;
      c.worldZ = c.gridZ * GRID_SPACING;
      c.worldY = 0;
      continue;
    }
    // A GLB's mesh isn't necessarily centered on its own local origin (an
    // L-shaped desk, say), so "sit on the desk" means the desk's TRUE
    // bounding-box center, not just the point its own position was set to.
    // layoutSanityPass gave onSurface siblings a small gridX/gridZ jitter
    // around the surface's own slot — carry just that delta as the local
    // spread so multiple items on one surface don't stack exactly.
    let centerX = surface.worldX;
    let centerZ = surface.worldZ;
    if (surface.resolvedEntry) {
      const bb = surface.resolvedEntry.boundingBox;
      const s = surface.resolvedScale ?? 1;
      centerX += ((bb.min[0] + bb.max[0]) / 2) * s;
      centerZ += ((bb.min[2] + bb.max[2]) / 2) * s;
    }
    c.worldX = centerX + (c.gridX - surface.gridX) * GRID_SPACING;
    c.worldZ = centerZ + (c.gridZ - surface.gridZ) * GRID_SPACING;

    if (surface.resolvedEntry) {
      c.worldY = surface.worldY + surface.resolvedEntry.boundingBox.max[1] * (surface.resolvedScale ?? 1);
    } else if (surface.resolvedParts && surface.resolvedParts.length > 0) {
      c.worldY = surface.worldY + Math.max(0, ...surface.resolvedParts.map(partTopY));
    } else {
      c.worldY = surface.worldY + DEFAULT_SURFACE_HEIGHT;
    }
  }

  const baseAssets: PlacedAsset[] = [];
  const parts: Part[] = [];
  const concepts: string[] = [];

  for (const c of working) {
    if (c.resolvedEntry) {
      baseAssets.push({
        asset: toBaseAsset(c.resolvedEntry),
        position: [c.worldX, c.worldY, c.worldZ] as PlacedAsset["position"],
        scale: c.resolvedScale ?? 1,
      });
      concepts.push(...c.resolvedEntry.concepts);
    } else if (c.resolvedParts) {
      for (const part of c.resolvedParts) {
        parts.push({
          ...part,
          id: `${part.id}__${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
          position: [
            part.position[0] + c.worldX,
            part.position[1] + c.worldY,
            part.position[2] + c.worldZ,
          ] as Part["position"],
        });
      }
    }
    // A component that resolved to neither (every avenue failed) is simply
    // omitted — the rest of the scene still renders rather than failing the
    // whole compound build over one stubborn component.
  }

  if (baseAssets.length === 0 && parts.length === 0) {
    return NextResponse.json<ComposeSceneResponse>(FAILED);
  }

  const names = working.map((c) => c.name.toLowerCase());
  return NextResponse.json<ComposeSceneResponse>({
    status: "ok",
    baseAssets,
    parts,
    reply: layout.intro,
    followUpQuestion: `Want to add anything else to the ${phrase}, or dig into how one of these parts works?`,
    suggestedActions: [
      `Explain how the ${names[0] ?? "pieces"} works`,
      "Add something else",
      "Build something new",
    ],
    concepts: Array.from(new Set(concepts)),
  });
}
