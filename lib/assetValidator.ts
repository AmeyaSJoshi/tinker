/**
 * Semantic candidate validation (SERVER-ONLY).
 *
 * Poly Pizza's search is keyword/tag based, so a query like "bear" can surface
 * "Bear Trap" (contains the word but isn't a bear) or "Trees" (a forest pack,
 * not a single tree). Before we ever download a GLB, we ask the LLM to pick,
 * among a handful of candidate titles, the one that is genuinely the single
 * requested object — or admit that none of them qualify.
 */
import { generateText } from "./llm";

/** How many search results we show the validator at once. */
export const MAX_VALIDATION_CANDIDATES = 8;

function buildPrompt(requestPhrase: string, titles: string[]): string {
  const listing = titles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `A learner asked to build: "${requestPhrase}"

Here are ${titles.length} candidate 3D model titles found by search:
${listing}

Pick the number of the SINGLE BEST candidate, judged by these rules:
a. It must be the actual object requested, not merely something that contains the word (e.g. a request for "bear" must NOT match "Bear Trap"; "peanut" must NOT match "Peanut Jar" or "Peanut Butter"; "bike" must NOT match "Exercise Bike" or "Stationary Bike" when a real bicycle was meant).
b. It must be a SINGLE object, not a scene, set, pack, or collection (e.g. "tree" must NOT match "Trees" or "Forest Pack" — one tree, not a forest).
c. If NO candidate is genuinely the requested object, you MUST answer 0. A different game console, a different brand, or a vaguely similar gadget is NOT acceptable — being in the same category is not enough. For example: an Oculus controller is NOT an Xbox controller and must NOT match a request for "xbox"; a Gameboy is NOT a PS5 and must NOT match a request for "ps5" or "playstation 5"; a generic black box or unlabeled console shell must NOT match a request for a specific named console. When in doubt, answer 0 — a learner would rather wait for a real match than see the wrong object.

Reply with ONLY the number. No words, no punctuation, no explanation.`;
}

/** Parse the model's reply defensively: first integer in range, else 0. */
export function parseVerdict(raw: string, max: number): number {
  const match = raw.match(/-?\d+/);
  if (!match) return 0;
  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n) || n < 1 || n > max) return 0;
  return n;
}

/**
 * Ask the LLM which candidate (1-based index into `titles`) is the best real
 * match for `requestPhrase`, or 0 if none qualify. Never throws — a validator
 * failure (network, bad output) is treated as "no match" so callers fall back
 * safely rather than downloading an unvalidated guess.
 */
export async function validateCandidates(
  requestPhrase: string,
  titles: string[],
): Promise<number> {
  if (titles.length === 0) return 0;
  try {
    const raw = await generateText(buildPrompt(requestPhrase, titles));
    return parseVerdict(raw, titles.length);
  } catch (err) {
    console.warn(
      `[assetValidator] validation call failed for "${requestPhrase}":`,
      err,
    );
    return 0;
  }
}
