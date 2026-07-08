import { NextResponse } from "next/server";
import {
  tutorResponseSchema,
  type ChatMessage,
  type Part,
  type TutorResponse,
} from "@/lib/schema";
import { buildSystemPrompt } from "@/lib/tutorPrompt";
import { callTutor, noteTutorOutcome, type LlmMessage } from "@/lib/llm";
import { getAsset, type AssetEntry } from "@/lib/assetManifest";
import { resolveAnchor } from "@/lib/anchorResolver";

/** Shape of the POST body sent by the client. */
interface TutorRequestBody {
  message: string;
  history: ChatMessage[];
  currentParts: Part[];
  /** Set when the scene's base is a realistic GLB, so we can inject its anchors. */
  baseAssetId?: string;
}

/** Returned when the model never yields schema-valid JSON — scene stays put. */
const FALLBACK: TutorResponse = {
  reasoning: "The model failed to return a valid manifest; emitting a safe no-op so the scene is preserved.",
  action: "explain",
  reply: "Hmm, I got a bit tangled up — can you try rephrasing that?",
  parts: [],
  removedPartIds: [],
  suggestedActions: [],
};

/**
 * Serialize the current scene so the (stateless) model knows what already
 * exists and can reuse ids AND reason about geometry. Includes position and
 * dimensions now — the spatial-reasoning protocol needs them to compute the
 * bounding box and attachment points.
 */
function describeScene(parts: Part[]): string {
  if (parts.length === 0) {
    return "The scene is currently EMPTY — nothing has been built yet.";
  }
  const summary = parts.map((p) => ({
    id: p.id,
    name: p.name,
    shape: p.shape,
    position: p.position,
    dimensions: p.dimensions,
  }));
  return `The scene currently contains these parts (reuse their exact ids when modifying them, and use their positions/dimensions to plan where new parts attach):\n${JSON.stringify(
    summary,
  )}`;
}

/**
 * Describe the realistic GLB base model to the (blind) tutor: its name, its
 * world-space bounding box, and the exact coordinates of every auto-anchor.
 * This is what lets "add a lamp room to the top" land on the real summit.
 */
function describeBaseAsset(asset: AssetEntry): string {
  const bb = asset.boundingBox;
  const anchors = Object.entries(asset.anchors)
    .map(([name, pos]) => `  - ${name}: [${pos.map((n) => n.toFixed(2)).join(", ")}]`)
    .join("\n");
  return `The scene's BASE is a realistic imported 3D MODEL of "${asset.name}" (not primitives). You cannot see it, so use these measurements. Bounding box: min [${bb.min
    .map((n) => n.toFixed(2))
    .join(", ")}], max [${bb.max
    .map((n) => n.toFixed(2))
    .join(", ")}], size [${bb.size
    .map((n) => n.toFixed(2))
    .join(
      ", ",
    )}]. Its lowest point rests on y=0. When you ADD parts to it, prefer "attachTo" with one of these named anchors:\n${anchors}`;
}

/**
 * Resolve every part's optional `attachTo` anchor into a concrete position using
 * the base model's anchor map (plus the part's local offset). Parts without
 * `attachTo`, or when there's no base asset, keep their given position.
 */
function resolveAttachments(
  response: TutorResponse,
  asset: AssetEntry | null,
): TutorResponse {
  if (!asset) return response;
  const parts = response.parts.map((part) => {
    if (!part.attachTo) return part;
    const { position } = resolveAnchor(asset.anchors, part.attachTo.anchor);
    const off = part.attachTo.offset ?? [0, 0, 0];
    return {
      ...part,
      position: [
        position[0] + off[0],
        position[1] + off[1],
        position[2] + off[2],
      ] as Part["position"],
    };
  });
  return { ...response, parts };
}

/** Map stored chat turns onto OpenAI-style roles (tutor -> assistant). */
function historyToMessages(history: ChatMessage[]): LlmMessage[] {
  return history.map((m) => ({
    role: m.role === "tutor" ? "assistant" : "user",
    content: m.content,
  }));
}

