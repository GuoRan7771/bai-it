import { normalizeWord, splitByWholeWordMatches } from "../../shared/language.ts";
import type { SupportedLanguage } from "../../shared/types.ts";
import { useMasteredWords } from "../hooks/useMasteredWords.ts";

interface ChunkLinesProps {
  chunked: string;
  newWords?: { word: string; definition: string }[];
  language?: SupportedLanguage;
}

export function ChunkLines({ chunked, newWords = [], language = "english" }: ChunkLinesProps) {
  const { isMastered } = useMasteredWords();

  const defMap = new Map<string, string>();
  const vocabSet = new Set<string>();
  for (const w of newWords) {
    const normalized = normalizeWord(w.word, language);
    vocabSet.add(normalized);
    defMap.set(normalized, w.definition);
  }

  const lines = chunked.split("\n");

  return (
    <div className="chunk-lines">
      {lines.map((line, i) => {
        const trimmed = line.replace(/^ +/, "");
        const indent = line.length - trimmed.length;
        const isIndented = indent > 0;

        const parts = highlightVocab(trimmed, vocabSet, defMap, language, isMastered);

        return (
          <div key={i} className={isIndented ? "indent" : ""}>
            {parts}
          </div>
        );
      })}
    </div>
  );
}

function highlightVocab(
  text: string,
  vocabSet: Set<string>,
  defMap: Map<string, string>,
  language: SupportedLanguage,
  isMastered: (word: string, language?: SupportedLanguage) => boolean,
): React.ReactNode[] {
  if (vocabSet.size === 0) return [text];

  const parts: React.ReactNode[] = [];
  for (const part of splitByWholeWordMatches(text, Array.from(vocabSet))) {
    if (!part.matched) {
      if (part.text) parts.push(part.text);
      continue;
    }
    const normalizedWord = normalizeWord(part.text, language);
    const mastered = isMastered(normalizedWord, language);
    const def = defMap.get(normalizedWord) || "";
    parts.push(
      <span
        key={`${normalizedWord}-${parts.length}`}
        className={mastered ? "vocab vocab-mastered" : "vocab"}
        data-word={normalizedWord}
        data-def={def}
        data-lang={language}
      >
        {part.text}
      </span>
    );
  }

  return parts.length > 0 ? parts : [text];
}
