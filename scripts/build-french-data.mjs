#!/usr/bin/env node
/**
 * 构建法语离线词库
 *
 * 数据源（可选组合）：
 * - french-words/french.txt
 * - FreeDict fra-zho 的 fra-zho.tei
 * - Kaikki 法语 Wiktionary raw dump（含中文翻译）
 *
 * 输出：
 * - data/word-frequency-fr.json
 * - data/dict-fr.json
 * - data/lemma-map-fr.json
 *
 * 用法：
 *   node scripts/build-french-data.mjs --words /path/to/french.txt --tei /path/to/fra-zho.tei
 *   node scripts/build-french-data.mjs --kaikki /tmp/frwiktionary.jsonl.gz
 *   node scripts/build-french-data.mjs --words /path/to/french.txt --tei /path/to/fra-zho.tei --kaikki /tmp/frwiktionary.jsonl.gz
 */

import { createReadStream, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createGunzip } from "zlib";
import { createInterface } from "readline";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const dataDir = join(rootDir, "data");

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const wordsPath = getArg("--words");
const teiPath = getArg("--tei");
const kaikkiPath = getArg("--kaikki");
const cfdictPath = getArg("--cfdict");

if ((wordsPath && !teiPath) || (!wordsPath && teiPath)) {
  console.error("`--words` 和 `--tei` 必须同时提供。");
  process.exit(1);
}

if (!wordsPath && !teiPath && !kaikkiPath && !cfdictPath) {
  console.error("至少需要提供 `--kaikki` / `--cfdict`，或同时提供 `--words` 和 `--tei`。");
  process.exit(1);
}

