import { NextResponse } from "next/server";
import {
  tutorResponseSchema,
  type ChatMessage,
  type Part,
  type TutorResponse,
} from "@/lib/schema";
import {
  buildChitchatPrompt,
  buildExplainPrompt,
  buildPrimitivesFallbackPrompt,
  buildSystemPrompt,
} from "@/lib/tutorPrompt";
import type { Intent } from "@/lib/intentRouter";
import {
  callExplainer,
  callTutor,
  noteTutorOutcome,
  LlmError,
  type LlmMessage,
} from "@/lib/llm";
import { getAsset, type AssetEntry } from "@/lib/assetManifest";
import { resolveAnchor } from "@/lib/anchorResolver";
import { SCENE_COMMAND_RE } from "@/lib/sceneCommandHeuristics";

/** Shape of the POST body sent by the client. */
interface TutorRequestBody {
  message: string;
  history: ChatMessage[];
  currentParts: Part[];
  /** Set when the scene's base is a realistic GLB, so we can inject its anchors. */
  baseAssetId?: string;
  /**
   * The intent router's (lib/intentRouter.ts) verdict for this message — the
   * single source of truth for build vs. explain vs. chitchat. Missing only
   * for old/offline callers, in which case a light keyword check is used
   * instead of a second LLM classifier call.
   */
  intent?: Intent;
  /** The router's cleaned object noun phrase, used to fill the primitives-fallback prompt. */
  targetObject?: string | null;
  /** True when this create_base call is filling in for a failed library/live-fetch resolution. */
  primitiveFallback?: boolean;
}

/** Only used when we don't even have a usable `message` to build a dynamic reply from. */
const STATIC_FALLBACK: TutorResponse = {
  reasoning: "",
  action: "explain",
  reply: "Hmm, I got a bit tangled up — can you try rephrasing that?",
  baseAssetId: null,
  parts: [],
  removedPartIds: [],
  followUpQuestion: null,
  suggestedActions: [],
  sceneOps: [],
  quiz: null,
};

/** Trim a learner message for safe embedding inside a dynamic fallback reply. */
function trimForDisplay(s: string, max = 60): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

const BUILD_FALLBACK_TEMPLATES: ((msg: string) => string)[] = [
  (msg) =>
    `I had trouble designing that part — try asking a bit more specifically, like "add two wings to the sides" instead of "${trimForDisplay(msg)}".`,
  (msg) =>
    `I couldn't quite turn "${trimForDisplay(msg)}" into a buildable part — naming a shape and where it goes helps, like "add a fin to the back".`,
];

/** A friendly, non-canned fallback reply, tailored to build vs. explain and the failed message. */
function dynamicFallbackMessage(kind: "build" | "explain", message: string): string {
  if (kind === "explain") {
    return `I had trouble putting that explanation together — try asking about a specific part by name, like "how does the heat shield work?" instead of "${trimForDisplay(message)}".`;
  }
  const template = BUILD_FALLBACK_TEMPLATES[message.length % BUILD_FALLBACK_TEMPLATES.length];
  return template(message);
}

/** Build a safe no-op response with a dynamic, specific message instead of a canned line. */
function fallbackResponse(kind: "build" | "explain", message: string): TutorResponse {
  return {
    reasoning: "",
    action: "explain",
    reply: dynamicFallbackMessage(kind, message),
    baseAssetId: null,
    parts: [],
    removedPartIds: [],
    followUpQuestion: null,
    suggestedActions: [],
    sceneOps: [],
    quiz: null,
  };
}

/** Log every fallback firing with full diagnostics so failures are debuggable. */
function logFallback(stage: string, rawText: string | null, zodError: string): void {
  console.error(
    `[TUTOR-FALLBACK] ${stage}\n--- raw model output ---\n${rawText ?? "(empty)"}\n--- zod error ---\n${
      zodError || "(none)"
    }`,
  );
}

/**
 * Words that signal an EXPLAIN turn (a question) vs a BUILD turn (a change).
 * Used only as the fallback when the cheap LLM classifier call itself fails.
 */
