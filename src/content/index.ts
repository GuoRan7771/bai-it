/**
 * Content Script — 页面注入
 *
 * 职责：
 * 1. 统一扫读：所有英文网页自动本地拆分 + 标注生词
 * 2. 手动掰句：未拆开的句子挂触发按钮（无 API → 本地强制拆，有 API → LLM）
 * 3. 分块结果注入 DOM
 * 4. MutationObserver 监听动态内容
 */

import { isEnglish } from "../shared/rule-engine.ts";
import { scanSplit, toChunkedString } from "../shared/scan-rules.ts";
import {
  loadFrequencyList, loadDictionary, loadLemmaMap,
  annotateWords, toNewWordsFormat, isLoaded,
} from "../shared/vocab.ts";
import type { BaitConfig, ChunkResult, BackgroundMessage } from "../shared/types.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import { createChunkedElement } from "./renderer.ts";
import { ENLEARN_STYLES } from "./styles.ts";

// ========== 词汇数据（构建时打包）==========

import wordFrequency from "../../data/word-frequency.json";
import dictEntries from "../../data/dict-ecdict.json";
import lemmaEntries from "../../data/lemma-map.json";

// ========== 状态 ==========

let config: BaitConfig = { ...DEFAULT_CONFIG };
let isActive = false;
let isPaused = false;
let processedElements = new WeakSet<Element>();
const pendingElements = new Map<Element, string>();
let intersectionObserver: IntersectionObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let processTimer: ReturnType<typeof setTimeout> | null = null;
const processQueue: Element[] = [];
const knownWords = new Set<string>(); // 用户已掌握的词（从 storage 加载）

// ========== 全局 Tooltip ==========

let tooltipEl: HTMLElement | null = null;

let tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
let currentTooltipWord: string | null = null;

function setupTooltip(): void {
  if (tooltipEl) return;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "enlearn-tooltip";
  document.body.appendChild(tooltipEl);

  // Keep tooltip visible when hovering the tooltip itself
  tooltipEl.addEventListener("mouseenter", () => {
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  });
  tooltipEl.addEventListener("mouseleave", () => {
    scheduleHideTooltip();
  });
  tooltipEl.addEventListener("click", onTooltipClick);

  document.addEventListener("mouseover", onWordHover);
  document.addEventListener("mouseout", onWordLeave);
  document.addEventListener("mouseover", onTriggerParentHover);
  document.addEventListener("mouseout", onTriggerParentLeave);
}

function scheduleHideTooltip(): void {
  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(() => {
    if (tooltipEl) tooltipEl.style.display = "none";
    currentTooltipWord = null;
    tooltipHideTimer = null;
  }, 150);
}

async function onTooltipClick(e: MouseEvent): Promise<void> {
  const btn = (e.target as Element).closest?.(".enlearn-tooltip-btn");
  if (!btn || !currentTooltipWord) return;

  const word = currentTooltipWord;
  knownWords.add(word);

  // Save to storage
  try {
    await chrome.storage.local.set({ knownWords: [...knownWords] });
  } catch { /* silent */ }

  // Remove all annotations for this word on current page
  document.querySelectorAll(`.enlearn-word`).forEach(el => {
    if ((el as HTMLElement).dataset.word?.toLowerCase() === word) {
      const text = document.createTextNode(el.textContent || "");
      el.parentNode?.replaceChild(text, el);
    }
  });

  // Hide tooltip
  if (tooltipEl) tooltipEl.style.display = "none";
  currentTooltipWord = null;
}

