/**
 * 扫读模式本地拆分规则
 *
 * English 和 French 共用一套框架，按语言切换连接词/从句词规则。
 * English 保留原有 POS 辅助；French 走更保守的关键词启发式。
 */

import { Lexer as PosLexer, Tagger as PosTagger } from "pos";
import type { SupportedLanguage } from "./types.ts";

export type Granularity = "coarse" | "medium" | "fine";

export interface ScanChunk {
  text: string;
  level: number;
}

export interface ScanResult {
  chunks: ScanChunk[];
  needsLLM: boolean;
}

const THRESHOLD_WORDS: Record<string, number> = {
  short: 8,
  medium: 12,
  long: 18,
};

interface RuleSet {
  coordinate: Set<string>;
  strongSubordinate: Set<string>;
  weakSubordinate: Set<string>;
  relative: Set<string>;
  relativeRelaxed: Set<string>;
  transition: Set<string>;
  prepositionFine: Set<string>;
  clauseStarterFine: Set<string>;
  reportVerbs: Set<string>;
  pronouns: Set<string>;
  articles: Set<string>;
}

const ENGLISH_RULES: RuleSet = {
  coordinate: new Set(["and", "or", "but", "nor", "yet", "so"]),
  strongSubordinate: new Set([
    "because", "although", "though", "whereas", "unless",
    "whenever", "wherever", "whether",
  ]),
  weakSubordinate: new Set([
    "since", "while", "if", "when", "until", "before", "after", "once",
  ]),
  relative: new Set(["which", "who", "whom", "whose", "where", "that"]),
  relativeRelaxed: new Set(["which", "who", "whom", "whose", "where"]),
  transition: new Set([
    "however", "therefore", "thus", "hence", "nevertheless", "nonetheless",
    "moreover", "furthermore", "meanwhile", "otherwise", "consequently", "accordingly",
  ]),
  prepositionFine: new Set([
    "about", "from", "into", "through", "across", "toward", "towards",
    "without", "despite", "between", "on", "for", "with", "by", "in",
    "over", "under", "beyond", "against", "compared", "including",
  ]),
  clauseStarterFine: new Set(["how", "why", "what"]),
  reportVerbs: new Set([
    "know", "knew", "known", "knows", "think", "thought", "thinks", "believe",
    "believed", "believes", "say", "said", "says", "tell", "told", "tells",
    "feel", "felt", "feels", "find", "found", "finds", "show", "showed", "shown",
    "shows", "suggest", "suggested", "suggests", "argue", "argued", "argues",
    "claim", "claimed", "claims", "report", "reported", "reports", "explain",
    "explained", "explains", "realize", "realized", "realizes", "notice",
    "noticed", "notices", "assume", "assumed", "assumes", "hope", "hoped", "hopes",
    "expect", "expected", "expects", "confirm", "confirmed", "confirms", "reveal",
    "revealed", "reveals", "mean", "meant", "means", "understand", "understood",
    "understands", "indicate", "indicated", "indicates", "ensure", "ensured",
    "ensures", "note", "noted", "notes", "prove", "proved", "proven", "proves",
    "agree", "agreed", "agrees", "conclude", "concluded", "concludes", "discover",
    "discovered", "discovers", "learn", "learned", "learnt", "learns", "remember",
    "remembered", "remembers", "mention", "mentioned", "mentions", "deny", "denied",
    "denies", "insist", "insisted", "insists", "decide", "decided", "decides",
    "state", "stated", "states", "declare", "declared", "declares",
  ]),
  pronouns: new Set(["i", "you", "he", "she", "it", "we", "they", "there", "this", "these", "those"]),
  articles: new Set(["the", "a", "an"]),
};