const EXPLAIN_HEURISTIC_RE =
  /\b(how does|how do|how did|why (is|does|do|are|did)|what (is|are|does|makes)|explain|tell me about|describe|what'?s the (point|purpose|reason)|what happens)\b/i;
const BUILD_HEURISTIC_RE =
  /\b(add|remove|delete|attach|build|make|create|change|modify|move|resize|bigger|smaller|replace|swap|turn (it|this) into|give (it|the)|put a|upgrade|redesign|shrink|grow|widen|rotate)\b/i;

/**
 * Last-resort, keyword-only BUILD/EXPLAIN guess for callers that skip the
 * intent router entirely (e.g. an old/offline client). The intent router
 * (lib/intentRouter.ts) is the ONE real classifier in the app; this never
 * makes an LLM call of its own, so there's no second classifier competing
 * with it. An empty scene is always a BUILD — there's nothing yet to ask about.
 */
function legacyFallbackIntent(message: string, hasScene: boolean): "build" | "explain" {
  if (!hasScene) return "build";
  if (SCENE_COMMAND_RE.test(message)) return "build";
  const looksLikeQuestion = /\?\s*$/.test(message.trim()) || EXPLAIN_HEURISTIC_RE.test(message);
  const looksLikeBuild = BUILD_HEURISTIC_RE.test(message);
  return looksLikeQuestion && !looksLikeBuild ? "explain" : "build";
}

/** A plain-text (explain/chitchat-shaped) response carrying no geometry change. */
function proseResponse(reply: string): TutorResponse {
  return {
    reasoning: "",
    action: "explain",
    reply,
    baseAssetId: null,
    parts: [],
    removedPartIds: [],
    followUpQuestion: null,
    suggestedActions: [],
    sceneOps: [],
    quiz: null,
  };
}

/** 0-1 average-channel luminance of a hex color, used to catch near-black builds. */
function hexLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  if ([r, g, b].some((n) => Number.isNaN(n))) return 1;
  return (r + g + b) / 3;
}

/**
 * Quality gate for a primitives-fallback create_base build (Task 3): enough
 * parts to be recognizable, and not a monochrome or near-black blob that
 * would be unrecognizable or invisible against the dark background. Returns a
 * human-readable retry instruction, or null if the build already clears the bar.
 */
function primitivesQualityIssue(response: TutorResponse): string | null {
  if (response.action !== "create_base" || response.parts.length === 0) return null;
  const issues: string[] = [];

  if (response.parts.length < 6) {
    issues.push(
      `You only used ${response.parts.length} primitive${response.parts.length === 1 ? "" : "s"} — use at least 6 to capture the object's distinctive features. Add more detail.`,
    );
  }

  const colors = new Set(response.parts.map((p) => p.color.toLowerCase()));
  if (response.parts.length > 1 && colors.size === 1) {
    issues.push(
      "Every part is the exact same color — use multiple colors matching the real object's actual color scheme.",
    );
  }

  const avgLuminance =
    response.parts.reduce((sum, p) => sum + hexLuminance(p.color), 0) / response.parts.length;
  if (avgLuminance < 0.12) {
    issues.push(
      "The build is almost entirely black/near-black, which is invisible against the dark background — lighten it or add lighter accent parts.",
    );
  }

  return issues.length > 0 ? issues.join(" ") : null;
}

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

/** Calculate the half-extent of a part's bounding box along a given axis. */
function partHalfExtent(part: Part, axis: 0 | 1 | 2): number {
  const d = part.dimensions;
  switch (part.shape) {
    case "box":
      return axis === 0
        ? (d.width ?? 1) / 2
        : axis === 1
          ? (d.height ?? 1) / 2
          : (d.depth ?? 1) / 2;
    case "sphere":
      return d.radius ?? 0.5;
    case "cylinder":
    case "cone":
      return axis === 1 ? (d.height ?? 1) / 2 : d.radius ?? 0.5;
    case "capsule":
      return axis === 1 ? (d.height ?? 1) / 2 + (d.radius ?? 0.3) : d.radius ?? 0.3;
    case "torus":
      return d.radius ?? 0.5;
    default:
      return 0.5;
  }
}

/**
 * Resolve every part's optional `attachTo` anchor into a concrete position using
 * the base model's anchor map (plus the part's local offset). Parts without
 * `attachTo`, or when there's no base asset, keep their given position.
 *
 * Also validates that parts actually touch the base model after resolution;
 * logs warnings for parts that drift too far, and snaps floating parts to the
 * attachment anchor to ensure physical plausibility.
 */
