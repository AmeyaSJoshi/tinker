/**
 * Validated model resolution (SERVER-ONLY).
 *
 * Wraps a Poly Pizza search with the semantic validator: search, rank, take the
 * top candidates, ask the LLM which (if any) is a genuine single-object match,
 * and — if none qualify — retry once with a reworded query before giving up.
 * Shared by the live resolve-asset route and the offline library audit script
 * so both use the exact same "never download an unvalidated guess" rule.
 */
import { rankModels, searchModels, type PolyModel } from "./polypizza";
import { MAX_VALIDATION_CANDIDATES, validateCandidates } from "./assetValidator";

/**
 * Search for `searchQuery`, validate the top candidates against
 * `requestPhrase`, and return the winning model — or null if nothing
 * qualifies even after multiple search retries. `excludeIds` (Poly Pizza
 * model ids) are dropped before ranking, e.g. so a rejected base model can
 * never be re-picked.
 *
 * Retry strategies (in order):
 * 1. Original query as-is
 * 2. "single <query>" (singular hint)
 * 3. "<query> 3d model" (add model hint)
 * 4. Individual major words from the query (e.g. "peanut jar" → try "peanut")
 */
export async function resolveValidatedModel(
  requestPhrase: string,
  searchQuery: string,
  excludeIds: Set<string> = new Set(),
): Promise<PolyModel | null> {
  const attempt = async (query: string): Promise<PolyModel | null> => {
    let raw: PolyModel[];
    try {
      raw = await searchModels(query, 24);
    } catch (err) {
      console.warn(`[assetResolver] search failed for "${query}":`, err);
      return null;
    }
    const filtered = raw.filter((m) => !excludeIds.has(m.id));
    const ranked = rankModels(filtered).slice(0, MAX_VALIDATION_CANDIDATES);
    if (ranked.length === 0) return null;

    const idx = await validateCandidates(
      requestPhrase,
      ranked.map((m) => m.title || "Untitled"),
    );
    return idx === 0 ? null : ranked[idx - 1];
  };

  // Try the full query first.
  let result = await attempt(searchQuery);
  if (result) return result;

  // Try a singular-form hint: "single peanut jar"
  result = await attempt(`single ${searchQuery}`);
  if (result) return result;

  // Try adding "3d model" hint: "peanut jar 3d model"
  result = await attempt(`${searchQuery} 3d model`);
  if (result) return result;

  // If that's still no good and the query has multiple words, try each major
  // word alone (longest first, so "peanut jar" tries "peanut" before "jar").
  // This helps when a compound noun breaks down — "peanut jar" fails but we
  // find a real "peanut" that's better than primitives.
  const words = searchQuery
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const word of words) {
    if (word === searchQuery) continue; // already tried the full thing
    result = await attempt(word);
    if (result) return result;
  }

  return null;
}
