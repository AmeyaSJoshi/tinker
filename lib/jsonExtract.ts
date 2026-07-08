/**
 * Isolate the first balanced `{...}` block in a string (brace-counting, so
 * nested objects don't confuse it) so stray prose around a model's JSON reply
 * can't break `JSON.parse`. Returns null if no balanced object is found.
 */
export function extractJsonObject(text: string): string | null {
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
