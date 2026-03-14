/**
 * 多语言生词标注系统
 *
 * 当前支持：
 * - English: 频率表 + ECDICT + lemma map
 * - French: 频率表 + FreeDict(法中) + lemma map
 */

import {
  extractLookupWords,
  isBasicWord,
  normalizeWord,
} from "./language.ts";
import type { SupportedLanguage } from "./types.ts";

export interface VocabAnnotation {
  word: string;
  definition: string;
}

type StemCandidateSource = "exact" | "lemma" | "irregular" | "heuristic";

interface StemCandidate {
  word: string;
  source: StemCandidateSource;
}

type DictionaryMatchKind = "exact" | "folded";

interface DictionaryMatch {
  word: string;
  definition: string;
  kind: DictionaryMatchKind;
}

interface RankedFrenchMatch {
  candidate: StemCandidate;
  match: DictionaryMatch;
  definition: string;
  score: number;
}

interface LanguageVocabStore {
  frequencyRanks: Map<string, number>;
  frequencyLimit: number;
  dictMap: Map<string, string>;
  dictFoldedIndex: Map<string, string[]>;
  lemmaMap: Map<string, string>;
  lemmaFoldedIndex: Map<string, string[]>;
}

const stores = new Map<SupportedLanguage, LanguageVocabStore>();
const DISABLED_VOCAB_LIMIT = -1;

const FORMATTED_DEFINITION_REGEX = /^(?:n|v|adj|adv|prep|pron|int)\./;

function ensureStore(language: SupportedLanguage): LanguageVocabStore {
  const existing = stores.get(language);
  if (existing) return existing;

  const created: LanguageVocabStore = {
    frequencyRanks: new Map(),
    frequencyLimit: 0,
    dictMap: new Map(),
    dictFoldedIndex: new Map(),
    lemmaMap: new Map(),
    lemmaFoldedIndex: new Map(),
  };
  stores.set(language, created);
  return created;
}

function foldNormalizedWord(value: string): string {
  return value
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}

function foldWord(value: string, language: SupportedLanguage): string {
  return foldNormalizedWord(normalizeWord(value, language));
}

function pushIndexedValue(index: Map<string, string[]>, key: string, value: string): void {
  const existing = index.get(key);
  if (!existing) {
    index.set(key, [value]);
    return;
  }
  if (!existing.includes(value)) {
    existing.push(value);
  }
}

interface FrenchIrregularParadigm {
  base: string;
  forms: string[];
}

const FRENCH_MANUAL_IRREGULAR_BASES: Record<string, string[]> = {
  connais: ["connaître"],
  connaît: ["connaître"],
  connait: ["connaître"],
  connaissons: ["connaître"],
  connaissez: ["connaître"],
  connaissent: ["connaître"],
};

