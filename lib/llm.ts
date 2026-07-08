/**
 * LLM provider abstraction — a single, model-swappable brain for BuildLab.
 *
 * Talks the OpenAI-compatible `/chat/completions` protocol (NVIDIA NIM by
 * default), so switching models is just an env change. Handles the messy parts
 * that reasoning models throw at us: <think> tags, markdown fences, timeouts,
 * rate limits, and a fallback model so a flaky primary never kills the demo.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Why a call failed, surfaced to the caller instead of hanging. */
export type LlmErrorReason =
  | "timeout"
  | "rate_limit"
  | "http_error"
  | "network"
  | "empty";

/** Typed error thrown when a request can't be satisfied by any model. */
export class LlmError extends Error {
  reason: LlmErrorReason;
  constructor(reason: LlmErrorReason, message: string) {
    super(message);
    this.name = "LlmError";
    this.reason = reason;
  }
}

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = "deepseek-ai/deepseek-r1";
/** Demo insurance: if the primary model can't deliver, we swing to this one. */
const FALLBACK_MODEL = "mistralai/mistral-nemotron";

// A demo can't hang for a minute, so the primary call gets a tight 25s leash.
// The fallback chain (and the auto-switch below) makes that safe.
const TIMEOUT_MS = 25_000;
const RATE_LIMIT_BACKOFF_MS = 3_000;

/**
 * Self-healing model selection.
 *
 * The tutor route reports each turn's outcome via `noteTutorOutcome`. After
 * `FAILURE_SWITCH_THRESHOLD` consecutive failures (timeout / unparseable / both
 * models down) we permanently promote the sturdier FALLBACK_MODEL to be the
 * ACTIVE model for the rest of this server process — no human swapping required.
 * Any success resets the counter. `LLM_FORCE_MODEL`, when set, pins one model
 * and disables all of this (for deterministic testing).
 */
const FAILURE_SWITCH_THRESHOLD = 2;
let consecutiveFailures = 0;
/** Non-null once we've auto-promoted the fallback to be the active model. */
let activeModelOverride: string | null = null;

/** An env override that pins exactly one model and disables auto-switching. */
function forcedModel(): string | null {
  const forced = (process.env.LLM_FORCE_MODEL || "").trim();
  return forced === "" ? null : forced;
}

function baseUrl(): string {
  return process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
}

/** The env-configured primary model, before any runtime auto-switch. */
function configuredModel(): string {
  return process.env.LLM_MODEL || DEFAULT_MODEL;
}

/**
 * The model actually in service right now: a forced pin wins; otherwise a
 * runtime auto-switch wins; otherwise the env-configured primary.
 */
export function getActiveModel(): string {
  return forcedModel() ?? activeModelOverride ?? configuredModel();
}

/**
 * Record a tutor-route outcome so the module can heal itself. `ok=false` counts
 * a failure (timeout or unparseable) and, on the 2nd in a row, flips the active
 * model to the fallback for the rest of the session. `ok=true` resets the count.
 * No-op while a model is force-pinned.
 */
export function noteTutorOutcome(ok: boolean): void {
  if (forcedModel()) return; // pinned — never auto-switch.

  if (ok) {
    if (consecutiveFailures > 0) {
      console.log(`[llm] tutor recovered — resetting failure counter (was ${consecutiveFailures})`);
    }
    consecutiveFailures = 0;
    return;
  }

  consecutiveFailures += 1;
  console.warn(`[llm] tutor failure #${consecutiveFailures} (threshold ${FAILURE_SWITCH_THRESHOLD})`);

  if (
    activeModelOverride === null &&
    consecutiveFailures >= FAILURE_SWITCH_THRESHOLD &&
    configuredModel() !== FALLBACK_MODEL
  ) {
    activeModelOverride = FALLBACK_MODEL;
    console.warn(
      `[llm] ${consecutiveFailures} consecutive failures — auto-switching ACTIVE model ` +
        `from "${configuredModel()}" to "${FALLBACK_MODEL}" for the rest of this server session`,
    );
  }
}

/** Short, human-friendly label for the ACTIVE model (for the UI badge). */
export function getModelLabel(): string {
  const full = getActiveModel();
  // Drop the vendor prefix: "deepseek-ai/deepseek-r1" -> "deepseek-r1".
  return full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Strip reasoning-model cruft, leaving (ideally) just the JSON object.
 *  1. Remove chain-of-thought: everything up to and including the last
 *     `</think>`. If a `<think>` opened but never closed, jump to the first
 *     `{` instead. 2. Peel off ```json fences. 3. Isolate the outermost
 *     `{ ... }` so stray prose on either side can't break JSON.parse.
 */
export function cleanModelText(raw: string): string {
  let text = raw;

  const lastClose = text.lastIndexOf("</think>");
  if (lastClose !== -1) {
    text = text.slice(lastClose + "</think>".length);
  } else if (text.includes("<think>")) {
    const brace = text.indexOf("{");
    if (brace !== -1) text = text.slice(brace);
  }

  text = text.trim();

  // Remove a leading ```json / ``` fence and a trailing ``` fence.
  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Isolate the JSON object if the model wrapped it in prose. Our contract is
  // always a single object, so first "{" to last "}" is safe.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    text = text.slice(first, last + 1);
  }

  return text.trim();
}

