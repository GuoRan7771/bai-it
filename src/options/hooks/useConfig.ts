import { useState, useEffect, useCallback } from "react";
import type { BaitConfig, LLMMultiConfig } from "../../shared/types.ts";
import { DEFAULT_CONFIG, migrateLLMConfig } from "../../shared/types.ts";

function normalizeVocabularySize(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(-1, Math.min(max, Math.round(numeric)));
}

export function useConfig() {
  const [config, setConfig] = useState<BaitConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    chrome.storage.sync.get(Object.keys(DEFAULT_CONFIG), (items) => {
      const raw = items as unknown as BaitConfig;
      // 补全缺失字段
      const merged: BaitConfig = {
        ...DEFAULT_CONFIG,
        ...raw,
        llm: migrateLLMConfig(raw.llm),
      };
      if (!Array.isArray(merged.disabledSites)) merged.disabledSites = [];
      merged.englishVocabularySize = normalizeVocabularySize(
        merged.englishVocabularySize,
        DEFAULT_CONFIG.englishVocabularySize,
        5806,
      );
      merged.frenchVocabularySize = normalizeVocabularySize(
        merged.frenchVocabularySize,
        DEFAULT_CONFIG.frenchVocabularySize,
        6000,
      );
      setConfig(merged);
      setLoading(false);
    });
  }, []);

  const updateLLM = useCallback(async (partial: Partial<LLMMultiConfig>) => {
    setConfig((prev) => {
      const llm = { ...prev.llm, ...partial };
      if (partial.providers) {
        llm.providers = { ...prev.llm.providers, ...partial.providers };
      }
      const updated = { ...prev, llm };
      chrome.storage.sync.set(updated as Record<string, unknown>);
      return updated;
    });
  }, []);

  return { config, loading, updateLLM };
}