const FRENCH_IRREGULAR_PARADIGMS: FrenchIrregularParadigm[] = [
  {
    base: "avoir",
    forms: [
      "ai", "as", "a", "avons", "avez", "ont",
      "avais", "avait", "avions", "aviez", "avaient",
      "aurai", "auras", "aura", "aurons", "aurez", "auront",
      "aurais", "aurait", "aurions", "auriez", "auraient",
      "aie", "aies", "ait", "ayons", "ayez", "aient",
      "eus", "eut", "eûmes", "eûtes", "eurent",
      "eu", "eue", "eus", "eues", "ayant",
    ],
  },
  {
    base: "être",
    forms: [
      "suis", "es", "est", "sommes", "êtes", "sont",
      "étais", "était", "étions", "étiez", "étaient",
      "serai", "seras", "sera", "serons", "serez", "seront",
      "serais", "serait", "serions", "seriez", "seraient",
      "sois", "soit", "soyons", "soyez", "soient",
      "fus", "fut", "fûmes", "fûtes", "furent",
      "été",
    ],
  },
  {
    base: "aller",
    forms: [
      "vais", "vas", "va", "allons", "allez", "vont",
      "allais", "allait", "allions", "alliez", "allaient",
      "irai", "iras", "ira", "irons", "irez", "iront",
      "irais", "irait", "irions", "iriez", "iraient",
      "aille", "ailles", "aillions", "ailliez", "aillent",
      "allai", "allas", "alla", "allâmes", "allâtes", "allèrent",
      "allé", "allée", "allés", "allées", "allant",
    ],
  },
  {
    base: "faire",
    forms: [
      "fais", "fait", "faisons", "faites", "font",
      "faisais", "faisait", "faisions", "faisiez", "faisaient",
      "ferai", "feras", "fera", "ferons", "ferez", "feront",
      "ferais", "ferait", "ferions", "feriez", "feraient",
      "fasse", "fasses", "fassions", "fassiez", "fassent",
      "fis", "fit", "fîmes", "fîtes", "firent",
      "faite", "faits", "faisant",
    ],
  },
  {
    base: "pouvoir",
    forms: [
      "peux", "peut", "pouvons", "pouvez", "peuvent",
      "pouvais", "pouvait", "pouvions", "pouviez", "pouvaient",
      "pourrai", "pourras", "pourra", "pourrons", "pourrez", "pourront",
      "pourrais", "pourrait", "pourrions", "pourriez", "pourraient",
      "puisse", "puisses", "puissions", "puissiez", "puissent",
      "pus", "put", "pûmes", "pûtes", "purent",
      "pu", "pue", "pues", "pouvant",
    ],
  },
  {
    base: "vouloir",
    forms: [
      "veux", "veut", "voulons", "voulez", "veulent",
      "voulais", "voulait", "voulions", "vouliez", "voulaient",
      "voudrai", "voudras", "voudra", "voudrons", "voudrez", "voudront",
      "voudrais", "voudrait", "voudrions", "voudriez", "voudraient",
      "veuille", "veuilles", "voulions", "vouliez", "veuillent",
      "voulus", "voulut", "voulûmes", "voulûtes", "voulurent",
      "voulu", "voulue", "voulues", "voulant",
    ],
  },
  {
    base: "venir",
    forms: [
      "viens", "vient", "venons", "venez", "viennent",
      "venais", "venait", "venions", "veniez", "venaient",
      "viendrai", "viendras", "viendra", "viendrons", "viendrez", "viendront",
      "viendrais", "viendrait", "viendrions", "viendriez", "viendraient",
      "vienne", "viennes", "venions", "veniez", "viennent",
      "vins", "vint", "vînmes", "vîntes", "vinrent",
      "venu", "venue", "venus", "venues", "venant",
    ],
  },
  {
    base: "tenir",
    forms: [
      "tiens", "tient", "tenons", "tenez", "tiennent",
      "tenais", "tenait", "tenions", "teniez", "tenaient",
      "tiendrai", "tiendras", "tiendra", "tiendrons", "tiendrez", "tiendront",
      "tiendrais", "tiendrait", "tiendrions", "tiendriez", "tiendraient",
      "tienne", "tiennes", "tenions", "teniez", "tiennent",
      "tins", "tint", "tînmes", "tîntes", "tinrent",
      "tenu", "tenue", "tenus", "tenues", "tenant",
    ],
  },
  {
    base: "devoir",
    forms: [
      "dois", "doit", "devons", "devez", "doivent",
      "devais", "devait", "devions", "deviez", "devaient",
      "devrai", "devras", "devra", "devrons", "devrez", "devront",
      "devrais", "devrait", "devrions", "devriez", "devraient",
      "doive", "doives", "devions", "deviez", "doivent",
      "dus", "dut", "dûmes", "dûtes", "durent",
      "dû", "due", "dues", "devant",
    ],
  },
  {
    base: "savoir",
    forms: [
      "sais", "sait", "savons", "savez", "savent",
      "savais", "savait", "savions", "saviez", "savaient",
      "saurai", "sauras", "saura", "saurons", "saurez", "sauront",
      "saurais", "saurait", "saurions", "sauriez", "sauraient",
      "sache", "saches", "sachions", "sachiez", "sachent",
      "sus", "sut", "sûmes", "sûtes", "surent",
      "su", "sue", "sues", "sachant",
    ],
  },
  {
    base: "voir",
    forms: [
      "vois", "voit", "voyons", "voyez", "voient",
      "voyais", "voyait", "voyions", "voyiez", "voyaient",
      "verrai", "verras", "verra", "verrons", "verrez", "verront",
      "verrais", "verrait", "verrions", "verriez", "verraient",
      "voie", "voies", "voyions", "voyiez", "voient",
      "vis", "vit", "vîmes", "vîtes", "virent",
      "vu", "vue", "vues", "voyant",
    ],
  },
  {
    base: "prendre",
    forms: [
      "prends", "prend", "prenons", "prenez", "prennent",
      "prenais", "prenait", "prenions", "preniez", "prenaient",
      "prendrai", "prendras", "prendra", "prendrons", "prendrez", "prendront",
      "prendrais", "prendrait", "prendrions", "prendriez", "prendraient",
      "prenne", "prennes", "prenions", "preniez", "prennent",
      "pris", "prit", "prîmes", "prîtes", "prirent",
      "prise", "prises", "prenant",
    ],
  },
  {
    base: "mettre",
    forms: [
      "mets", "met", "mettons", "mettez", "mettent",
      "mettais", "mettait", "mettions", "mettiez", "mettaient",
      "mettrai", "mettras", "mettra", "mettrons", "mettrez", "mettront",
      "mettrais", "mettrait", "mettrions", "mettriez", "mettraient",
      "mette", "mettes", "mettions", "mettiez", "mettent",
      "mis", "mit", "mîmes", "mîtes", "mirent",
      "mise", "mises", "mettant",
    ],
  },
  {
    base: "dire",
    forms: [
      "dis", "dit", "disons", "dites", "disent",
      "disais", "disait", "disions", "disiez", "disaient",
      "dirai", "diras", "dira", "dirons", "direz", "diront",
      "dirais", "dirait", "dirions", "diriez", "diraient",
      "dise", "dises", "disions", "disiez", "disent",
      "dîmes", "dîtes", "dirent",
      "dite", "dits", "dites", "disant",
    ],
  },
];