const FRENCH_RULES: RuleSet = {
  coordinate: new Set(["et", "ou", "mais", "ni", "car"]),
  strongSubordinate: new Set([
    "parce", "puisque", "quoique", "lorsque", "tandis", "alors", "afin", "bien",
  ]),
  weakSubordinate: new Set([
    "si", "quand", "comme", "avant", "après", "pendant",
  ]),
  relative: new Set(["qui", "dont", "où", "lequel", "laquelle", "lesquels", "lesquelles"]),
  relativeRelaxed: new Set(["qui", "dont", "où"]),
  transition: new Set([
    "cependant", "toutefois", "néanmoins", "pourtant", "ainsi", "donc",
    "sinon", "autrement", "or", "enfin",
  ]),
  prepositionFine: new Set([
    "avec", "sans", "pour", "contre", "dans", "entre", "parmi", "malgré",
    "selon", "sur", "sous", "vers", "depuis", "après", "avant", "durant",
  ]),
  clauseStarterFine: new Set(["comment", "pourquoi", "quoi"]),
  reportVerbs: new Set([
    "dire", "dit", "disent", "penser", "pense", "croire", "crois", "croient",
    "savoir", "sait", "savent", "expliquer", "explique", "montrer", "montre",
    "confirmer", "confirme", "affirmer", "affirme", "indiquer", "indique",
    "estimer", "estime", "supposer", "suppose", "remarquer", "remarque",
  ]),
  pronouns: new Set([
    "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "ce", "cela", "ça", "c",
  ]),
  articles: new Set(["le", "la", "les", "l", "un", "une", "des", "du", "au", "aux", "cet", "cette", "ces"]),
};

const RULES: Record<SupportedLanguage, RuleSet> = {
  english: ENGLISH_RULES,
  french: FRENCH_RULES,
};

const ALL_SUBORDINATE = {
  english: new Set([
    ...ENGLISH_RULES.strongSubordinate,
    ...ENGLISH_RULES.weakSubordinate,
    ...ENGLISH_RULES.relative,
  ]),
  french: new Set([
    ...FRENCH_RULES.strongSubordinate,
    ...FRENCH_RULES.weakSubordinate,
    ...FRENCH_RULES.relative,
  ]),
};

let posLexer: PosLexer | null = null;
let posTagger: PosTagger | null = null;

