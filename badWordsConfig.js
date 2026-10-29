/**
 * Configuration file for blocked abusive words.
 * Easy to extend with additional words or phrases.
 */
export const STARTER_BAD_WORDS = [
  'fuck',
  'madarchod',
  'madharchod',
  'behenchod',
  'bhenchod',
  'bsdk',
  'chutiya',
  'mc',
  'bc',
];

/**
 * Builds a regex that detects the target word with:
 * - Whole word boundary matching (won't match "mcdonalds" or "because")
 * - Common leetspeak substitutions (e.g. a=@, 4; e=3; i=1, !; o=0; u=v, 4, @; s=$, 5; t=7, +)
 * - Repeated letters (e.g. fuuuck, bbbccc)
 * - Obfuscation spaces/dots/dashes between letters (e.g. f.u.c.k, m c)
 *
 * @param {string} word
 * @returns {RegExp}
 */
export function buildWordRegex(word) {
  const parts = [];
  for (let i = 0; i < word.length; i++) {
    const ch = word[i].toLowerCase();
    let charClass = ch;
    if (ch === 'a') charClass = '[a@4*]';
    else if (ch === 'e') charClass = '[e3*]';
    else if (ch === 'i') charClass = '[i1!|*]';
    else if (ch === 'o') charClass = '[o0*]';
    else if (ch === 'u') charClass = '[uv*@4_]';
    else if (ch === 's') charClass = '[s5$]';
    else if (ch === 't') charClass = '[t7+]';
    else if (ch === 'c') charClass = '[c(<]';
    else charClass = ch;

    parts.push(`${charClass}+`);
  }
  const innerPattern = parts.join('[\\s._-]*');
  return new RegExp(`(?:^|[^a-zA-Z0-9])${innerPattern}(?:$|[^a-zA-Z0-9])`, 'i');
}

export const COMPILED_BAD_WORD_REGEXES = STARTER_BAD_WORDS.map((w) => ({
  word: w,
  regex: buildWordRegex(w),
}));

/**
 * Checks text against configured abusive words.
 * Returns the matched word if found, or null otherwise.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function checkAbusiveWord(text) {
  if (!text || typeof text !== 'string') return null;
  for (const item of COMPILED_BAD_WORD_REGEXES) {
    if (item.regex.test(text)) {
      return item.word;
    }
  }
  return null;
}

