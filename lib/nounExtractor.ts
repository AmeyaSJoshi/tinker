/**
 * Shared "strip build verbs and articles down to the core noun" helper.
 *
 * Used by the resolve-asset route (to turn "build me a lighthouse" into
 * "lighthouse" for the library/search lookup) and by the intent router's
 * keyword-heuristic fallback (when the classifier LLM call itself fails and
 * there's no clean `targetObject` to fall back on).
 */

/**
 * Strip build verbs and articles to get the core noun: "build a lighthouse" ->
 * "lighthouse". The verb group is OPTIONAL: "I want a peanut jar" has no verb
 * after "I want", so the verb group must not be required or nothing strips at
 * all and the whole sentence leaks through as the "noun".
 */
export function extractNoun(phrase: string): string {
  let s = phrase.toLowerCase().trim().replace(/[.?!]+$/g, "");
  s = s.replace(
    /^(please\s+)?(can you\s+|could you\s+)?(i\s+(want|wanna|would like|'?d like)\s+(to\s+)?)?((build|make|create|design|show me|give me|draw|model|render|let'?s\s+(build|make|create)|add)\s+)?/,
    "",
  );
  s = s.replace(/^(a|an|the|some|my)\s+/, "");
  s = s.replace(/\s+(please|for me|now)$/g, "");
  return s.trim();
}
