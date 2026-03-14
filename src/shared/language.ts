import type { LearningLanguage, SupportedLanguage } from "./types.ts";

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = ["english", "french"];

const WORD_TOKEN_REGEX = /\p{L}+(?:['’]\p{L}+)?/gu;
const SIMPLE_WORD_REGEX = /^[\p{L}]+(?:'[\p{L}]+)?$/u;

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  english: "English",
  french: "French",
};

const ENGLISH_HINT_WORDS = new Set([
  "the", "and", "that", "with", "from", "this", "they", "have", "will", "would",
  "there", "their", "which", "about", "into", "because", "while", "when", "where",
  "after", "before", "through", "should", "could", "these", "those", "than", "been",
]);

const FRENCH_HINT_WORDS = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "à", "en", "dans",
  "pour", "sur", "avec", "sans", "que", "qui", "dont", "où", "mais", "comme",
  "est", "sont", "été", "être", "avoir", "nous", "vous", "ils", "elles", "plus",
  "pas", "parce", "lorsque", "ainsi", "donc", "cependant", "toutefois", "puisque",
]);

const FRENCH_ELISION_PREFIXES = new Set([
  "l", "d", "j", "m", "n", "s", "t", "c", "qu", "jusqu", "lorsqu", "puisqu", "quoiqu",
]);

const BASIC_WORDS: Record<SupportedLanguage, Set<string>> = {
  english: new Set([
    "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this",
    "these", "those", "i", "you", "he", "she", "it", "we", "they", "me", "him",
    "her", "us", "them", "my", "your", "his", "its", "our", "their", "to", "of",
    "in", "on", "at", "for", "with", "from", "by", "as", "is", "am", "are", "was",
    "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "go", "went", "gone", "come", "came", "get", "got", "make", "made", "take",
    "took", "see", "saw", "know", "knew", "say", "said", "very", "more", "most",
    "much", "many", "some", "any", "all", "each", "every", "not", "no", "yes",
    "here", "there", "today", "tomorrow", "yesterday", "good", "bad", "big",
    "small", "new", "old", "first", "last", "same", "other", "people", "person",
    "time", "day", "year", "way", "thing", "man", "woman", "child", "children",
  ]),
  french: new Set([
    "a", "à", "au", "aux", "de", "du", "des", "la", "le", "les", "un", "une",
    "et", "ou", "mais", "donc", "or", "ni", "car", "dans", "sur", "sous", "avec",
    "sans", "pour", "par", "entre", "chez", "vers", "depuis", "comme", "que",
    "qui", "quoi", "dont", "où", "quand", "si", "ce", "cet", "cette", "ces",
    "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "me", "te",
    "se", "lui", "leur", "y", "en", "ne", "pas", "plus", "bien", "très", "tout",
    "tous", "toute", "toutes", "mon", "ma", "mes", "ton", "ta", "tes", "son",
    "sa", "ses", "notre", "nos", "votre", "vos", "leurs", "être", "avoir", "faire",
    "aller", "dire", "voir", "savoir", "pouvoir", "vouloir", "venir", "devoir",
    "prendre", "donner", "mettre", "parler", "aimer", "trouver", "laisser",
    "arriver", "homme", "femme", "jour", "temps", "fois", "main", "œil", "vie",
  ]),
};