/** Parse + Zod-validate model text into a TutorResponse, or null if invalid. */
function validate(text: string | null): TutorResponse | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = tutorResponseSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Human-readable Zod error text for the retry prompt. */
function validationError(text: string | null): string {
  if (!text) return "You returned an empty response.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `Your response was not valid JSON: ${
      e instanceof Error ? e.message : String(e)
    }`;
  }
  const result = tutorResponseSchema.safeParse(parsed);
  return result.success
    ? ""
    : result.error.issues
        .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
}

/**
 * Estimate half the vertical extent of a part, so we can rest it on the ground
 * (center = halfHeight) when the model tries to bury it below Y=0.
 */
function halfHeight(part: Part): number {
  const d = part.dimensions;
  switch (part.shape) {
    case "sphere":
      return d.radius ?? 0.5;
    case "box":
      return (d.height ?? 1) / 2;
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

/** Axis-aligned bounding box of a set of parts (positions only, padded a bit). */
function sceneBBox(parts: Part[]): { center: [number, number, number]; diag: number } | null {
  if (parts.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p.position[i]);
      max[i] = Math.max(max[i], p.position[i]);
    }
  }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  const diag = Math.max(Math.hypot(dx, dy, dz), 1); // floor so tiny scenes don't over-flag
  return { center, diag };
}

/**
 * Cheap server-side sanity pass on a validated response:
 *  - Clamp any part sunk below the ground (y < -0.01) up to rest on Y=0.
 *  - Warn (don't block) about any NEW part that drifts more than 2x the scene
 *    bounding box from everything else, so we can debug spatial-reasoning misses.
 */
function sanityPass(response: TutorResponse, currentParts: Part[]): TutorResponse {
  const existingIds = new Set(currentParts.map((p) => p.id));

  // Reference bbox = the parts that already existed, if any, else the response's
  // own parts. Used only for the drift warning.
  const reference =
    currentParts.length > 0
      ? sceneBBox(currentParts)
      : sceneBBox(response.parts);

  const parts = response.parts.map((part) => {
    let position = part.position;

    if (position[1] < -0.01) {
      const y = halfHeight(part);
      console.warn(
        `[tutor] part "${part.id}" was below ground (y=${position[1]}); clamping to y=${y}`,
      );
      position = [position[0], y, position[2]];
    }

    // Drift warning for genuinely new parts only.
    if (reference && !existingIds.has(part.id)) {
      const dist = Math.hypot(
        position[0] - reference.center[0],
        position[1] - reference.center[1],
        position[2] - reference.center[2],
      );
      if (dist > 2 * reference.diag) {
        console.warn(
          `[tutor] new part "${part.id}" at [${position}] is ${dist.toFixed(
            1,
          )} units from the scene center (>2x bbox diag ${reference.diag.toFixed(
            1,
          )}) — possible spatial drift`,
        );
      }
    }

    return position === part.position ? part : { ...part, position };
  });

  return { ...response, parts };
}

export async function POST(request: Request) {
  let body: TutorRequestBody;
  try {
    body = (await request.json()) as TutorRequestBody;
  } catch {
    return NextResponse.json(FALLBACK);
  }

  const { message, history = [], currentParts = [], baseAssetId } = body;
  if (typeof message !== "string" || message.trim() === "") {
    return NextResponse.json(FALLBACK);
  }

  // If the scene is built on a realistic GLB, load it so we can describe its
  // anchors to the model and resolve anchor-based attachments afterwards.
  const baseAsset = baseAssetId ? getAsset(baseAssetId) : null;

  const systemPrompt = buildSystemPrompt();

  // Compose the scene context: the base model (if any) comes first, then the
  // primitive parts already added on top of it.
  const sceneContext = baseAsset
    ? `${describeBaseAsset(baseAsset)}\n\n${describeScene(currentParts)}`
    : describeScene(currentParts);

  // System + full conversation + a final user turn carrying the live scene
  // state and the new message. Everything travels each call (stateless model).
  const baseMessages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    ...historyToMessages(history),
    {
      role: "user",
      content: `${sceneContext}\n\nLearner: ${message}`,
    },
  ];

  try {
    // Attempt 1.
    let text = await callTutor(baseMessages);
    let validated = validate(text);
    if (validated) {
      noteTutorOutcome(true);
      return NextResponse.json(
        sanityPass(resolveAttachments(validated, baseAsset), currentParts),
      );
    }

    // Attempt 2: append the validation error and ask for corrected JSON.
    const errorDetail = validationError(text);
    const retryMessages: LlmMessage[] = [
      ...baseMessages,
      { role: "assistant", content: text },
      {
        role: "user",
        content: `Your previous response did not match the required schema:\n${errorDetail}\n\nReply again with ONLY corrected JSON matching the schema exactly — the "reasoning" field first, no markdown, no prose.`,
      },
    ];

    text = await callTutor(retryMessages);
    validated = validate(text);
    if (validated) {
      noteTutorOutcome(true);
      return NextResponse.json(
        sanityPass(resolveAttachments(validated, baseAsset), currentParts),
      );
    }

    // Valid transport, unusable content — count it and degrade gracefully.
    noteTutorOutcome(false);
    return NextResponse.json(FALLBACK);
  } catch (err) {
    // Both models failed (timeout / rate limit / network). Never crash.
    noteTutorOutcome(false);
    console.error("[tutor] request failed:", err);
    return NextResponse.json(FALLBACK);
  }
}