function buildFrenchIrregularBaseMap(): Record<string, string[]> {
  const mapping = new Map<string, Set<string>>();

  const addMapping = (form: string, base: string) => {
    const normalizedForm = normalizeWord(form, "french");
    const keys = new Set<string>([normalizedForm, foldNormalizedWord(normalizedForm)]);
    for (const key of keys) {
      const existing = mapping.get(key) ?? new Set<string>();
      existing.add(base);
      mapping.set(key, existing);
    }
  };

  for (const [form, bases] of Object.entries(FRENCH_MANUAL_IRREGULAR_BASES)) {
    for (const base of bases) {
      addMapping(form, base);
    }
  }

  for (const paradigm of FRENCH_IRREGULAR_PARADIGMS) {
    for (const form of paradigm.forms) {
      addMapping(form, paradigm.base);
    }
  }

  return Object.fromEntries(
    Array.from(mapping.entries(), ([form, bases]) => [form, Array.from(bases)]),
  );
}

const FRENCH_IRREGULAR_BASES = buildFrenchIrregularBaseMap();

function getLemmaTargets(
  word: string,
  language: SupportedLanguage,
  store: LanguageVocabStore,
): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];

  const exact = store.lemmaMap.get(word);
  if (exact) {
    seen.add(exact);
    targets.push(exact);
  }

  for (const candidate of store.lemmaFoldedIndex.get(foldWord(word, language)) ?? []) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    targets.push(candidate);
  }

  return targets;
}

function addRecursiveLemmaCandidates(
  word: string,
  language: SupportedLanguage,
  store: LanguageVocabStore | undefined,
  add: (candidate: string, source: StemCandidateSource) => void,
  maxDepth: number = 3,
): void {
  if (!store) return;

  const visited = new Set<string>([word]);
  let frontier = [word];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const target of getLemmaTargets(current, language, store)) {
        if (visited.has(target)) continue;
        visited.add(target);
        add(target, "lemma");
        next.push(target);
      }
    }
    frontier = next;
  }
}

function storeHasCandidate(
  store: LanguageVocabStore,
  candidate: string,
): boolean {
  if (store.dictMap.has(candidate) || store.frequencyRanks.has(candidate) || store.lemmaMap.has(candidate)) {
    return true;
  }

  const folded = foldNormalizedWord(candidate);
  return store.dictFoldedIndex.has(folded) || store.lemmaFoldedIndex.has(folded);
}

