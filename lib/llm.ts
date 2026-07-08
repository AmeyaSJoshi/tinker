/**
 * LLM provider abstraction — a single, model-swappable brain for BuildLab.
 *
 * Talks the OpenAI-compatible `/chat/completions` protocol (NVIDIA NIM by
 * default), so switching models is just an env change. Handles the messy parts
 * that reasoning models throw at us: <think> tags, markdown fences, timeouts,
 * rate limits, and a fallback CHAIN so a flaky (or dead) primary never kills
 * the demo.
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
  | "model_unavailable"
  | "network"
  | "empty"
  /** The CALLER cancelled (e.g. the learner hit Stop) — never a model fault. */
  | "aborted";

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
const DEFAULT_MODEL = "mistralai/mistral-nemotron";

/**
 * Other NVIDIA Build free-tier models to fall back to, in order, if the
 * primary fails. Confirmed live by hand against this app's exact endpoint —
 * don't add a model here without checking it actually responds; NVIDIA
 * rotates/retires free endpoints without notice.
 *
 * `deepseek-ai/deepseek-r1` and `qwen/qwen3-coder-480b-a35b-instruct` used to
 * be the default/fallback here. Both now return a permanent "model not
 * found"-style error (404, and 410 "reached end of life") from NVIDIA Build's
 * free tier, so they've been removed entirely from the default request path
 * — every call to them was a guaranteed, wasted round trip.
 */
const FALLBACK_MODELS = ["meta/llama-3.1-8b-instruct", "meta/llama-3.1-70b-instruct"];

// A demo can't hang for a minute, so each model gets a tight 25s leash. The
// fallback chain (and the auto-switch below) makes that safe.
const TIMEOUT_MS = 25_000;
const RATE_LIMIT_BACKOFF_MS = 3_000;

/**
 * Models confirmed THIS SERVER SESSION to be permanently unavailable (a 404 or
 * 410 from the provider — "this model id does not exist / was retired", as
 * opposed to a transient timeout, rate limit, or temporary "degraded" state).
 * Once a model lands here every subsequent call skips it immediately instead
 * of wasting a timeout on a guaranteed-dead endpoint. Session-scoped only
 * (resets on server restart) since NVIDIA could restore a model later.
 */
const deadModels = new Set<string>();

function isDeadModel(model: string): boolean {
  return deadModels.has(model);
}

/** Permanently blocklist a model for the rest of this process, with a clear log line. */
function markModelDead(model: string, detail: string): void {
  if (deadModels.has(model)) return;
  deadModels.add(model);
  console.error(
    `[llm] "${model}" is permanently unavailable (${detail}) — skipping it for every request for the rest of this server session`,
  );
}

/**
 * Self-healing model selection.
 *
 * The tutor route reports each turn's outcome via `noteTutorOutcome`. After
 * `FAILURE_SWITCH_THRESHOLD` consecutive failures (timeout / unparseable / all
 * models down) we permanently promote the next healthy fallback to be the
 * ACTIVE model for the rest of this server process — no human swapping required.
 * Any success resets the counter. `LLM_FORCE_MODEL`, when set, pins one model
 * and disables all of this (for deterministic testing).
 */
const FAILURE_SWITCH_THRESHOLD = 2;
let consecutiveFailures = 0;
/** Non-null once we've auto-promoted a fallback to be the active model. */
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
 * model to the next healthy fallback for the rest of the session. `ok=true`
 * resets the count. No-op while a model is force-pinned.
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

  if (activeModelOverride !== null || consecutiveFailures < FAILURE_SWITCH_THRESHOLD) return;

  const current = configuredModel();
  const nextBest = FALLBACK_MODELS.find((m) => m !== current && !isDeadModel(m));
  if (nextBest) {
    activeModelOverride = nextBest;
    console.warn(
      `[llm] ${consecutiveFailures} consecutive failures — auto-switching ACTIVE model ` +
        `from "${current}" to "${nextBest}" for the rest of this server session`,
    );
  } else {
    console.warn(
      `[llm] ${consecutiveFailures} consecutive failures but no healthy fallback model is available to switch to`,
    );
  }
}

/** Short, human-friendly label for the ACTIVE model (for the UI badge). */
export function getModelLabel(): string {
  const full = getActiveModel();
  // Drop the vendor prefix: "mistralai/mistral-nemotron" -> "mistral-nemotron".
  return full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full;
}

/**
 * Build the ordered list of models to try for one call: the active model
 * first, then the fallback chain, deduplicated. Dead models (confirmed
 * 404/410 this session) are skipped — UNLESS every candidate is dead, in
 * which case we still try them all anyway; better to attempt and get a fresh
 * answer than refuse outright in case the provider recovered.
 */
