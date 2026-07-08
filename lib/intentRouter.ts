/**
 * THE INTENT ROUTER (SERVER-ONLY) — single entry point for understanding a
 * learner's chat message.
 *
 * Every message passes through `classifyMessage` FIRST, before anything else
 * decides whether to search Poly Pizza, call the tutor's JSON build path, or
 * just answer a question. One cheap explainer-model call classifies the
 * message (given a little conversation context) into exactly one intent, plus
 * a cleaned `targetObject` noun phrase for build/replace intents. A keyword
 * heuristic takes over if the LLM call itself fails, so this function never
 * throws and always returns something routable.
 */
import { z } from "zod";
import { callExplainer, LlmError } from "./llm";
import { extractJsonObject } from "./jsonExtract";
import { extractNoun } from "./nounExtractor";
import { SCENE_COMMAND_RE } from "./sceneCommandHeuristics";
import type { ChatMessage } from "./schema";

export const intentEnum = z.enum([
  "build_new",
  "replace_base",
  "add_parts",
  "modify_scene",
  "explain",
  "chitchat",
]);
export type Intent = z.infer<typeof intentEnum>;

export const intentResultSchema = z.object({
  intent: intentEnum,
  /** Clean object noun phrase, only meaningful for build_new/replace_base. */
  targetObject: z.string().nullable().optional(),
  /** build_new only: is this multiple distinct objects ("gaming setup")? */
  isCompound: z.boolean().optional().default(false),
});
export type IntentResult = z.infer<typeof intentResultSchema>;

export interface IntentContext {
  /** The last couple of chat turns, oldest first — just enough for pronoun/rejection context. */
  recentHistory: ChatMessage[];
  /** Name of the currently-loaded base model/build topic, if any. */
  baseAssetName: string | null;
}

const FEW_SHOTS = `
Example 1
Context: base model loaded = "Mousepad"
Message: "this is not a mousepad, make a mousepad"
{"intent":"replace_base","targetObject":"mousepad","isCompound":false}

Example 2
Context: base model loaded = "Exercise Bike"
Message: "no not this, a real bike"
{"intent":"replace_base","targetObject":"bike","isCompound":false}

Example 3
Context: base model loaded = "Rocket"
Message: "make it smaller"
{"intent":"modify_scene","targetObject":null,"isCompound":false}

Example 4
Context: base model loaded = "Rocket"
Message: "how does the heat shield work"
{"intent":"explain","targetObject":null,"isCompound":false}

Example 5
Context: no base model loaded
Message: "build me a gaming setup"
{"intent":"build_new","targetObject":"gaming setup","isCompound":true}

Example 6
Context: base model loaded = "Bicycle"
Message: "add a bigger thruster"
{"intent":"add_parts","targetObject":null,"isCompound":false}

Example 7
Context: no base model loaded
Message: "build me a rocket"
{"intent":"build_new","targetObject":"rocket","isCompound":false}

Example 8
Context: base model loaded = "Volcano"
Message: "hey, how's it going?"
{"intent":"chitchat","targetObject":null,"isCompound":false}
`.trim();

function describeContext(ctx: IntentContext): string {
  const base = ctx.baseAssetName ? `base model loaded = "${ctx.baseAssetName}"` : "no base model loaded";
  const history = ctx.recentHistory
    .slice(-2)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
  return history ? `${base}\nRecent turns:\n${history}` : base;
}

function buildPrompt(message: string, ctx: IntentContext): string {
  return `You are the intent classifier for BuildLab, a 3D-model tutoring app. Classify the learner's message into EXACTLY ONE intent:

- "build_new": they want to build a brand-new object (the scene is empty, or they're starting a completely different topic from what's loaded).
- "replace_base": they're REJECTING the current base model and want a different, better match for the SAME concept ("this is not X, make X", "no, a real Y", "wrong one", "that's not right").
- "add_parts": they want to add/attach something new to the existing scene without replacing it.
- "modify_scene": they want to adjust the CURRENT scene's view or style — resize, recolor, brighten, reset the camera — not add new geometry.
- "explain": they're asking a question about something that already exists, with no requested change.
- "chitchat": small talk, greetings, thanks, or anything that isn't a build action or a real question.

Also extract "targetObject": the clean object noun phrase (e.g. "mousepad", "bike", "gaming setup") — ONLY for build_new and replace_base, and NEVER the raw sentence. Use null for every other intent.

Also set "isCompound": true only for build_new requests that describe MULTIPLE distinct objects together (e.g. "gaming setup", "solar system", "kitchen"), never for a single object. Always false for every other intent.

${FEW_SHOTS}

Now classify this one:
Context: ${describeContext(ctx)}
Message: ${JSON.stringify(message)}

Reply with ONLY a single-line JSON object: {"intent": "...", "targetObject": "..." or null, "isCompound": true or false}. No markdown, no explanation.`;
}