function onWordHover(e: MouseEvent): void {
  const wordEl = (e.target as Element).closest?.(".enlearn-word") as HTMLElement | null;
  if (!wordEl || !tooltipEl) return;

  const def = wordEl.getAttribute("data-def");
  if (!def) return;

  // Cancel any pending hide
  if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }

  currentTooltipWord = (wordEl.dataset.word || wordEl.textContent || "").toLowerCase();
  tooltipEl.innerHTML = `<span class="enlearn-tooltip-def">${escapeHtml(def)}</span><button class="enlearn-tooltip-btn" title="标记为已掌握">✓</button>`;
  tooltipEl.style.display = "flex";

  const wordRect = wordEl.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();

  let left = wordRect.left + wordRect.width / 2 - tipRect.width / 2;
  let top = wordRect.top - tipRect.height - 6;

  if (left < 4) left = 4;
  if (left + tipRect.width > window.innerWidth - 4) {
    left = window.innerWidth - 4 - tipRect.width;
  }
  if (top < 4) {
    top = wordRect.bottom + 6;
  }

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function onWordLeave(e: MouseEvent): void {
  const word = (e.target as Element).closest?.(".enlearn-word");
  if (!word || !tooltipEl) return;
  scheduleHideTooltip();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function onTriggerParentHover(e: MouseEvent): void {
  const el = e.target as Element;
  const wrap = el.closest?.(".enlearn-trigger-wrap, [data-enlearn-trigger]");
  if (!wrap) return;
  const trigger = wrap.querySelector(".enlearn-trigger");
  if (trigger) trigger.classList.add("enlearn-trigger-visible");
}

function onTriggerParentLeave(e: MouseEvent): void {
  const el = e.target as Element;
  const wrap = el.closest?.(".enlearn-trigger-wrap, [data-enlearn-trigger]");
  if (!wrap) return;
  const related = e.relatedTarget as Element | null;
  if (related && wrap.contains(related)) return;
  const trigger = wrap.querySelector(".enlearn-trigger");
  if (trigger) trigger.classList.remove("enlearn-trigger-visible");
}

// ========== 初始化 ==========

async function init(): Promise<void> {
  const style = document.createElement("style");
  style.textContent = ENLEARN_STYLES;
  style.id = "enlearn-styles";
  document.head.appendChild(style);

  setupTooltip();

  // 加载词汇数据
  loadFrequencyList(wordFrequency as string[]);
  loadDictionary(dictEntries as Record<string, string>);
  loadLemmaMap(lemmaEntries as Record<string, string>);

  // 加载用户已掌握的词
  try {
    const stored = await chrome.storage.local.get({ knownWords: [] });
    if (Array.isArray(stored.knownWords)) {
      for (const w of stored.knownWords) knownWords.add(w as string);
    }
  } catch {
    // 静默失败
  }

  config = await sendMessage({ type: "getConfig" }) as BaitConfig;

  const response = await sendMessage({ type: "checkActive" }) as { active: boolean };
  if (response.active) {
    activate();
  }

  chrome.runtime.onMessage.addListener((message: BackgroundMessage) => {
    if (message.type === "activate") activate();
    else if (message.type === "deactivate") deactivate();
    else if (message.type === "pause") pauseProcessing();
    else if (message.type === "resume") resumeProcessing();
  });
}

// ========== 激活 ==========

function activate(): void {
  if (isActive) return;
  isActive = true;

  setupIntersectionObserver();
  scanPage();
  setupMutationObserver();

  chrome.storage.onChanged.addListener(onStorageChanged);
}

// ========== 停用 ==========

function deactivate(): void {
  if (!isActive) return;
  isActive = false;

  intersectionObserver?.disconnect();
  intersectionObserver = null;
  mutationObserver?.disconnect();
  mutationObserver = null;

  processQueue.length = 0;
  if (processTimer) {
    clearTimeout(processTimer);
    processTimer = null;
  }
  pendingElements.clear();

  restoreProcessedElements();

  // 移除手动触发按钮
  document.querySelectorAll(".enlearn-trigger").forEach(t => t.remove());
  document.querySelectorAll("[data-enlearn-trigger]").forEach(w => {
    w.classList.remove("enlearn-trigger-wrap");
    w.removeAttribute("data-enlearn-trigger");
  });

  processedElements = new WeakSet<Element>();
  chrome.storage.onChanged.removeListener(onStorageChanged);
}

// ========== 暂停 / 恢复 ==========

function pauseProcessing(): void {
  if (!isActive || isPaused) return;
  isPaused = true;
  mutationObserver?.disconnect();
  intersectionObserver?.disconnect();
  processQueue.length = 0;
  if (processTimer) {
    clearTimeout(processTimer);
    processTimer = null;
  }

  // 暂停：隐藏分块 + 显示原文（用 JS 直接操作，不依赖 CSS body 级规则）
  document.querySelectorAll(".enlearn-chunked").forEach(el => {
    (el as HTMLElement).style.setProperty("display", "none", "important");
  });
  document.querySelectorAll(".enlearn-trigger").forEach(el => {
    (el as HTMLElement).style.setProperty("display", "none", "important");
  });
  document.querySelectorAll(".enlearn-original-hidden").forEach(el => {
    (el as HTMLElement).style.removeProperty("display");
    el.classList.remove("enlearn-original-hidden");
    el.classList.add("enlearn-was-hidden");
  });
}

function resumeProcessing(): void {
  if (!isActive || !isPaused) return;
  isPaused = false;

  // 恢复：重新隐藏原文 + 显示分块
  document.querySelectorAll(".enlearn-was-hidden").forEach(el => {
    (el as HTMLElement).style.setProperty("display", "none", "important");
    el.classList.add("enlearn-original-hidden");
    el.classList.remove("enlearn-was-hidden");
  });
  document.querySelectorAll(".enlearn-chunked").forEach(el => {
    (el as HTMLElement).style.removeProperty("display");
  });
  document.querySelectorAll(".enlearn-trigger").forEach(el => {
    (el as HTMLElement).style.removeProperty("display");
  });

  // 恢复时用新配置重新处理
  reprocessPage();

  setupIntersectionObserver();
  setupMutationObserver();
}

/**
 * 清除所有已渲染的分块，重置处理状态，用当前配置重新扫描页面
 */
function reprocessPage(): void {
  restoreProcessedElements();

  // 移除手动触发按钮
  document.querySelectorAll(".enlearn-trigger").forEach(t => t.remove());
  document.querySelectorAll("[data-enlearn-trigger]").forEach(w => {
    w.classList.remove("enlearn-trigger-wrap");
    w.removeAttribute("data-enlearn-trigger");
  });

  // 重置处理集合
  processedElements = new WeakSet<Element>();
  pendingElements.clear();
  processQueue.length = 0;
  if (processTimer) {
    clearTimeout(processTimer);
    processTimer = null;
  }

  // 重新扫描
  scanPage();
}

function onStorageChanged(changes: { [key: string]: chrome.storage.StorageChange }): void {
  let needReprocess = false;

  if (changes.chunkIntensity) {
    config.chunkIntensity = changes.chunkIntensity.newValue as number;
    needReprocess = true;
  }
  if (changes.chunkGranularity) {
    config.chunkGranularity = changes.chunkGranularity.newValue as typeof config.chunkGranularity;
    needReprocess = true;
  }
  if (changes.scanThreshold) {
    config.scanThreshold = changes.scanThreshold.newValue as typeof config.scanThreshold;
    needReprocess = true;
  }

  // 配置变更后用新配置重新处理页面
  if (needReprocess && isActive && !isPaused) {
    reprocessPage();
  }
}

// ========== URL 检测 ==========

const URL_PATTERN = /https?:\/\/\S+/;

/**
 * 过滤 URL 段落片段
 *
 * Twitter 等站点的 DOM 会把一条 URL 拆成多个 <span>（如 "https://"、
 * "claude.com/community/amba"、"ssador"、"…"），导致 innerText 产生
 * 多个短段落。这里检测以 "http(s)://" 开头的段落，并把后续的单词片段
 * （仅 1 个词的段落）一并过滤掉。
 */
function filterUrlParagraphs(paragraphs: string[]): string[] {
  const result: string[] = [];
  let inUrl = false;

  for (const para of paragraphs) {
    const trimmed = para.trim();

    // URL 起始
    if (/^https?:\/\//.test(trimmed)) {
      inUrl = true;
      continue; // 跳过
    }

    if (inUrl) {
      // 省略号标志 URL 结束
      if (/^[…⋯.]{1,3}$/.test(trimmed)) {
        inUrl = false;
        continue;
      }
      // 单词段落（无空格）→ 仍是 URL 片段
      if (!/\s/.test(trimmed)) {
        continue;
      }
      // 多词段落 → 不再是 URL 片段
      inUrl = false;
    }

    result.push(para);
  }

  return result;
}

// ========== 文本提取工具 ==========

/**
 * 从元素中提取段落列表，保留 <br> 产生的换行
 */
function extractParagraphs(el: Element): string[] {
  const text = (el as HTMLElement).innerText || el.textContent || "";
  return text.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * 将段落拆成句子（在 ". " + 大写字母处断开）
 */
function splitIntoSentences(paragraph: string): string[] {
  // 在句末标点 + 空格 + 大写字母/引号处拆分
  const parts = paragraph.split(/(?<=[.!?])\s+(?=[A-Z\u201C"'])/);
  return parts.filter(s => s.trim().length > 0);
}

/**
 * 从原始元素复制关键字体样式到分块元素
 */
function copyFontStyles(source: Element, target: HTMLElement): void {
  const computed = window.getComputedStyle(source);
  target.style.fontSize = computed.fontSize;
  target.style.fontFamily = computed.fontFamily;
  target.style.lineHeight = computed.lineHeight;
  target.style.color = computed.color;
  target.style.letterSpacing = computed.letterSpacing;
  target.style.wordSpacing = computed.wordSpacing;
}

/**
 * 将 chunked 元素插入 DOM，替换原文显示。
 *
 * 策略：隐藏原始元素 + 兄弟插入（沿用旧 Enlearn 方案）
 * - 原始元素 display:none（保留在 DOM 中，保留框架绑定）
 * - 分块内容作为下一个兄弟元素插入
 * - 不修改原始元素的子节点 → React Fiber / Lit 绑定全部正常
 * - 不 stopPropagation、不 dispatchEvent、不做站点特判
 */
function insertChunkedElement(
  originalEl: Element,
  chunkedEl: HTMLElement,
): void {
  // 1. 隐藏原始元素
  (originalEl as HTMLElement).style.setProperty("display", "none", "important");
  originalEl.classList.add("enlearn-original-hidden");
  // 2. 插入分块作为兄弟
  originalEl.parentNode?.insertBefore(chunkedEl, originalEl.nextSibling);

  // 3. 向上查找截断容器，用 inline style 覆盖
  //    - Reddit/Substack: -webkit-box + line-clamp
  //    - Twitter: overflow:hidden 截断长推文（"Show more" 按钮被裁剪）
  let current = originalEl.parentElement;
  for (let i = 0; i < 6 && current; i++) {
    const tag = current.tagName;
    if (tag === "A" || tag === "ARTICLE") break;
    if (current.getAttribute("role") === "article") break;

    const cls = current.className || "";
    const cs = window.getComputedStyle(current);

    const isWebkitBox =
      cls.includes("line-clamp") ||
      cls.includes("text-ellipsis") ||
      (cs.webkitLineClamp && cs.webkitLineClamp !== "none") ||
      cs.display === "-webkit-box" ||
      cs.display === "-webkit-inline-box";

    const isOverflowClip =
      (cs.overflow === "hidden" || cs.overflowY === "hidden") &&
      !isWebkitBox; // 避免重复处理

    if (isWebkitBox) {
      current.classList.add("enlearn-clamp-override");
      current.style.setProperty("-webkit-line-clamp", "unset", "important");
      current.style.setProperty("-webkit-box-orient", "unset", "important");
      current.style.setProperty("display", "block", "important");
      current.style.setProperty("max-height", "none", "important");
      current.style.setProperty("overflow", "visible", "important");
    } else if (isOverflowClip) {
      // Twitter 等站点：overflow:hidden 裁剪内容和 "Show more" 按钮
      current.classList.add("enlearn-clamp-override");
      current.style.setProperty("max-height", "none", "important");
      current.style.setProperty("overflow", "visible", "important");
    }
    current = current.parentElement;
  }
}

/**
 * 恢复所有处理过的元素（移除分块兄弟，显示原始元素）
 */
function restoreProcessedElements(): void {
  // 移除所有分块元素
  document.querySelectorAll(".enlearn-chunked").forEach(el => el.remove());

  // 恢复隐藏的原始元素（清除 inline style + class）
  document.querySelectorAll(".enlearn-original-hidden").forEach(el => {
    (el as HTMLElement).style.removeProperty("display");
    el.classList.remove("enlearn-original-hidden");
  });

  // 清理截断覆盖（清除 inline style + class）
  document.querySelectorAll(".enlearn-clamp-override").forEach(el => {
    (el as HTMLElement).style.removeProperty("-webkit-line-clamp");
    (el as HTMLElement).style.removeProperty("-webkit-box-orient");
    (el as HTMLElement).style.removeProperty("display");
    (el as HTMLElement).style.removeProperty("max-height");
    (el as HTMLElement).style.removeProperty("overflow");
    el.classList.remove("enlearn-clamp-override");
  });
}

// ========== 数据采集 ==========

function saveSentenceQuiet(text: string, manual: boolean, newWords: string[]): void {
  sendMessage({
    type: "saveSentence",
    text,
    source_url: window.location.href,
    source_hostname: window.location.hostname,
    manual,
    new_words: newWords,
  }).catch(() => {});
}

// ========== DOM 扫描 ==========

const DOM_SELECTORS = [
  // X / Twitter
  '[data-testid="tweetText"]',
  '[role="article"] div[lang="en"]',
  // Reddit
  '.Post-body p', '.Comment-body p',
  '[data-testid="post-content"] p',
  'shreddit-post [slot="text-body"] p',
  '[id^="t3_"][id$="-post-rtjson-content"] p',
  // Medium + articles
  'article p',
  // General
  'main p', '[role="main"] p',
  'div[data-block="true"]',
  'section p', '.content p', '.post p', '.entry-content p',
  '.article-body p', '#content p', '.page-content p',
].join(", ");

function scanPage(): void {
  if (!isActive || isPaused) return;

  const candidates = document.querySelectorAll(DOM_SELECTORS);

  for (const el of candidates) {
    if (processedElements.has(el)) continue;
    if (isEnlearnElement(el)) continue;
    if (el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="complementary"]')) continue;

    // 跳过包含更具体匹配的父容器
    // 例如 Twitter 上 div[lang="en"] 可能同时匹配 tweetText 和包裹它的父容器
    // 父容器被隐藏会连带隐藏 "Show more" 等兄弟按钮
    if (el.querySelector(DOM_SELECTORS)) continue;

    // 跳过已经被隐藏的元素内部的后代
    if (el.closest(".enlearn-original-hidden")) continue;

    const text = el.textContent?.trim() ?? "";
    if (text.length < 10) continue;
    if (!isEnglish(text)) continue;

    // 太短的文本不值得处理（短推文、标题等）
    if (text.split(/\s+/).length < 8) continue;

    // Twitter "Show more"：跳过未展开的推文，保留按钮让用户自己点
    // 原因：隐藏 tweetText 会让 React 重测量 scrollHeight，发现无溢出后删除按钮
    // 用户点击展开后，MutationObserver 检测到新内容会自动触发 scanPage 处理全文
    if (el.matches('[data-testid="tweetText"]')) {
      const showMoreBtn = el.parentElement?.querySelector(
        '[data-testid="tweet-text-show-more-link"]',
      );
      if (showMoreBtn) continue;
    }

    // 统一扫读：按段落/句子本地拆分
    processedElements.add(el);
    const paragraphs = filterUrlParagraphs(extractParagraphs(el));
    const allChunkedLines: string[] = [];
    let hasAnyChunks = false;

    for (let pi = 0; pi < paragraphs.length; pi++) {
      if (pi > 0) allChunkedLines.push(""); // 段落间空行

      const sentences = splitIntoSentences(paragraphs[pi]);
      for (const sentence of sentences) {
        // 跳过含 URL 的句子
        if (URL_PATTERN.test(sentence)) {
          allChunkedLines.push(sentence);
          continue;
        }
        const scanResult = scanSplit(sentence, config.scanThreshold, config.chunkGranularity);
        if (scanResult.chunks.length > 1) {
          hasAnyChunks = true;
          allChunkedLines.push(toChunkedString(scanResult.chunks));
        } else {
          allChunkedLines.push(sentence);
        }
      }
    }

    // 生词标注（不管是否拆分）
    const vocabAnnotations = isLoaded()
      ? annotateWords(text, knownWords)
      : [];

    // 收集生词列表（只要词）
    const sentenceNewWords = vocabAnnotations.map(a => a.word);

    if (hasAnyChunks) {
      // 有本地拆分结果 → 渲染（带生词标注）
      const chunkedString = allChunkedLines.join("\n");
      const chunkResult: ChunkResult = {
        original: text,
        chunked: chunkedString,
        isSimple: false,
        newWords: toNewWordsFormat(vocabAnnotations),
      };
      const chunkedEl = createChunkedElement(chunkResult, config.chunkIntensity);
      if (chunkedEl) {
        copyFontStyles(el, chunkedEl);
        insertChunkedElement(el, chunkedEl);
      }
    } else {
      // 没拆开 → 保留原始 DOM，只在原始元素上挂手动触发
      addManualTrigger(el, text);
    }

    // fire-and-forget 存句到 pending_sentences
    saveSentenceQuiet(text, false, sentenceNewWords);
  }
}

function isEnlearnElement(el: Element): boolean {
  return el.closest(".enlearn-chunked") !== null ||
    el.classList.contains("enlearn-chunked");
}

// ========== 手动触发 ==========

const TRIGGER_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="3" x2="13" y2="3"/><line x1="4" y1="7" x2="13" y2="7"/><line x1="7" y1="11" x2="13" y2="11"/></svg>`;

function addManualTrigger(el: Element, text: string): void {
  el.setAttribute("data-enlearn-trigger", "1");
  el.classList.add("enlearn-trigger-wrap");

  const btn = document.createElement("span");
  btn.className = "enlearn-trigger";
  btn.innerHTML = TRIGGER_ICON_SVG;
  btn.title = "掰开这句";

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();
    btn.classList.add("enlearn-trigger-loading");

    try {
      // 检查是否有 API key
      const keyCheck = await sendMessage({ type: "hasApiKey" }) as { hasKey: boolean };

      let result: ChunkResult | null = null;

      if (keyCheck.hasKey) {
        // 有 API → 发 LLM 深度分析
        const response = await sendMessage({
          type: "chunk",
          sentences: [text],
          source_url: window.location.href,
        }) as { results: ChunkResult[] } | null;

        if (response?.results?.[0] && !response.results[0].isSimple) {
          result = response.results[0];
        }
      } else {
        // 无 API → 本地强制拆分（最低阈值 + 最细颗粒度）
        const scanResult = scanSplit(text, "short", "fine");
        if (scanResult.chunks.length > 1) {
          const vocabAnnotations = isLoaded()
            ? annotateWords(text, knownWords)
            : [];
          result = {
            original: text,
            chunked: toChunkedString(scanResult.chunks),
            isSimple: false,
            newWords: toNewWordsFormat(vocabAnnotations),
          };
        }
      }

      if (result) {
        const chunkedEl = createChunkedElement(result, config.chunkIntensity);
        if (chunkedEl) {
          copyFontStyles(el, chunkedEl);
          insertChunkedElement(el, chunkedEl);
          btn.remove();

          // 手动触发 → 标记 manual: true
          const newWordsList = result.newWords?.map(w => w.word) ?? [];
          saveSentenceQuiet(text, true, newWordsList);
        }
      } else {
        // 拆不动 → 移除按钮
        btn.remove();
        el.classList.remove("enlearn-trigger-wrap");
        el.removeAttribute("data-enlearn-trigger");
      }
    } catch {
      btn.classList.remove("enlearn-trigger-loading");
    }
  });

  el.appendChild(btn);
}

// ========== Intersection Observer ==========

function setupIntersectionObserver(): void {
  intersectionObserver = new IntersectionObserver(
    (entries) => {
      const visibleElements: Element[] = [];
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visibleElements.push(entry.target);
          intersectionObserver?.unobserve(entry.target);
        }
      }
      if (visibleElements.length > 0) {
        processVisibleElements(visibleElements);
      }
    },
    { rootMargin: "100% 0px" }
  );
}

// ========== 批量处理 ==========

function processVisibleElements(elements: Element[]): void {
  processQueue.unshift(...elements);
  if (processTimer) clearTimeout(processTimer);
  processTimer = setTimeout(flushProcessQueue, 100);
}

async function flushProcessQueue(): Promise<void> {
  if (processQueue.length === 0 || !isActive) return;

  const batch = processQueue.splice(0, 5);
  const sentences: string[] = [];
  const elementMap = new Map<string, Element>();

  for (const el of batch) {
    const text = pendingElements.get(el);
    if (!text) continue;
    sentences.push(text);
    elementMap.set(text, el);
    pendingElements.delete(el);
  }

  if (sentences.length === 0) return;

  const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000));
  const chunkedTexts = new Set<string>();

  try {
    const responseOrTimeout = await Promise.race([
      sendMessage({
        type: "chunk",
        sentences,
        source_url: window.location.href,
      }),
      timeoutPromise,
    ]);

    if (responseOrTimeout) {
      const response = responseOrTimeout as { results: ChunkResult[] };

      for (const result of response.results) {
        const el = elementMap.get(result.original);
        if (!el) continue;

        if (result.isSimple) {
          // 不加入 chunkedTexts，让后面的 fallback 给它加手动触发按钮
          continue;
        }

        const chunkedEl = createChunkedElement(result, config.chunkIntensity);
        if (!chunkedEl) continue;

        copyFontStyles(el, chunkedEl);
        insertChunkedElement(el, chunkedEl);
        chunkedTexts.add(result.original);
      }
    }
  } catch {
    // 静默失败
  }

  // 未成功拆解的补手动触发
  for (const [text, el] of elementMap) {
    if (!chunkedTexts.has(text)) {
      addManualTrigger(el, text);
    }
  }

  if (processQueue.length > 0 && isActive) {
    processTimer = setTimeout(flushProcessQueue, 50);
  }
}

// ========== MutationObserver ==========

/**
 * 恢复单个被隐藏的原始元素（移除分块兄弟、恢复显示、清理截断覆盖）
 * 用于：站点 JS 更新了被隐藏元素的内容（如 Twitter "Show more" 展开全文）
 */
function restoreSingleElement(el: Element): void {
  if (!el.classList.contains("enlearn-original-hidden")) return;

  // 移除分块兄弟
  const next = el.nextElementSibling;
  if (next?.classList.contains("enlearn-chunked")) {
    next.remove();
  }

  // 恢复原始元素显示
  (el as HTMLElement).style.removeProperty("display");
  el.classList.remove("enlearn-original-hidden");

  // 清理祖先上的截断覆盖
  let current = el.parentElement;
  for (let i = 0; i < 6 && current; i++) {
    const tag = current.tagName;
    if (tag === "A" || tag === "ARTICLE") break;
    if (current.getAttribute("role") === "article") break;
    if (current.classList.contains("enlearn-clamp-override")) {
      (current as HTMLElement).style.removeProperty("-webkit-line-clamp");
      (current as HTMLElement).style.removeProperty("-webkit-box-orient");
      (current as HTMLElement).style.removeProperty("display");
      (current as HTMLElement).style.removeProperty("max-height");
      (current as HTMLElement).style.removeProperty("overflow");
      current.classList.remove("enlearn-clamp-override");
    }
    current = current.parentElement;
  }

  // 允许重新处理
  processedElements.delete(el);

  // 清理手动触发按钮（如有）
  const trigger = el.querySelector(".enlearn-trigger");
  if (trigger) trigger.remove();
  el.classList.remove("enlearn-trigger-wrap");
  el.removeAttribute("data-enlearn-trigger");
}

function setupMutationObserver(): void {
  mutationObserver = new MutationObserver((mutations) => {
    let hasNewContent = false;
    const changedHiddenEls = new Set<Element>();

    for (const mutation of mutations) {
      // 场景 A：站点 JS 修改了 hidden 元素内部内容（in-place 更新）
      const target = mutation.target;
      if (target instanceof Element) {
        const hiddenEl = target.classList.contains("enlearn-original-hidden")
          ? target
          : target.closest(".enlearn-original-hidden");
        if (hiddenEl) {
          changedHiddenEls.add(hiddenEl);
          continue;
        }
      } else if (target.parentElement) {
        const hiddenEl = target.parentElement.closest(".enlearn-original-hidden");
        if (hiddenEl) {
          changedHiddenEls.add(hiddenEl);
          continue;
        }
      }

      // 场景 B：React 直接替换整个元素（移除旧 hidden 元素 + 插入新元素）
      // Twitter "Show more"：React 移除旧 tweetText，插入包含全文的新 tweetText
      // 旧元素被移除后，我们的 .enlearn-chunked 兄弟变成孤儿
      for (const node of mutation.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (el.classList.contains("enlearn-original-hidden")) {
            // 清理孤儿分块兄弟：在 parent 中找没有对应 hidden 原始元素的 chunked div
            const parent = mutation.target;
            if (parent instanceof Element) {
              const chunkedDivs = parent.querySelectorAll(
                ":scope > .enlearn-chunked"
              );
              for (const c of chunkedDivs) {
                const prev = c.previousElementSibling;
                if (
                  !prev ||
                  !prev.classList.contains("enlearn-original-hidden")
                ) {
                  c.remove();
                }
              }
            }
            processedElements.delete(el);
            hasNewContent = true;
          }
        }
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (!isEnlearnElement(el)) {
            hasNewContent = true;
          }
        }
      }
    }

    // 场景 A 触发：恢复并重新处理
    if (changedHiddenEls.size > 0) {
      for (const el of changedHiddenEls) {
        restoreSingleElement(el);
      }
      setTimeout(scanPage, 300);
    }

    if (hasNewContent) {
      setTimeout(scanPage, 300);
    }
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ========== 通信 ==========

function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

// ========== 启动 ==========

init();