function candidateModels(): string[] {
  const forced = forcedModel();
  if (forced) return [forced];

  const all = [getActiveModel(), ...FALLBACK_MODELS].filter((m, i, a) => a.indexOf(m) === i);
  const alive = all.filter((m) => !isDeadModel(m));
  return alive.length > 0 ? alive : all;
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
 * AbortController and maps transport failures onto typed LlmErrors. An
 * optional `externalSignal` (the caller's own AbortSignal, e.g. a learner
 * hitting Stop) aborts the SAME underlying fetch so upstream work actually
 * stops instead of just being ignored client-side.
 */
async function callModelOnce(
  model: string,
  messages: LlmMessage[],
  externalSignal?: AbortSignal,
): Promise<string> {
  const apiKey = process.env.LLM_API_KEY || "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort);
  }

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
        // Low enough for reliable JSON structure, warm enough for varied prose.
        temperature: 0.6,
        top_p: 0.9,
        // Generous ceiling: a reasoning model (if ever configured) emits a lot
        // of hidden <think> tokens before its actual answer.
        max_tokens: 8000,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw new LlmError("aborted", `${model} call aborted by caller`);
      }
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
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }

  if (res.status === 429) {
    throw new LlmError("rate_limit", `${model} rate limited (429)`);
  }
  // 404 = no such model id; 410 = the provider retired it ("end of life").
  // Both mean this model id will NEVER work again this session, unlike a
  // transient timeout/rate-limit/500 — the caller marks it dead so every
  // later request skips it instead of wasting another timeout on it.
  if (res.status === 404 || res.status === 410) {
    const detail = await res.text().catch(() => "");
    throw new LlmError(
      "model_unavailable",
      `${model} HTTP ${res.status} (model not found/retired): ${detail.slice(0, 300)}`,
    );
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
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await callModelOnce(model, messages, signal);
  } catch (err) {
    if (err instanceof LlmError && err.reason === "rate_limit") {
      console.warn(
        `[llm] ${model} rate limited — backing off ${RATE_LIMIT_BACKOFF_MS}ms and retrying once`,
      );
      await sleep(RATE_LIMIT_BACKOFF_MS);
      return await callModelOnce(model, messages, signal);
    }
    throw err;
  }
}

/** Run one model, clean its output, and ensure something JSON-ish came back. */
async function serve(
  model: string,
  messages: LlmMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const raw = await callModelWithRetry(model, messages, signal);
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
 * Try each candidate model in order with `run`, stopping at the first
 * success. Logs which model is attempted, why each failure happened, and
 * which model is tried next — and permanently blocklists any model confirmed
 * unavailable (404/410) so every later call skips it immediately instead of
 * wasting another timeout on a guaranteed-dead endpoint. Throws the last
 * error if every candidate fails.
 */
async function attemptChain<T>(
  label: string,
  candidates: string[],
  run: (model: string) => Promise<T>,
): Promise<T> {
  const forced = candidates.length === 1 && candidates[0] === forcedModel();
  let lastErr: unknown;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    console.log(
      `[llm] ${label}: attempting "${model}"${forced ? " (forced, no fallback chain)" : i === 0 ? "" : " (fallback)"}`,
    );
    try {
      const result = await run(model);
      console.log(`[llm] ${label}: served by "${model}"`);
      return result;
    } catch (err) {
      const reason = err instanceof LlmError ? err.reason : "network";
      const message = err instanceof Error ? err.message : String(err);
      lastErr = err;

      // The caller cancelled — every remaining candidate would abort
      // identically, so stop immediately instead of burning the fallback chain.
      if (reason === "aborted") {
        console.log(`[llm] ${label}: aborted by caller — not trying fallbacks`);
        throw err;
      }

      if (reason === "model_unavailable") {
        markModelDead(model, message);
      }

      const next = candidates[i + 1];
      console.warn(
        `[llm] ${label}: "${model}" failed (${reason}): ${message}` +
          (next
            ? ` — trying next candidate: "${next}"`
            : " — no more fallback candidates, giving up"),
      );
    }
  }

  throw lastErr instanceof LlmError
    ? lastErr
    : new LlmError("network", lastErr instanceof Error ? lastErr.message : String(lastErr));
}

/**
 * One-shot prose completion (no JSON). Returns plain text with reasoning cruft
 * stripped. Tries the active model, then the fallback chain in order. Used to
 * pre-generate teacherly asset intros at fetch time so they're free at runtime.
 */
export async function generateText(prompt: string, signal?: AbortSignal): Promise<string> {
  const messages: LlmMessage[] = [{ role: "user", content: prompt }];
  return attemptChain("generateText", candidateModels(), async (model) => {
    const raw = await callModelWithRetry(model, messages, signal);
    const prose = cleanProse(raw);
    if (!prose) throw new LlmError("empty", `${model} produced no prose`);
    return prose;
  });
}

/**
 * Ask the tutor. Returns the cleaned model text (expected to be a JSON manifest
 * — the caller validates it). Tries the active model first, then the fallback
 * chain in order. Throws a typed LlmError only if every candidate fails. An
 * optional `signal` (the route's request signal) cancels the in-flight call
 * when the learner hits Stop.
 */