function normalizeApostrophes(value: string): string {
  return value.replace(/[’`´]/g, "'");
}

export function getLanguageLabel(language: SupportedLanguage): string {
  return LANGUAGE_LABELS[language];
}

export function getLangCode(language: SupportedLanguage): string {
  return language === "english" ? "en" : "fr";
}

export function normalizeWord(value: string, language: SupportedLanguage): string {
  return normalizeApostrophes(value).normalize("NFC").trim().toLocaleLowerCase(getLangCode(language));
}

export function normalizeWordForLookup(value: string, language: SupportedLanguage): string | null {
  const normalized = normalizeWord(value, language);
  if (!normalized) return null;
  if (!SIMPLE_WORD_REGEX.test(normalized)) return null;

  if (language === "french" && normalized.includes("'")) {
    const parts = normalized.split("'");
    if (parts.length === 2 && FRENCH_ELISION_PREFIXES.has(parts[0]) && parts[1].length >= 2) {
      return parts[1];
    }
  }

  return normalized;
}

export function extractLookupWords(
  text: string,
  language: SupportedLanguage,
): Array<{ raw: string; word: string; start: number; end: number }> {
  const matches = text.matchAll(WORD_TOKEN_REGEX);
  const tokens: Array<{ raw: string; word: string; start: number; end: number }> = [];

  for (const match of matches) {
    const raw = match[0];
    const start = match.index ?? 0;
    const end = start + raw.length;
    const word = normalizeWordForLookup(raw, language);
    if (!word) continue;
    tokens.push({ raw, word, start, end });
  }

  return tokens;
}

export function isBasicWord(word: string, language: SupportedLanguage): boolean {
  return BASIC_WORDS[language].has(normalizeWord(word, language));
}

export function buildWholeWordRegex(words: string[]): RegExp | null {
  if (words.length === 0) return null;

  const escaped = [...new Set(words)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  if (escaped.length === 0) return null;

  return new RegExp(`(?<!\\p{L})(${escaped.join("|")})(?!\\p{L})`, "giu");
}

export function findWholeWordMatches(
  text: string,
  words: string[],
): Array<{ start: number; end: number; match: string }> {
  const regex = buildWholeWordRegex(words);
  if (!regex) return [];

  const matches: Array<{ start: number; end: number; match: string }> = [];
  let result: RegExpExecArray | null;

  while ((result = regex.exec(text)) !== null) {
    matches.push({
      start: result.index,
      end: result.index + result[0].length,
      match: result[0],
    });
  }

  return matches;
}

export function splitByWholeWordMatches(
  text: string,
  words: string[],
): Array<{ text: string; matched: boolean }> {
  const matches = findWholeWordMatches(text, words);
  if (matches.length === 0) return [{ text, matched: false }];

  const parts: Array<{ text: string; matched: boolean }> = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      parts.push({ text: text.slice(cursor, match.start), matched: false });
    }
    parts.push({ text: text.slice(match.start, match.end), matched: true });
    cursor = match.end;
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), matched: false });
  }

  return parts;
}

export function getLanguageFromLangTag(value: string | null | undefined): SupportedLanguage | null {
  if (!value) return null;
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "english";
  if (normalized === "fr" || normalized.startsWith("fr-")) return "french";
  return null;
}

function scoreLanguage(text: string, language: SupportedLanguage): number {
  const tokens = extractLookupWords(text, language).map((token) => token.word);
  if (tokens.length === 0) return 0;

  const hintWords = language === "english" ? ENGLISH_HINT_WORDS : FRENCH_HINT_WORDS;
  let score = 0;

  for (const token of tokens) {
    if (hintWords.has(token)) score += 1;
    if (isBasicWord(token, language)) score += 0.35;
  }

  if (language === "french") {
    if (/[àâæçéèêëîïôœùûüÿ]/iu.test(text)) score += 1.5;
    if (/(?:^|[\s(])(?:c|d|j|l|m|n|qu|s|t|jusqu|lorsqu|puisqu|quoiqu)['’]/iu.test(text)) {
      score += 1.5;
    }
  }

  return score / Math.max(tokens.length, 1);
}

export function detectTextLanguage(text: string): SupportedLanguage | null {
  const trimmed = text.trim();
  if (trimmed.length < 12) return null;

  const englishScore = scoreLanguage(trimmed, "english");
  const frenchScore = scoreLanguage(trimmed, "french");

  if (frenchScore >= 0.12 && frenchScore > englishScore * 1.1) return "french";
  if (englishScore >= 0.12 && englishScore >= frenchScore * 1.1) return "english";

  if (/[àâæçéèêëîïôœùûüÿ]/iu.test(trimmed) && frenchScore > 0.05) return "french";

  return null;
}

export function detectElementLanguage(
  element: Element,
  text: string,
  preference: LearningLanguage = "auto",
): SupportedLanguage | null {
  if (preference !== "auto") return preference;

  const langEl = element.closest("[lang]");
  const langFromAttr = getLanguageFromLangTag(langEl?.getAttribute("lang"));
  if (langFromAttr) return langFromAttr;

  return detectTextLanguage(text);
}

export function getMasteredWordKey(language: SupportedLanguage, word: string): string {
  return `${language}:${normalizeWord(word, language)}`;
}

export function getLanguageFromMasteredKey(key: string): SupportedLanguage | null {
  if (key.startsWith("english:")) return "english";
  if (key.startsWith("french:")) return "french";
  return null;
}

export function getWordFromMasteredKey(key: string): string {
  return key.replace(/^(english|french):/, "");
}
