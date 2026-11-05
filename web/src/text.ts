/**
 * Search, ported from tic-registry's `web/src/lib/text.ts` (F48) with its
 * tests: what is matched is a *query*, so accents and ñ fold, case folds and
 * runs of whitespace collapse. Sorting is the opposite question and stays with
 * `localeCompare(…, "es")`.
 */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Every word of `query` in `haystack`, any order; an empty query matches all. */
export function matches(haystack: string, query: string): boolean {
  const needle = fold(query);
  if (!needle) return true;
  const target = fold(haystack);
  return needle.split(" ").every((word) => target.includes(word));
}