export async function callTutor(
  messages: LlmMessage[],
  signal?: AbortSignal,
): Promise<string> {
  return attemptChain("callTutor", candidateModels(), (model) =>
    serve(model, messages, signal),
  );
}

/**
 * Dedicated, swappable model for fast, plain-text explanations (a clicked GLB
 * component, or a standalone "how does X work" question) — separate from the
 * main tutor model so a quick popup isn't paying for the tutor's heavier JSON
 * generation. Defaults to the same NIM account/base URL as the main client;
 * override independently via EXPLAIN_LLM_* if a different provider/key is needed.
 */
const EXPLAIN_DEFAULT_MODEL = "minimaxai/minimax-m2.7";

function explainerBaseUrl(): string {
  return process.env.EXPLAIN_LLM_BASE_URL || baseUrl();
}

function explainerModel(): string {
  return process.env.EXPLAIN_LLM_MODEL || EXPLAIN_DEFAULT_MODEL;
}

function explainerApiKey(): string {
  // Same NIM account can usually call multiple models with one key; only set
  // EXPLAIN_LLM_API_KEY if the explainer genuinely lives on a separate account.
  return process.env.EXPLAIN_LLM_API_KEY || process.env.LLM_API_KEY || "";
}

/** Short label for the UI badge, e.g. "minimax-m2.7". */
export function getExplainerModelLabel(): string {
  const full = explainerModel();
  return full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full;
}

/**
 * MiniMax's recommended `top_k` sampling param isn't part of the OpenAI schema
 * every provider accepts. Learned once per server session: if the endpoint
 * rejects it, every later explainer call skips it instead of re-discovering
 * the same rejection on every request.
 */
let explainerTopKUnsupported = false;

async function callExplainerModelOnce(
  messages: LlmMessage[],
  signal: AbortSignal | undefined,
  includeTopK: boolean,
): Promise<string> {
  const model = explainerModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort);
  }

  // MiniMax's recommended sampling for this model — warmer and more
  // nucleus-restricted than the tutor's JSON-oriented settings, since this is
  // free-form educational prose, not structured output.
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 1.0,
    top_p: 0.95,
    max_tokens: 2000,
    stream: false,
  };
  if (includeTopK) body.top_k = 40;

  let res: Response;
  try {
    res = await fetch(`${explainerBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${explainerApiKey()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (signal?.aborted) {
        throw new LlmError("aborted", `explainer (${model}) call aborted by caller`);
      }
      throw new LlmError("timeout", `explainer (${model}) timed out after ${TIMEOUT_MS}ms`);
    }
    throw new LlmError(
      "network",
      `Network error calling explainer (${model}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }

  // Some endpoints 400 on an unrecognized `top_k` — drop it and retry once
  // rather than failing the whole request over an optional sampling knob.
  if (!res.ok && includeTopK && (res.status === 400 || res.status === 422)) {
    const detail = await res.text().catch(() => "");
    if (/top_k/i.test(detail)) {
      explainerTopKUnsupported = true;
      console.warn(
        `[llm] explainer "${model}" rejected top_k — retrying without it and skipping it for the rest of this session: ${detail.slice(0, 200)}`,
      );
      return callExplainerModelOnce(messages, signal, false);
    }
    throw new LlmError("http_error", `explainer (${model}) HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }

  if (res.status === 429) {
    throw new LlmError("rate_limit", `explainer (${model}) rate limited (429)`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LlmError("http_error", `explainer (${model}) HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }

  const payload = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = payload?.choices?.[0]?.message?.content;
  if (!content || content.trim() === "") {
    throw new LlmError("empty", `explainer (${model}) returned an empty message`);
  }
  return content;
}

/**
 * Fast, plain-text explanation call on the dedicated explainer model — used
 * for clicked GLB components and standalone "how does X work" questions.
 * Same 25s-per-attempt timeout as the main client. On ANY failure (timeout,
 * rate limit, bad model id, etc.) falls back to the main tutor model's prose
 * path (`generateText`) for this ONE request only — the explainer has no
 * fallback chain of its own, and a failure here never touches the main
 * model's auto-switch/failover state (only `noteTutorOutcome` does that, and
 * this function never calls it).
 */
export async function callExplainer(prompt: string, signal?: AbortSignal): Promise<string> {
  const messages: LlmMessage[] = [{ role: "user", content: prompt }];
  const model = explainerModel();
  try {
    const raw = await callExplainerModelOnce(messages, signal, !explainerTopKUnsupported);
    const prose = cleanProse(raw);
    if (!prose) throw new LlmError("empty", `explainer (${model}) produced no prose`);
    console.log(`[llm] explainer: served by "${model}"`);
    return prose;
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") throw err;
    console.warn(
      `[llm] explainer "${model}" failed (${err instanceof LlmError ? err.reason : "error"}: ${
        err instanceof Error ? err.message : String(err)
      }) — falling back to the main model for this request only`,
    );
    return generateText(prompt, signal);
  }
}