export function getPOSTags(sentence: string, words: string[]): string[] | null {
  try {
    if (!posLexer) posLexer = new PosLexer();
    if (!posTagger) posTagger = new PosTagger();

    const posTokens = posLexer.lex(sentence);
    const tagged = posTagger.tag(posTokens);
    const charTags: string[] = new Array(sentence.length).fill("");
    let searchFrom = 0;

    for (const [posWord, posTag] of tagged) {
      const idx = sentence.indexOf(posWord, searchFrom);
      if (idx >= 0) {
        if (!/^[,.:;!?()"'\-`]$/.test(posTag)) {
          for (let c = idx; c < idx + posWord.length; c++) {
            charTags[c] = posTag;
          }
        }
        searchFrom = idx + posWord.length;
      }
    }

    const tags: string[] = [];
    let wordSearchFrom = 0;
    for (const word of words) {
      const idx = sentence.indexOf(word, wordSearchFrom);
      if (idx >= 0) {
        let tag = "";
        for (let c = idx; c < idx + word.length; c++) {
          if (charTags[c]) { tag = charTags[c]; break; }
        }
        tags.push(tag || "NN");
        wordSearchFrom = idx + word.length;
      } else {
        tags.push("NN");
      }
    }

    return tags;
  } catch {
    return null;
  }
}

function cleanWord(word: string): string {
  return word.toLocaleLowerCase().replace(/[^\p{L}'’-]/gu, "").replace(/[’]/g, "'");
}

function endsWithPunct(word: string): boolean {
  return /[,;]$/.test(word);
}

function countSubordinateMarkers(words: string[], language: SupportedLanguage): number {
  let count = 0;
  for (const word of words) {
    if (ALL_SUBORDINATE[language].has(cleanWord(word))) count++;
  }
  return count;
}

function isSubordinateStart(word: string, language: SupportedLanguage): boolean {
  const rules = RULES[language];
  const clean = cleanWord(word);
  return rules.strongSubordinate.has(clean) || rules.weakSubordinate.has(clean);
}

function isDashWord(word: string): boolean {
  return word === "\u2014" || word === "\u2013" || word === "--";
}

function looksLikeClauseStart(
  word: string,
  tags: string[] | null,
  index: number,
  language: SupportedLanguage,
): boolean {
  if (language === "english" && tags) {
    const tag = tags[index];
    if (["PRP", "DT", "NNP", "NNPS", "EX", "MD"].includes(tag)) return true;
    if (["VBD", "VBP", "VBZ", "VB"].includes(tag)) return true;
    if (tag === "RB" && index + 1 < tags.length) {
      return ["VBD", "VBP", "VBZ", "VB", "MD"].includes(tags[index + 1]);
    }
    if (["JJ", "JJR", "JJS", "VBN", "VBG"].includes(tag)) return false;
  }

  const rules = RULES[language];
  const clean = cleanWord(word);
  const parts = clean.split("'");
  if (parts.length === 2) {
    if (rules.pronouns.has(parts[0]) || rules.articles.has(parts[0])) return true;
  }
  if (rules.pronouns.has(clean)) return true;
  if (rules.articles.has(clean)) return true;
  if (/^[A-ZÀ-ÖØ-Þ]/.test(word) && word.length > 1) return true;
  return false;
}

function mergeShortChunks(chunks: ScanChunk[]): ScanChunk[] {
  if (chunks.length <= 1) return chunks;

  const result: ScanChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const wordCount = chunk.text.split(/\s+/).length;

    if (wordCount < 3 && result.length > 0) {
      result[result.length - 1].text += " " + chunk.text;
    } else if (wordCount < 3 && i < chunks.length - 1) {
      chunks[i + 1] = {
        text: chunk.text + " " + chunks[i + 1].text,
        level: chunks[i + 1].level,
      };
    } else {
      result.push({ ...chunk });
    }
  }

  return result;
}

function splitAtBoundaries(
  sentence: string,
  granularity: Granularity,
  tags: string[] | null,
  language: SupportedLanguage,
): ScanChunk[] {
  const words = sentence.match(/\S+/g);
  if (!words || words.length === 0) return [];

  const rules = RULES[language];
  const longThreshold = granularity === "fine" ? 12 : 15;
  const minBefore = granularity === "fine" ? 3 : 5;
  const minAfterCoord = granularity === "fine" ? 3 : 5;
  const minAfterSub = granularity === "fine" ? 3 : 4;

  const isLongSentence = words.length >= longThreshold;
  const chunks: ScanChunk[] = [];
  let currentWords: string[] = [];
  let currentLevel = 0;

  if (isSubordinateStart(words[0], language)) {
    currentLevel = 1;
  } else if (language === "english" && tags && (tags[0] === "VBG" || tags[0] === "VBN")) {
    currentLevel = 1;
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const clean = cleanWord(word);
    const prev = i > 0 ? words[i - 1] : "";
    const prevHasPunct = endsWithPunct(prev);

    let shouldSplit = false;
    let nextLevel = 0;

    if (currentWords.length >= 2) {
      if (prev.endsWith(";")) {
        shouldSplit = true;
        nextLevel = isSubordinateStart(word, language) ? 1 : 0;
      } else if (prev.endsWith(":") && !prev.includes("//") && !/^\d/.test(word)) {
        const remaining = words.length - i;
        if (remaining >= 4) {
          shouldSplit = true;
          nextLevel = Math.min(currentLevel + 1, 5);
        }
      } else if (isDashWord(word) && currentWords.length >= 2) {
        shouldSplit = true;
        nextLevel = currentLevel;
      } else if (!isDashWord(prev) && (prev.endsWith("\u2014") || prev.endsWith("\u2013"))) {
        shouldSplit = true;
        nextLevel = currentLevel;
      } else if (word.startsWith("(") && currentWords.length >= 2) {
        shouldSplit = true;
        nextLevel = Math.min(currentLevel + 1, 5);
      } else if (prev.endsWith(")") && currentLevel > 0) {
        shouldSplit = true;
        nextLevel = Math.max(currentLevel - 1, 0);
      } else if (rules.coordinate.has(clean) && prevHasPunct) {
        shouldSplit = true;
        nextLevel = 0;
      } else if (rules.strongSubordinate.has(clean)) {
        shouldSplit = true;
        nextLevel = Math.min(currentLevel + 1, 5);
      } else if (language === "english" && clean === "even" && i + 1 < words.length) {
        const nextClean = cleanWord(words[i + 1]);
        if (rules.weakSubordinate.has(nextClean) || rules.strongSubordinate.has(nextClean)) {
          shouldSplit = true;
          nextLevel = Math.min(currentLevel + 1, 5);
        }
      } else if (rules.weakSubordinate.has(clean) && prevHasPunct) {
        shouldSplit = true;
        nextLevel = Math.min(currentLevel + 1, 5);
      } else if (rules.relative.has(clean) && prevHasPunct) {
        if (language === "english" && clean === "that") {
          const tag = tags?.[i];
          if (tag !== "DT") {
            const prevClean = cleanWord(prev.replace(/[,;]$/, ""));
            if (!rules.reportVerbs.has(prevClean)) {
              shouldSplit = true;
              nextLevel = Math.min(currentLevel + 1, 5);
            }
          }
        } else {
          shouldSplit = true;
          nextLevel = Math.min(currentLevel + 1, 5);
        }
      } else if (rules.transition.has(clean) && (prevHasPunct || i === 0)) {
        shouldSplit = true;
        nextLevel = 0;
      } else if (
        currentLevel >= 1 &&
        prevHasPunct &&
        !rules.coordinate.has(clean) &&
        !rules.strongSubordinate.has(clean) &&
        !rules.weakSubordinate.has(clean) &&
        !rules.relative.has(clean) &&
        !rules.transition.has(clean)
      ) {
        if (looksLikeClauseStart(word, tags, i, language)) {
          shouldSplit = true;
          nextLevel = 0;
        }
      }

      if (!shouldSplit && granularity !== "coarse" && isLongSentence && currentWords.length >= minBefore) {
        const remaining = words.length - i;
        if (rules.coordinate.has(clean) && remaining >= minAfterCoord) {
          shouldSplit = true;
          nextLevel = 0;
        } else if (rules.weakSubordinate.has(clean) && remaining >= minAfterSub) {
          shouldSplit = true;
          nextLevel = Math.min(currentLevel + 1, 5);
        } else if (rules.relativeRelaxed.has(clean) && remaining >= minAfterSub) {
          shouldSplit = true;
          nextLevel = Math.min(currentLevel + 1, 5);
        } else if (
          language === "english" &&
          tags &&
          tags[i] === "TO" &&
          i + 1 < words.length &&
          tags[i + 1]?.startsWith("VB") &&
          remaining >= 4
        ) {
          shouldSplit = true;
          nextLevel = Math.min(currentLevel + 1, 5);
        }
      }

      if (!shouldSplit && granularity === "fine" && isLongSentence && currentWords.length >= 4) {
        const remaining = words.length - i;
        if (rules.prepositionFine.has(clean) && remaining >= 4) {
          shouldSplit = true;
          nextLevel = Math.min(currentLevel + 1, 5);
        } else if (rules.clauseStarterFine.has(clean) && remaining >= 4) {
          shouldSplit = true;
          nextLevel = Math.min(currentLevel + 1, 5);
        } else if (/^["'\u201C\u2018«]/.test(word) && currentWords.length >= 3) {
          shouldSplit = true;
          nextLevel = 0;
        }
      }
    }

    if (shouldSplit && currentWords.length > 0) {
      chunks.push({ text: currentWords.join(" "), level: currentLevel });
      currentWords = [word];
      currentLevel = nextLevel;
    } else {
      currentWords.push(word);
    }
  }

  if (currentWords.length > 0) {
    chunks.push({ text: currentWords.join(" "), level: currentLevel });
  }

  return mergeShortChunks(chunks);
}

export function scanSplit(
  sentence: string,
  threshold: "short" | "medium" | "long" = "medium",
  granularity: Granularity = "medium",
  language: SupportedLanguage = "english",
): ScanResult {
  const trimmed = sentence.trim();
  const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
  const minWords = THRESHOLD_WORDS[threshold];

  if (words.length < minWords) {
    return { chunks: [{ text: trimmed, level: 0 }], needsLLM: false };
  }

  const tags = language === "english" ? getPOSTags(trimmed, words) : null;
  const chunks = splitAtBoundaries(trimmed, granularity, tags, language);

  if (chunks.length > 1) {
    return { chunks, needsLLM: false };
  }

  const markerCount = countSubordinateMarkers(words, language);
  if (markerCount >= 3) {
    return { chunks: [{ text: trimmed, level: 0 }], needsLLM: true };
  }

  return { chunks: [{ text: trimmed, level: 0 }], needsLLM: false };
}

export function toChunkedString(chunks: ScanChunk[]): string {
  return chunks.map((chunk) => "  ".repeat(chunk.level) + chunk.text).join("\n");
}
