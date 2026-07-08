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
 * qualifies even after one reworded retry ("single <query>").
 * `excludeIds` (Poly Pizza model ids) are dropped before ranking, e.g. so a
 * rejected base model can never be re-picked.
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

  const first = await attempt(searchQuery);
  if (first) return first;
  return attempt(`single ${searchQuery}`);
}
