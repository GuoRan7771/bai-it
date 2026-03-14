import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { vocabDAO } from "../../shared/db.ts";
import {
  getLanguageFromMasteredKey,
  getMasteredWordKey,
  getWordFromMasteredKey,
  normalizeWord,
} from "../../shared/language.ts";
import type { SupportedLanguage } from "../../shared/types.ts";

interface MasteredWordsContextValue {
  masteredWords: Set<string>;
  isMastered: (word: string, language?: SupportedLanguage) => boolean;
  toggleMastered: (word: string, language?: SupportedLanguage) => void;
}

const defaultValue: MasteredWordsContextValue = {
  masteredWords: new Set(),
  isMastered: () => false,
  toggleMastered: () => {},
};

export const MasteredWordsContext = createContext<MasteredWordsContextValue>(defaultValue);

export function useMasteredWordsProvider(db: IDBDatabase | null) {
  const [masteredWords, setMasteredWords] = useState<Set<string>>(new Set());
  const setRef = useRef(masteredWords);
  setRef.current = masteredWords;

  // Load from chrome.storage.local on mount
  useEffect(() => {
    chrome.storage.local.get({ knownWordsByLanguage: null, knownWords: [] }, (result) => {
      const next = new Set<string>();
      const byLanguage = result.knownWordsByLanguage as Record<string, unknown> | null;
      if (byLanguage && typeof byLanguage === "object") {
        for (const language of ["english", "french"] as const) {
          const words = byLanguage[language];
          if (!Array.isArray(words)) continue;
          for (const word of words) {
            if (typeof word === "string") {
              next.add(getMasteredWordKey(language, word));
            }
          }
        }
      } else {
        const words = result.knownWords as string[];
        for (const word of words) {
          next.add(getMasteredWordKey("english", word));
        }
      }
      if (next.size > 0) {
        setMasteredWords(next);
      }
    });
  }, []);

  const persist = useCallback((set: Set<string>) => {
    const payload: Record<SupportedLanguage, string[]> = {
      english: [],
      french: [],
    };
    for (const key of set) {
      const language = getLanguageFromMasteredKey(key);
      if (!language) continue;
      payload[language].push(getWordFromMasteredKey(key));
    }
    chrome.storage.local.set({ knownWordsByLanguage: payload });
  }, []);

  const isMastered = useCallback((word: string, language: SupportedLanguage = "english") => {
    return setRef.current.has(getMasteredWordKey(language, word));
  }, []);

  const toggleMastered = useCallback(
    (word: string, language: SupportedLanguage = "english") => {
      const normalizedWord = normalizeWord(word, language);
      const key = getMasteredWordKey(language, normalizedWord);
      const current = setRef.current;
      const next = new Set(current);
      const wasMastered = current.has(key);

      if (wasMastered) {
        next.delete(key);
      } else {
        next.add(key);
      }

      setMasteredWords(next);
      persist(next);

      // Sync to IndexedDB if available
      if (db) {
        vocabDAO.getByWord(db, normalizedWord).then((record) => {
          if (record) {
            if (wasMastered) {
              vocabDAO.update(db, record.id, { status: "new", mastered_at: undefined });
            } else {
              vocabDAO.markMastered(db, record.id);
            }
          }
        });
      }
    },
    [db, persist]
  );

  return { masteredWords, isMastered, toggleMastered };
}

export function useMasteredWords(): MasteredWordsContextValue {
  return useContext(MasteredWordsContext);
}