/**
 * One raw round-trip to a specific model. Enforces the timeout via
 * AbortController and maps transport failures onto typed LlmErrors.
 */
async function callModelOnce(
  model: string,
  messages: LlmMessage[],
): Promise<string> {
  const apiKey = process.env.LLM_API_KEY || "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        // R1 is happiest around 0.6; low enough for reliable structure.
        temperature: 0.6,
        top_p: 0.9,
        // Reasoning models emit a lot of hidden tokens before the JSON.
        max_tokens: 8000,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LlmError("timeout", `${model} timed out after ${TIMEOUT_MS}ms`);
    }
    throw new LlmError(
      "network",
      `Network error calling ${model}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new LlmError("rate_limit", `${model} rate limited (429)`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LlmError(
      "http_error",
      `${model} HTTP ${res.status}: ${detail.slice(0, 300)}`,
    );
  }

  const payload = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = payload?.choices?.[0]?.message?.content;
  if (!content || content.trim() === "") {
    throw new LlmError("empty", `${model} returned an empty message`);
  }
  return content;
}

/**
 * Call a model with a single automatic retry on rate limiting (wait 3s, try
 * once more). Any other failure propagates immediately.
 */
async function callModelWithRetry(
  model: string,
  messages: LlmMessage[],
): Promise<string> {
  try {
    return await callModelOnce(model, messages);
  } catch (err) {
    if (err instanceof LlmError && err.reason === "rate_limit") {
      console.warn(
        `[llm] ${model} rate limited — backing off ${RATE_LIMIT_BACKOFF_MS}ms and retrying once`,
      );
      await sleep(RATE_LIMIT_BACKOFF_MS);
      return await callModelOnce(model, messages);
    }
    throw err;
  }
}

/** Run one model, clean its output, and ensure something JSON-ish came back. */
async function serve(model: string, messages: LlmMessage[]): Promise<string> {
  const raw = await callModelWithRetry(model, messages);
  const cleaned = cleanModelText(raw);
  if (!cleaned || !cleaned.includes("{")) {
    throw new LlmError("empty", `${model} produced no JSON object`);
  }
  return cleaned;
}

/**
 * Strip only chain-of-thought (`<think>…</think>`) and surrounding whitespace,
 * leaving PROSE intact — unlike `cleanModelText`, this does not try to isolate a
 * JSON object. Used for free-text generations like asset intros.
 */
function cleanProse(raw: string): string {
  let text = raw;
  const lastClose = text.lastIndexOf("</think>");
  if (lastClose !== -1) text = text.slice(lastClose + "</think>".length);
  return text.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * One-shot prose completion (no JSON). Returns plain text with reasoning cruft
 * stripped. Tries the primary model, then the fallback. Used to pre-generate
 * teacherly asset intros at fetch time so they're free at runtime.
 */
export async function generateText(prompt: string): Promise<string> {
  const messages: LlmMessage[] = [{ role: "user", content: prompt }];
  const forced = forcedModel();
  const models = (forced ? [forced] : [getActiveModel(), FALLBACK_MODEL]).filter(
    (m, i, a) => a.indexOf(m) === i,
  );
  let lastErr: unknown;
  for (const model of models) {
    try {
      const raw = await callModelWithRetry(model, messages);
      const prose = cleanProse(raw);
      if (prose) return prose;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new LlmError("empty", "no prose produced");
}

/**
 * Ask the tutor. Returns the cleaned model text (expected to be a JSON manifest
 * — the caller validates it). Tries the configured primary model first; if that
 * fails for any reason, falls back once to a sturdier model so the demo lives.
 * Throws a typed LlmError only if BOTH models fail.
 */
export async function callTutor(messages: LlmMessage[]): Promise<string> {
  const primary = getActiveModel();

  // Force-pinned: use exactly one model, no fallback — deterministic for tests.
  const forced = forcedModel();
  if (forced) {
    const text = await serve(forced, messages);
    console.log(`[llm] served by ${forced} (forced)`);
    return text;
  }

  try {
    const text = await serve(primary, messages);
    console.log(`[llm] served by ${primary}`);
    return text;
  } catch (primaryErr) {
    const reason =
      primaryErr instanceof LlmError ? primaryErr.reason : "network";
    console.warn(
      `[llm] primary model ${primary} failed (${reason}): ${
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
      }`,
    );

    // No point retrying the exact same model against itself.
    if (FALLBACK_MODEL === primary) {
      throw primaryErr instanceof LlmError
        ? primaryErr
        : new LlmError("network", String(primaryErr));
    }

    try {
      const text = await serve(FALLBACK_MODEL, messages);
      console.log(`[llm] served by ${FALLBACK_MODEL} (fallback)`);
      return text;
    } catch (fallbackErr) {
      console.error(
        `[llm] fallback model ${FALLBACK_MODEL} also failed: ${
          fallbackErr instanceof Error
            ? fallbackErr.message
            : String(fallbackErr)
        }`,
      );
      throw fallbackErr instanceof LlmError
        ? fallbackErr
        : new LlmError("network", String(fallbackErr));
    }
  }
}