/** Words that signal an EXPLAIN turn (a question) — mirrors the old per-route heuristic. */
const EXPLAIN_HEURISTIC_RE =
  /\b(how does|how do|how did|why (is|does|do|are|did)|what (is|are|does|makes)|explain|tell me about|describe|what'?s the (point|purpose|reason)|what happens)\b/i;
/** Words that signal a BUILD-ish action (add/change something). */
const BUILD_HEURISTIC_RE =
  /\b(add|remove|delete|attach|build|make|create|change|modify|move|resize|bigger|smaller|replace|swap|turn (it|this) into|give (it|the)|put a|upgrade|redesign|shrink|grow|widen|rotate)\b/i;
/** Words that signal a fresh build request rather than an edit/question. */
const CREATE_RE =
  /\b(build|make|create|design|construct|model|show me|give me|generate|render|i want|i'?d like)\b/i;
/** The learner is rejecting the CURRENT base model, not asking for an edit. */
const REJECT_RE =
  /\b(not this|not that|wrong (one|model|thing)|a real |an actual |that'?s not (it|right)|no,? i (wanted|meant)|try (a different|another)|different (one|model))\b/i;
/** Pure small talk with no build/question content. */
const CHITCHAT_RE =
  /^(hi|hello|hey|yo|sup|thanks|thank you|thx|cool|nice|awesome|lol|ok|okay|great|got it)[.!?\s]*$/i;
/** Compound/multi-object build requests. */
const COMPOUND_RE = /\b(setup|scene|room|system|kit|station|environment)\b/i;

/**
 * Never-throws keyword fallback used only when the classifier LLM call itself
 * fails (timeout, rate limit, every model down). Mirrors the same signals the
 * client and tutor route used to check independently, now consolidated here.
 */
function heuristicClassify(message: string, ctx: IntentContext): IntentResult {
  const trimmed = message.trim();
  const hasScene = ctx.baseAssetName != null || ctx.recentHistory.length > 0;

  if (ctx.baseAssetName && REJECT_RE.test(trimmed)) {
    return { intent: "replace_base", targetObject: ctx.baseAssetName.toLowerCase(), isCompound: false };
  }
  if (hasScene && SCENE_COMMAND_RE.test(trimmed)) {
    return { intent: "modify_scene", targetObject: null, isCompound: false };
  }
  if (CHITCHAT_RE.test(trimmed)) {
    return { intent: "chitchat", targetObject: null, isCompound: false };
  }
  const looksLikeQuestion = /\?\s*$/.test(trimmed) || EXPLAIN_HEURISTIC_RE.test(trimmed);
  const looksLikeBuildVerb = BUILD_HEURISTIC_RE.test(trimmed);
  // A question only counts as EXPLAIN once something exists to ask about —
  // an empty scene is always a build, there's nothing yet to explain.
  if (hasScene && looksLikeQuestion && !looksLikeBuildVerb) {
    return { intent: "explain", targetObject: null, isCompound: false };
  }

  const looksLikeCreate = CREATE_RE.test(trimmed) || (!hasScene && !looksLikeQuestion);
  if (looksLikeCreate || !hasScene) {
    const noun = extractNoun(trimmed) || trimmed;
    return {
      intent: "build_new",
      targetObject: noun,
      isCompound: COMPOUND_RE.test(trimmed),
    };
  }

  return { intent: "add_parts", targetObject: null, isCompound: false };
}

/**
 * Classify one learner message. Tries a single cheap explainer-model call
 * first; on ANY failure (network, bad JSON, schema mismatch) falls back to
 * `heuristicClassify`, which never throws. Callers can trust this function to
 * always resolve with a usable `IntentResult`.
 */
export async function classifyMessage(
  message: string,
  ctx: IntentContext,
  signal?: AbortSignal,
): Promise<IntentResult> {
  try {
    const raw = await callExplainer(buildPrompt(message, ctx), signal);
    const block = extractJsonObject(raw);
    if (!block) throw new Error("no JSON object in classifier output");
    const parsed = JSON.parse(block);
    const result = intentResultSchema.safeParse(parsed);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") throw err;
    console.warn("[intentRouter] classifier call failed, using keyword heuristic:", err);
    return heuristicClassify(message, ctx);
  }
}