function hasFrequencyCandidate(
  store: LanguageVocabStore,
  candidate: string,
): boolean {
  const rank = store.frequencyRanks.get(candidate);
  return rank !== undefined && rank <= store.frequencyLimit;
}

function getDictionaryMatches(
  store: LanguageVocabStore,
  candidate: string,
  language: SupportedLanguage,
): DictionaryMatch[] {
  const seen = new Set<string>();
  const matches: DictionaryMatch[] = [];

  const exactDefinition = store.dictMap.get(candidate);
  if (exactDefinition) {
    seen.add(candidate);
    matches.push({
      word: candidate,
      definition: exactDefinition,
      kind: "exact",
    });
  }

  for (const actualWord of store.dictFoldedIndex.get(foldWord(candidate, language)) ?? []) {
    if (seen.has(actualWord)) continue;
    const definition = store.dictMap.get(actualWord);
    if (!definition) continue;
    seen.add(actualWord);
    matches.push({
      word: actualWord,
      definition,
      kind: actualWord === candidate ? "exact" : "folded",
    });
  }

  return matches;
}

export function loadFrequencyList(language: SupportedLanguage, words: string[]): void {
  const store = ensureStore(language);
  store.frequencyRanks = new Map();
  words.forEach((word, index) => {
    const normalizedWord = normalizeWord(word, language);
    if (!store.frequencyRanks.has(normalizedWord)) {
      store.frequencyRanks.set(normalizedWord, index + 1);
    }
  });
  store.frequencyLimit = words.length;
}

export function setFrequencyLimit(language: SupportedLanguage, limit: number): void {
  const store = ensureStore(language);
  const normalizedLimit = Math.max(DISABLED_VOCAB_LIMIT, Math.floor(limit));
  store.frequencyLimit = normalizedLimit;
}

export function isVocabularyHintsDisabled(language: SupportedLanguage): boolean {
  const store = stores.get(language);
  return !!store && store.frequencyLimit < 0;
}

export function loadDictionary(language: SupportedLanguage, entries: Record<string, string>): void {
  const store = ensureStore(language);
  store.dictMap = new Map();
  store.dictFoldedIndex = new Map();
  for (const [word, def] of Object.entries(entries)) {
    const normalizedWord = normalizeWord(word, language);
    store.dictMap.set(normalizedWord, def);
    pushIndexedValue(store.dictFoldedIndex, foldNormalizedWord(normalizedWord), normalizedWord);
  }
}

export function loadLemmaMap(language: SupportedLanguage, entries: Record<string, string>): void {
  const store = ensureStore(language);
  store.lemmaMap = new Map();
  store.lemmaFoldedIndex = new Map();
  for (const [variant, base] of Object.entries(entries)) {
    const normalizedVariant = normalizeWord(variant, language);
    const normalizedBase = normalizeWord(base, language);
    store.lemmaMap.set(normalizedVariant, normalizedBase);
    pushIndexedValue(store.lemmaFoldedIndex, foldNormalizedWord(normalizedVariant), normalizedBase);
  }
}

export function isLoaded(language: SupportedLanguage): boolean {
  const store = stores.get(language);
  return !!store && store.frequencyRanks.size > 0 && store.dictMap.size > 0;
}