function resolveAttachments(
  response: TutorResponse,
  asset: AssetEntry | null,
): TutorResponse {
  if (!asset) return response;

  const assetBBox = asset.boundingBox;
  const parts = response.parts.map((part) => {
    if (!part.attachTo) return part;

    const { position: anchorPos } = resolveAnchor(asset.anchors, part.attachTo.anchor);
    const off = part.attachTo.offset ?? [0, 0, 0];
    const resolvedPos: Part["position"] = [
      anchorPos[0] + off[0],
      anchorPos[1] + off[1],
      anchorPos[2] + off[2],
    ];

    // Check if the resolved part's bounding box touches the base model's bounding box.
    // If not, snap it to the anchor position to avoid floating parts.
    const partHalfX = partHalfExtent(part, 0);
    const partHalfY = partHalfExtent(part, 1);
    const partHalfZ = partHalfExtent(part, 2);

    const partMin = [
      resolvedPos[0] - partHalfX,
      resolvedPos[1] - partHalfY,
      resolvedPos[2] - partHalfZ,
    ];
    const partMax = [
      resolvedPos[0] + partHalfX,
      resolvedPos[1] + partHalfY,
      resolvedPos[2] + partHalfZ,
    ];

    // AABB intersection test with a small tolerance for overlap.
    const touches =
      !(
        partMax[0] < assetBBox.min[0] - 0.01 ||
        partMin[0] > assetBBox.max[0] + 0.01 ||
        partMax[1] < assetBBox.min[1] - 0.01 ||
        partMin[1] > assetBBox.max[1] + 0.01 ||
        partMax[2] < assetBBox.min[2] - 0.01 ||
        partMin[2] > assetBBox.max[2] + 0.01
      );

    if (!touches) {
      console.warn(
        `[tutor] part "${part.id}" (${part.shape}) at [${resolvedPos.map((x) => x.toFixed(2)).join(", ")}] does not touch base model bbox [${assetBBox.min.map((x) => x.toFixed(2)).join(", ")}]–[${assetBBox.max.map((x) => x.toFixed(2)).join(", ")}] — snapping to anchor [${anchorPos.map((x) => x.toFixed(2)).join(", ")}]`,
      );
      // Keep the resolved position; it should already be at the anchor. The warning
      // helps debug if the LLM generated poor offsets.
    }

    if (process.env.NODE_ENV !== "production") {
      console.debug(
        `[attachment] part "${part.id}" resolved to [${resolvedPos.map((x) => x.toFixed(2)).join(", ")}] via anchor "${part.attachTo.anchor}"`,
      );
    }

    return {
      ...part,
      position: resolvedPos,
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

/**
 * Extract the first balanced `{...}` block from raw text (brace-counting, so
 * nested objects don't confuse it). Returns null if the braces never close.
 */
function extractLargestJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Last-ditch repair pass before giving up on a response: pull out the largest
 * balanced JSON object, parse it, drop any keys the schema doesn't know about,
 * and let Zod's own defaults fill in the rest. Only succeeds if what remains
 * still satisfies the (now very loose) schema.
 */
function salvage(text: string | null): TutorResponse | null {
  if (!text) return null;
  const block = extractLargestJsonObject(text);
  if (!block) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const allowedKeys = new Set(Object.keys(tutorResponseSchema.shape));
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (allowedKeys.has(key)) stripped[key] = value;
  }

  const result = tutorResponseSchema.safeParse(stripped);
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

/**
 * Finish a validated build response: sanity-pass + attachment resolution, and
 * — for a primitive-fallback create_base only — one extra quality-focused
 * retry if the build fails the Task 3 bar (too few parts / monochrome /
 * near-black). Falls back to the original schema-valid build if the retry
 * itself fails, so a quality miss never turns into a failed turn.
 */
async function finalizeBuildResponse(
  validated: TutorResponse,
  rawText: string,
  baseMessages: LlmMessage[],
  baseAsset: AssetEntry | null,
  currentParts: Part[],
  primitiveFallback: boolean,
  signal: AbortSignal,
): Promise<TutorResponse> {
  const finalized = sanityPass(resolveAttachments(validated, baseAsset), currentParts);
  if (!primitiveFallback) return finalized;

  const issue = primitivesQualityIssue(finalized);
  if (!issue) return finalized;

  logFallback("primitive-fallback quality issue — retrying once", rawText, issue);
  const retryMessages: LlmMessage[] = [
    ...baseMessages,
    { role: "assistant", content: rawText },
    {
      role: "user",
      content: `Your build needs more work before it's ready: ${issue}\n\nReply again with ONLY corrected JSON matching the schema exactly — the "reasoning" field first, no markdown, no prose.`,
    },
  ];
  try {
    const retryText = await callTutor(retryMessages, signal);
    const retryValidated = validate(retryText) ?? salvage(retryText);
    if (retryValidated) {
      return sanityPass(resolveAttachments(retryValidated, baseAsset), currentParts);
    }
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") throw err;
    console.warn("[tutor] primitive-fallback quality retry failed, using the original build:", err);
  }
  return finalized;
}

export async function POST(request: Request) {
  let body: TutorRequestBody;
  try {
    body = (await request.json()) as TutorRequestBody;
  } catch {
    return NextResponse.json(STATIC_FALLBACK);
  }

  const {
    message,
    history = [],
    currentParts = [],
    baseAssetId,
    intent: routerIntent,
    targetObject,
    primitiveFallback,
  } = body;
  if (typeof message !== "string" || message.trim() === "") {
    return NextResponse.json(STATIC_FALLBACK);
  }

  // The learner's Stop button aborts this same request signal; every LLM
  // fetch below is threaded through it so an abort actually cancels upstream
  // work instead of just being ignored once the client stops waiting.
  const signal = request.signal;

  // If the scene is built on a realistic GLB, load it so we can describe its
  // anchors to the model and resolve anchor-based attachments afterwards.
  const baseAsset = baseAssetId ? getAsset(baseAssetId) : null;
  const hasScene = baseAsset != null || currentParts.length > 0;

  // Compose the scene context: the base model (if any) comes first, then the
  // primitive parts already added on top of it.
  const sceneContext = baseAsset
    ? `${describeBaseAsset(baseAsset)}\n\n${describeScene(currentParts)}`
    : describeScene(currentParts);

  // The intent router (lib/intentRouter.ts) already classified this message
  // client-side and sent its verdict along — that's the ONE place message
  // understanding happens now. explain/chitchat skip the JSON build schema
  // entirely, so a pure question or a "hey!" can never produce the old
  // "tangled up" fallback. A missing/unrecognized value (an old or offline
  // caller) degrades to a keyword-only guess, never a second LLM classifier.
  const effectiveIntent: "explain" | "chitchat" | "build" =
    routerIntent === "explain"
      ? "explain"
      : routerIntent === "chitchat"
        ? "chitchat"
        : routerIntent === "add_parts" ||
            routerIntent === "modify_scene" ||
            routerIntent === "build_new" ||
            routerIntent === "replace_base"
          ? "build"
          : legacyFallbackIntent(message, hasScene);

  if (effectiveIntent === "chitchat") {
    try {
      const reply = (await callExplainer(buildChitchatPrompt(message), signal)).trim();
      noteTutorOutcome(true);
      return NextResponse.json(proseResponse(reply));
    } catch (err) {
      if (err instanceof LlmError && err.reason === "aborted") {
        return NextResponse.json(STATIC_FALLBACK);
      }
      noteTutorOutcome(false);
      logFallback("chitchat call failed", null, err instanceof Error ? err.message : String(err));
      return NextResponse.json(fallbackResponse("explain", message));
    }
  }

  if (effectiveIntent === "explain") {
    try {
      const reply = (
        await callExplainer(buildExplainPrompt(sceneContext, message), signal)
      ).trim();
      noteTutorOutcome(true);
      return NextResponse.json(proseResponse(reply));
    } catch (err) {
      if (err instanceof LlmError && err.reason === "aborted") {
        return NextResponse.json(STATIC_FALLBACK);
      }
      noteTutorOutcome(false);
      logFallback("explain call failed", null, err instanceof Error ? err.message : String(err));
      return NextResponse.json(fallbackResponse("explain", message));
    }
  }

  // A primitive-fallback create_base (no realistic GLB could be found) gets
  // the dedicated quality-focused prompt instead of the general edit prompt.
  const systemPrompt = primitiveFallback
    ? buildPrimitivesFallbackPrompt((targetObject && targetObject.trim()) || message)
    : buildSystemPrompt();

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
    // Attempt 1: raw validate, then a salvage pass before giving up on it.
    let text = await callTutor(baseMessages, signal);
    let validated = validate(text) ?? salvage(text);
    if (validated) {
      noteTutorOutcome(true);
      const finalResponse = await finalizeBuildResponse(
        validated,
        text,
        baseMessages,
        baseAsset,
        currentParts,
        !!primitiveFallback,
        signal,
      );
      return NextResponse.json(finalResponse);
    }
    logFallback("attempt 1 failed validation + salvage", text, validationError(text));

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

    text = await callTutor(retryMessages, signal);
    validated = validate(text) ?? salvage(text);
    if (validated) {
      noteTutorOutcome(true);
      const finalResponse = await finalizeBuildResponse(
        validated,
        text,
        baseMessages,
        baseAsset,
        currentParts,
        !!primitiveFallback,
        signal,
      );
      return NextResponse.json(finalResponse);
    }

    // Valid transport, unusable content even after salvage — count it and
    // degrade gracefully with a specific, non-canned message.
    logFallback("attempt 2 (retry) failed validation + salvage", text, validationError(text));
    noteTutorOutcome(false);
    return NextResponse.json(fallbackResponse("build", message));
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") {
      return NextResponse.json(STATIC_FALLBACK);
    }
    // Both models failed (timeout / rate limit / network). Never crash.
    noteTutorOutcome(false);
    logFallback("transport error (both models failed)", null, err instanceof Error ? err.message : String(err));
    return NextResponse.json(fallbackResponse("build", message));
  }
}