const SIMPLE_WORD_REGEX = /^[\p{L}]+(?:'[\p{L}]+)?$/u;
const FRENCH_ELISION_PREFIXES = new Set([
  "l", "d", "j", "m", "n", "s", "t", "c", "qu", "jusqu", "lorsqu", "puisqu", "quoiqu",
]);

const BASIC_WORDS = new Set([
  "a", "à", "au", "aux", "de", "du", "des", "la", "le", "les", "un", "une", "et", "ou", "mais",
  "donc", "or", "ni", "car", "dans", "sur", "sous", "avec", "sans", "pour", "par", "entre", "chez",
  "vers", "depuis", "comme", "que", "qui", "quoi", "dont", "où", "quand", "si", "ce", "cet", "cette",
  "ces", "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "me", "te", "se", "lui",
  "leur", "y", "en", "ne", "pas", "plus", "bien", "très", "tout", "tous", "toute", "toutes", "mon",
  "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "nos", "votre", "vos", "leurs",
  "être", "avoir", "faire", "aller", "dire", "voir", "savoir", "pouvoir", "vouloir", "venir", "devoir",
  "prendre", "donner", "mettre", "parler", "aimer", "trouver", "laisser", "arriver", "homme", "femme",
  "jour", "temps", "fois", "main", "œil", "vie",
]);

function decodeXml(value) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function normalize(value) {
  return decodeXml(value)
    .replace(/[’`´]/g, "'")
    .normalize("NFC")
    .trim();
}

function normalizeLower(value) {
  return normalize(value).toLocaleLowerCase("fr");
}

function normalizeLookup(value) {
  const normalized = normalizeLower(value);
  if (!normalized || !SIMPLE_WORD_REGEX.test(normalized)) return null;

  if (normalized.includes("'")) {
    const parts = normalized.split("'");
    if (parts.length === 2 && FRENCH_ELISION_PREFIXES.has(parts[0]) && parts[1].length >= 2) {
      return parts[1];
    }
  }

  return normalized;
}

function isSingleWordEntry(rawWord) {
  return !/[\s\-–—\d]/u.test(rawWord);
}

function mapPos(pos) {
  if (pos === "n") return "n.";
  if (pos === "v") return "v.";
  if (pos === "adj") return "adj.";
  if (pos === "adv") return "adv.";
  return "";
}

function mapKaikkiPos(pos) {
  if (pos === "noun" || pos === "name") return "n.";
  if (pos === "verb") return "v.";
  if (pos === "adj") return "adj.";
  if (pos === "adv") return "adv.";
  if (pos === "prep") return "prep.";
  if (pos === "pron") return "pron.";
  if (pos === "intj") return "int.";
  return "";
}

function readJson(filepath) {
  return JSON.parse(readFileSync(resolve(filepath), "utf8"));
}

function hasHan(text) {
  return /[\p{Script=Han}]/u.test(text);
}

const CFDICT_STOP_WORDS = new Set([
  "de", "du", "des", "la", "le", "les", "un", "une", "et", "ou", "à", "au", "aux", "en",
  "dans", "sur", "sous", "pour", "par", "avec", "sans", "chez", "entre", "vers", "comme",
  "que", "qui", "dont", "où", "quand", "si", "se", "sa", "son", "ses", "leur", "leurs",
  "nos", "vos", "mon", "ma", "mes", "ton", "ta", "tes",
]);

function readDictionary(teiFilepath) {
  const xml = readFileSync(resolve(teiFilepath), "utf8");
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const dict = new Map();

  for (const entry of entries) {
    const orthMatch = entry.match(/<orth>([\s\S]*?)<\/orth>/);
    if (!orthMatch) continue;

    const rawOrth = normalize(orthMatch[1]);
    if (!rawOrth || !isSingleWordEntry(rawOrth)) continue;
    if (/^[A-ZÀ-ÖØ-Þ]/u.test(rawOrth)) continue;

    const word = normalizeLookup(rawOrth);
    if (!word || word.length < 3 || BASIC_WORDS.has(word)) continue;

    const pos = normalize((entry.match(/<pos>([\s\S]*?)<\/pos>/) || ["", ""])[1]);
    const quotes = [...entry.matchAll(/<cit[^>]*type="trans"[^>]*xml:lang="zh"[^>]*>[\s\S]*?<\/cit>/g)]
      .flatMap((match) => [...match[0].matchAll(/<quote>([\s\S]*?)<\/quote>/g)].map((quote) => normalize(quote[1])))
      .filter(Boolean);

    if (quotes.length === 0) continue;

    const uniqueQuotes = [];
    const seenQuotes = new Set();
    for (const quote of quotes) {
      const key = quote.replace(/\s+/g, "");
      if (seenQuotes.has(key)) continue;
      seenQuotes.add(key);
      uniqueQuotes.push(quote);
      if (uniqueQuotes.length >= 2) break;
    }

    if (uniqueQuotes.length === 0) continue;

    const definition = `${mapPos(pos)} ${uniqueQuotes.join("；")}`.trim();
    const existing = dict.get(word);
    if (!existing || definition.length < existing.length) {
      dict.set(word, definition);
    }
  }

  return dict;
}

function readWordRows(wordsFilepath) {
  return readFileSync(resolve(wordsFilepath), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [rawWord, pos, rawLemma, freqLexique, freqNgram] = line.split("\t");
      return { rawWord, pos, rawLemma, freqLexique, freqNgram };
    });
}

function buildFrequencyAndLemma(rows, dictionaryWords) {
  const scoreByLemma = new Map();
  const normalizedRows = [];

  for (const row of rows) {
    if (!row.rawWord || /^[A-ZÀ-ÖØ-Þ]/u.test(row.rawWord)) continue;

    const word = normalizeLookup(row.rawWord);
    const lemma = normalizeLookup(row.rawLemma || row.rawWord);
    if (!word || !lemma || word.length < 2 || lemma.length < 2) continue;

    const score = Number(row.freqLexique || row.freqNgram || 0);
    normalizedRows.push({ word, lemma, score });

    if (score > 0 && !BASIC_WORDS.has(lemma)) {
      scoreByLemma.set(lemma, (scoreByLemma.get(lemma) || 0) + score);
    }
  }

  const frequency = [...scoreByLemma.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 6000);

  const frequencySet = new Set(frequency);
  const lemmaMap = new Map();

  for (const row of normalizedRows) {
    if (row.word === row.lemma) continue;
    if (!frequencySet.has(row.lemma) && !dictionaryWords.has(row.lemma)) continue;
    if (!lemmaMap.has(row.word)) {
      lemmaMap.set(row.word, row.lemma);
    }
  }

  return { frequency, lemmaMap };
}

async function readKaikkiDictionary(filepath) {
  const dict = new Map();
  const input = createReadStream(resolve(filepath));
  const stream = filepath.endsWith(".gz") ? input.pipe(createGunzip()) : input;

  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let lines = 0;
  let parsed = 0;
  let added = 0;

  for await (const line of rl) {
    lines++;
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.lang_code !== "fr") continue;

    const word = normalizeLookup(entry.word || "");
    if (!word || word.length < 3 || BASIC_WORDS.has(word)) continue;
    if (!isSingleWordEntry(entry.word || "")) continue;
    if (/^[A-ZÀ-ÖØ-Þ]/u.test(entry.word || "")) continue;

    const translations = Array.isArray(entry.translations) ? entry.translations : [];
    const zhWords = [];
    const seen = new Set();

    for (const item of translations) {
      const langCode = normalize(String(item?.lang_code || ""));
      if (!(langCode === "zh" || langCode === "cmn" || langCode.startsWith("zh-"))) continue;

      const raw = normalize(String(item?.word || ""));
      if (!raw || !hasHan(raw)) continue;

      const dedupeKey = raw.replace(/\s+/g, "");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      zhWords.push(raw);
      if (zhWords.length >= 4) break;
    }

    if (zhWords.length === 0) continue;

    parsed++;
    const definition = `${mapKaikkiPos(String(entry.pos || ""))} ${zhWords.join("；")}`.trim();
    const existing = dict.get(word);
    if (!existing || definition.length < existing.length) {
      dict.set(word, definition);
      if (!existing) added++;
    }
  }

  return { dict, stats: { lines, parsed, added } };
}

function cleanCFDictSegment(segment) {
  return segment
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[“”"«»!?]/g, " ")
    .replace(/\b(?:qqn|qqch|sth|sb)\b/gi, " ")
    .trim();
}

function extractCFDictCandidates(segment) {
  const cleaned = cleanCFDictSegment(segment);
  if (!cleaned) return [];

  const normalized = cleaned.toLocaleLowerCase("fr").normalize("NFC");
  const tokens = normalized
    .split(/\s+/)
    .map((token) => normalizeLookup(token))
    .filter((token) => token && !token.includes("-") && !CFDICT_STOP_WORDS.has(token));

  if (tokens.length === 1) return tokens;
  if (tokens.length === 2 && tokens[0].length >= 4 && tokens[1].length >= 4) return tokens;
  return [];
}

function readCFDictDictionary(filepath) {
  const raw = execFileSync("unzip", ["-p", resolve(filepath), "cfdict.u8"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  const dict = new Map();
  let lines = 0;
  let parsed = 0;

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    lines++;

    const match = line.match(/^\S+\s+(\S+)\s+\[[^\]]*\]\s+\/(.*)\/$/);
    if (!match) continue;

    const zh = normalize(match[1]);
    const glosses = match[2].split("/");

    for (const gloss of glosses) {
      for (const segment of gloss.split(/[;,]/)) {
        for (const candidate of extractCFDictCandidates(segment)) {
          if (!candidate || candidate.length < 3 || BASIC_WORDS.has(candidate)) continue;
          parsed++;
          const existing = dict.get(candidate);
          if (!existing) {
            dict.set(candidate, zh);
            continue;
          }

          const values = existing.split("；");
          if (!values.includes(zh) && values.length < 4) {
            dict.set(candidate, `${existing}；${zh}`);
          }
        }
      }
    }
  }

  return { dict, stats: { lines, parsed, added: dict.size } };
}

let dictionary;
let frequency;
let lemmaMap;

if (wordsPath && teiPath) {
  dictionary = readDictionary(teiPath);
  const rows = readWordRows(wordsPath);
  const built = buildFrequencyAndLemma(rows, new Set(dictionary.keys()));
  frequency = built.frequency;
  lemmaMap = built.lemmaMap;
} else {
  dictionary = new Map(Object.entries(readJson(join(dataDir, "dict-fr.json"))));
  frequency = readJson(join(dataDir, "word-frequency-fr.json"));
  lemmaMap = new Map(Object.entries(readJson(join(dataDir, "lemma-map-fr.json"))));
}

let kaikkiStats = null;
if (kaikkiPath) {
  const { dict: kaikkiDict, stats } = await readKaikkiDictionary(kaikkiPath);
  kaikkiStats = stats;
  let merged = 0;
  for (const [word, def] of kaikkiDict.entries()) {
    if (!dictionary.has(word)) {
      dictionary.set(word, def);
      merged++;
    }
  }
  kaikkiStats.merged = merged;
}

let cfdictStats = null;
if (cfdictPath) {
  const { dict: cfdictDict, stats } = readCFDictDictionary(cfdictPath);
  cfdictStats = stats;
  let merged = 0;
  for (const [word, def] of cfdictDict.entries()) {
    if (!dictionary.has(word)) {
      dictionary.set(word, def);
      merged++;
    }
  }
  cfdictStats.merged = merged;
}

writeFileSync(
  join(dataDir, "word-frequency-fr.json"),
  JSON.stringify(frequency, null, 2) + "\n",
);

writeFileSync(
  join(dataDir, "dict-fr.json"),
  JSON.stringify(Object.fromEntries([...dictionary.entries()].sort(([a], [b]) => a.localeCompare(b, "fr"))), null, 2) + "\n",
);

writeFileSync(
  join(dataDir, "lemma-map-fr.json"),
  JSON.stringify(Object.fromEntries([...lemmaMap.entries()].sort(([a], [b]) => a.localeCompare(b, "fr"))), null, 2) + "\n",
);

console.log(`Built French data:
- frequency: ${frequency.length}
- dictionary: ${dictionary.size}
- lemma map: ${lemmaMap.size}`);

if (kaikkiStats) {
  console.log(`Kaikki merge:
- parsed lines: ${kaikkiStats.lines}
- accepted entries: ${kaikkiStats.parsed}
- unique kaikki headwords: ${kaikkiStats.added}
- merged into dict: ${kaikkiStats.merged}`);
}

if (cfdictStats) {
  console.log(`CFDICT merge:
- parsed lines: ${cfdictStats.lines}
- extracted mappings: ${cfdictStats.parsed}
- unique cfdict headwords: ${cfdictStats.added}
- merged into dict: ${cfdictStats.merged}`);
}