function shouldSkipWord(
  word: string,
  language: SupportedLanguage,
  candidates: StemCandidate[] = getStemCandidateEntries(word, language),
): boolean {
  if (word.length < 3) return true;
  if (/^\d+$/u.test(word)) return true;
  if (candidates.some((candidate) => isBasicWord(candidate.word, language))) {
    return true;
  }

  if (language === "english") {
    if (word.includes("'")) return true;
    if (/[^a-zA-Z'-]/.test(word)) return true;
  }

  return false;
}

function createCandidateCollector(
  normalized: string,
  store: LanguageVocabStore | undefined,
  language: SupportedLanguage,
): { add: (candidate: string, source: StemCandidateSource) => void; values: StemCandidate[] } {
  const seen = new Set<string>();
  const values: StemCandidate[] = [];

  const add = (candidate: string, source: StemCandidateSource) => {
    if (!candidate || seen.has(candidate)) return;
    if (candidate.length < 2) return;

    if (
      source !== "exact" &&
      source !== "irregular" &&
      store &&
      !storeHasCandidate(store, candidate)
    ) {
      return;
    }

    seen.add(candidate);
    values.push({ word: candidate, source });
  };

  add(normalized, "exact");
  return { add, values };
}

function expandFrenchStemVariants(stem: string): string[] {
  const variants = new Set<string>([stem]);

  const lastGraveIdx = stem.lastIndexOf("è");
  if (lastGraveIdx >= 0) {
    variants.add(stem.slice(0, lastGraveIdx) + "e" + stem.slice(lastGraveIdx + 1));
    variants.add(stem.slice(0, lastGraveIdx) + "é" + stem.slice(lastGraveIdx + 1));
  }

  const lastAcuteIdx = stem.lastIndexOf("é");
  if (lastAcuteIdx >= 0) {
    variants.add(stem.slice(0, lastAcuteIdx) + "e" + stem.slice(lastAcuteIdx + 1));
  }

  const cedillaIdx = stem.lastIndexOf("ç");
  if (cedillaIdx >= 0) {
    variants.add(stem.slice(0, cedillaIdx) + "c" + stem.slice(cedillaIdx + 1));
  }

  return [...variants];
}

function addFrenchHeuristicCandidates(
  normalized: string,
  store: LanguageVocabStore | undefined,
  add: (candidate: string, source: StemCandidateSource) => void,
): void {
  for (const candidate of FRENCH_IRREGULAR_BASES[normalized] ?? []) {
    add(candidate, "irregular");
  }

  const suffixSwaps: Array<[string, string]> = [
    ["euses", "eur"],
    ["euse", "eur"],
    ["trices", "teur"],
    ["trice", "teur"],
    ["iennes", "ien"],
    ["ienne", "ien"],
    ["ennes", "en"],
    ["enne", "en"],
    ["elles", "el"],
    ["elle", "el"],
    ["ives", "if"],
    ["ive", "if"],
    ["ées", "é"],
    ["ée", "é"],
    ["ies", "i"],
    ["ie", "i"],
    ["aux", "al"],
    ["eaux", "eau"],
  ];

  for (const [suffix, replacement] of suffixSwaps) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length + 1) {
      add(normalized.slice(0, -suffix.length) + replacement, "heuristic");
    }
  }

  if (normalized.endsWith("es") && normalized.length > 4) {
    add(normalized.slice(0, -1), "heuristic");
    add(normalized.slice(0, -2), "heuristic");
  }
  if (normalized.endsWith("s") && normalized.length > 4) {
    add(normalized.slice(0, -1), "heuristic");
  }
  if (normalized.endsWith("x") && normalized.length > 4) {
    add(normalized.slice(0, -1), "heuristic");
  }

  const futureConditionalEndings = ["ai", "as", "a", "ons", "ez", "ont", "ais", "ait", "ions", "iez", "aient"];
  for (const ending of futureConditionalEndings) {
    if (!normalized.endsWith(ending) || normalized.length <= ending.length + 2) continue;
    const stem = normalized.slice(0, -ending.length);
    for (const stemVariant of expandFrenchStemVariants(stem)) {
      if (stemVariant.endsWith("er") || stemVariant.endsWith("ir")) {
        add(stemVariant, "heuristic");
      }
      if (stemVariant.endsWith("r")) {
        add(stemVariant + "e", "heuristic");
      }
    }
  }

  const thirdGroupIrEndings = ["s", "t", "ons", "ez", "ent", "ais", "ait", "ions", "iez", "aient"];
  for (const ending of thirdGroupIrEndings) {
    if (!normalized.endsWith(ending) || normalized.length <= ending.length + 2) continue;
    const stem = normalized.slice(0, -ending.length);
    for (const stemVariant of expandFrenchStemVariants(stem)) {
      add(stemVariant + "ir", "heuristic");
    }
  }

  const verbFamilies: Array<{ endings: string[]; infinitives: string[] }> = [
    {
      endings: ["e", "es", "ons", "ez", "ent", "ais", "ait", "ions", "iez", "aient"],
      infinitives: ["er"],
    },
    {
      endings: ["is", "it", "issons", "issez", "issent"],
      infinitives: ["ir"],
    },
    {
      endings: ["s", "t", "ons", "ez", "ent", "ais", "ait", "ions", "iez", "aient"],
      infinitives: ["re"],
    },
  ];

  for (const family of verbFamilies) {
    for (const ending of family.endings) {
      if (!normalized.endsWith(ending) || normalized.length <= ending.length + 1) continue;
      const stem = normalized.slice(0, -ending.length);
      for (const stemVariant of expandFrenchStemVariants(stem)) {
        for (const infinitive of family.infinitives) {
          add(stemVariant + infinitive, "heuristic");
          if (infinitive === "re") {
            if (stemVariant.endsWith("s") || stemVariant.endsWith("v")) {
              add(stemVariant.slice(0, -1) + "re", "heuristic");
            }
            if (stemVariant.endsWith("y")) {
              add(stemVariant.slice(0, -1) + "ire", "heuristic");
            }
          }
        }
      }
    }
  }

  addRecursiveLemmaCandidates(normalized, "french", store, add);
}

