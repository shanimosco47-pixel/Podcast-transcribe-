/**
 * Title normalization for episode matching.
 *
 * Replaces `normalizeLooseTitle` from steipete/summarize, whose final
 * `[^a-z0-9]+ -> " "` pass deletes every Hebrew character and so collapses
 * every Hebrew title to the empty string. See tests/matching.normalize.test.ts.
 */

/** Zero-width characters, bidi controls, and the BOM. */
const INVISIBLE_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/** Hebrew niqqud and cantillation marks (U+0591-U+05C7). */
const HEBREW_MARK_PATTERN = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/gu;

/** Maqaf, geresh, gershayim, and the other Hebrew word-binding punctuation. */
const HEBREW_PUNCTUATION_PATTERN = /[\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4]/gu;

/** Final letter forms folded to their medial equivalents. */
const FINAL_FORM_MAP: ReadonlyMap<string, string> = new Map([
  ["ך", "כ"], // ך -> כ
  ["ם", "מ"], // ם -> מ
  ["ן", "נ"], // ן -> נ
  ["ף", "פ"], // ף -> פ
  ["ץ", "צ"], // ץ -> צ
]);

function foldFinalForms(value: string): string {
  let out = "";
  for (const char of value) out += FINAL_FORM_MAP.get(char) ?? char;
  return out;
}

/**
 * Normalize a show or episode title for comparison.
 *
 * Unicode-aware: letters and numbers in every script survive, so Hebrew,
 * Arabic, and Cyrillic titles normalize to real content. The result is empty
 * only when the input genuinely carries no letters or digits.
 */
export function normalizeTitle(value: string): string {
  return foldFinalForms(
    value
      .normalize("NFKC")
      .replace(INVISIBLE_PATTERN, "")
      .replace(HEBREW_MARK_PATTERN, "")
      .replace(HEBREW_PUNCTUATION_PATTERN, " ")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{Diacritic}+/gu, ""),
  )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Normalized whitespace-separated tokens. Empty input yields an empty array. */
export function titleTokens(value: string): string[] {
  const normalized = normalizeTitle(value);
  return normalized ? normalized.split(" ") : [];
}

/**
 * True when a title carries no comparable content. Two such titles must never
 * be treated as an exact match for each other.
 */
export function isDegenerateTitle(value: string): boolean {
  return normalizeTitle(value).length === 0;
}