function getStemCandidateEntries(word: string, language: SupportedLanguage): StemCandidate[] {
  const normalized = normalizeWord(word, language);
  const store = stores.get(language);
  const { add, values } = createCandidateCollector(normalized, store, language);

  if (language === "english") {
    const mapped = store?.lemmaMap.get(normalized);
    if (mapped) {
      add(mapped, "lemma");
    }
    if (normalized.endsWith("ing") && normalized.length > 5) {
      const stem = normalized.slice(0, -3);
      add(stem, "heuristic");
      add(stem + "e", "heuristic");
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
        add(stem.slice(0, -1), "heuristic");
      }
    }

    if (normalized.endsWith("ed") && normalized.length > 4) {
      add(normalized.slice(0, -2), "heuristic");
      add(normalized.slice(0, -1), "heuristic");
      const stem = normalized.slice(0, -2);
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
        add(stem.slice(0, -1), "heuristic");
      }
      if (normalized.endsWith("ied")) {
        add(normalized.slice(0, -3) + "y", "heuristic");
      }
    }

    if (
      normalized.endsWith("ses") || normalized.endsWith("xes") || normalized.endsWith("zes") ||
      normalized.endsWith("ches") || normalized.endsWith("shes")
    ) {
      add(normalized.slice(0, -2), "heuristic");
    } else if (normalized.endsWith("ies") && normalized.length > 4) {
      add(normalized.slice(0, -3) + "y", "heuristic");
    } else if (normalized.endsWith("s") && !normalized.endsWith("ss") && normalized.length > 3) {
      add(normalized.slice(0, -1), "heuristic");
    }

    if (normalized.endsWith("ly") && normalized.length > 4) {
      add(normalized.slice(0, -2), "heuristic");
      if (normalized.endsWith("ally") && normalized.length > 6) {
        add(normalized.slice(0, -4), "heuristic");
        add(normalized.slice(0, -4) + "al", "heuristic");
      }
      if (normalized.endsWith("ily")) {
        add(normalized.slice(0, -3) + "y", "heuristic");
      }
    }
  } else {
    addFrenchHeuristicCandidates(normalized, store, add);
  }

  return values;
}

export function getStemCandidates(word: string, language: SupportedLanguage): string[] {
  return getStemCandidateEntries(word, language).map((candidate) => candidate.word);
}

export function isCommonWord(word: string, language: SupportedLanguage): boolean {
  const store = stores.get(language);
  if (!store || store.frequencyLimit < 0) return false;
  return getStemCandidateEntries(word, language).some((candidate) => hasFrequencyCandidate(store, candidate.word));
}

function getDefinitionQualityScore(definition: string): number {
  let score = 0;
  if (FORMATTED_DEFINITION_REGEX.test(definition)) score += 4;
  if (definition.includes("[AI]")) score += 0.5;
  if (definition.includes("；")) score += 0.2;
  return score;
}

function scoreFrenchMatch(
  exact: string,
  candidate: StemCandidate,
  match: DictionaryMatch,
): number {
  let score = getDefinitionQualityScore(match.definition);
  if (candidate.source === "exact") score += 0.25;
  if (candidate.source === "heuristic") score += 0.5;
  if (candidate.source === "lemma") score += 0.75;
  if (candidate.source === "irregular") score += 1;
  if (match.kind === "folded") score -= 0.1;
  if (match.word !== exact && FORMATTED_DEFINITION_REGEX.test(match.definition) && match.definition.startsWith("v.")) {
    score += 2;
  }
  return score;
}

function findBestFrenchDictionaryMatch(
  word: string,
  candidates: StemCandidate[],
  store: LanguageVocabStore,
  predicate: (entry: RankedFrenchMatch) => boolean = () => true,
): RankedFrenchMatch | null {
  const exact = normalizeWord(word, "french");
  let best: RankedFrenchMatch | null = null;

  for (const candidate of candidates) {
    for (const match of getDictionaryMatches(store, candidate.word, "french")) {
      const entry: RankedFrenchMatch = {
        candidate,
        match,
        definition: match.definition,
        score: scoreFrenchMatch(exact, candidate, match),
      };
      if (!predicate(entry)) continue;
      if (!best || entry.score > best.score) {
        best = entry;
      }
    }
  }

  return best;
}

function shouldBypassFrenchFrequencyFilter(
  word: string,
  candidates: StemCandidate[],
  store: LanguageVocabStore,
): boolean {
  const derivedBest = findBestFrenchDictionaryMatch(
    word,
    candidates,
    store,
    (entry) =>
      entry.candidate.word !== word &&
      !isBasicWord(entry.candidate.word, "french") &&
      entry.score >= 4.5,
  );
  if (!derivedBest) return false;

  const exactBest = findBestFrenchDictionaryMatch(
    word,
    candidates,
    store,
    (entry) => entry.candidate.word === word,
  );

  return derivedBest.score > (exactBest?.score ?? 0) + 2;
}

function lookupDictionary(
  word: string,
  language: SupportedLanguage,
  candidates: StemCandidate[] = getStemCandidateEntries(word, language),
): string | null {
  const store = stores.get(language);
  if (!store) return null;

  if (language !== "french") {
    for (const candidate of candidates) {
      const match = getDictionaryMatches(store, candidate.word, language)[0];
      if (match) return match.definition;
    }
    return null;
  }

  return findBestFrenchDictionaryMatch(word, candidates, store)?.definition ?? null;
}

export function annotateWords(
  text: string,
  knownWords: Set<string>,
  language: SupportedLanguage,
): VocabAnnotation[] {
  if (!isLoaded(language)) return [];
  if (isVocabularyHintsDisabled(language)) return [];

  const tokens = extractLookupWords(text, language);
  if (tokens.length === 0) return [];

  const seen = new Set<string>();
  const annotations: VocabAnnotation[] = [];
  const normalizedKnownWords = new Set(
    Array.from(knownWords, (word) => normalizeWord(word, language)),
  );

  for (const token of tokens) {
    const lower = token.word;
    if (seen.has(lower)) continue;
    seen.add(lower);

    const stemCandidates = getStemCandidateEntries(lower, language);

    if (shouldSkipWord(lower, language, stemCandidates)) continue;
    if (stemCandidates.some((candidate) => normalizedKnownWords.has(candidate.word))) continue;

    const store = stores.get(language);
    if (
      store &&
      stemCandidates.some((candidate) => hasFrequencyCandidate(store, candidate.word)) &&
      !(language === "french" && shouldBypassFrenchFrequencyFilter(lower, stemCandidates, store))
    ) {
      continue;
    }

    const definition = lookupDictionary(lower, language, stemCandidates);
    if (definition) {
      annotations.push({ word: lower, definition });
    }
  }

  return annotations;
}

export function toNewWordsFormat(
  annotations: VocabAnnotation[],
): { word: string; definition: string }[] {
  return annotations.map((annotation) => ({
    word: annotation.word,
    definition: annotation.definition,
  }));
}

export function resetAll(): void {
  stores.clear();
}
