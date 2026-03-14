import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import type { SupportedLanguage } from "../../shared/types.ts";
import { useMasteredWords } from "../hooks/useMasteredWords.ts";

interface TipData {
  word: string;
  def: string;
  language: SupportedLanguage;
  // Target element rect (viewport coords)
  targetCenterX: number;
  targetTop: number;
  targetBottom: number;
}

interface TipPos {
  x: number;
  y: number;
  arrowX: number;
  above: boolean;
}

export function WordTooltip() {
  const [data, setData] = useState<TipData | null>(null);
  const [pos, setPos] = useState<TipPos | null>(null);
  const { isMastered, toggleMastered } = useMasteredWords();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const clearHide = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);

  const schedHide = useCallback(() => {
    clearHide();
    hideTimer.current = setTimeout(() => { setData(null); setPos(null); }, 120);
  }, [clearHide]);

  // Measure and position after data renders
  useLayoutEffect(() => {
    if (!data || !wrapRef.current) { setPos(null); return; }
    const el = wrapRef.current;
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;

    let x = data.targetCenterX - bw / 2;
    let y = data.targetTop - bh - 12;
    let above = true;

    if (x < 8) x = 8;
    if (x + bw > window.innerWidth - 8) x = window.innerWidth - bw - 8;
    if (y < 8) { y = data.targetBottom + 12; above = false; }

    const arrowX = Math.max(12, Math.min(bw - 20, data.targetCenterX - x - 8));
    setPos({ x, y, arrowX, above });
  }, [data]);

  // Document-level event delegation
  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const el = (e.target as Element).closest(".vocab[data-def]");
      if (!el) return;
      clearHide();

      const word = el.getAttribute("data-word") || "";
      const def = el.getAttribute("data-def") || "";
      const language = (el.getAttribute("data-lang") || "english") as SupportedLanguage;
      if (!def) return;

      const rect = el.getBoundingClientRect();
      setData({
        word, def, language,
        targetCenterX: rect.left + rect.width / 2,
        targetTop: rect.top,
        targetBottom: rect.bottom,
      });
    };

    const onOut = (e: MouseEvent) => {
      if ((e.target as Element).closest(".vocab[data-def]")) schedHide();
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      clearHide();
    };
  }, [clearHide, schedHide]);

  const handleMark = useCallback(() => {
    if (data) { toggleMastered(data.word, data.language); setData(null); setPos(null); }
  }, [data, toggleMastered]);

  if (!data) return null;

  const mastered = isMastered(data.word, data.language);
  const visible = pos !== null;

  return (
    <div
      ref={wrapRef}
      className="vt"
      style={{
        left: pos ? pos.x : 0,
        top: pos ? pos.y : 0,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
      onMouseEnter={clearHide}
      onMouseLeave={schedHide}
    >
      <div className="vt-body">
        <div className="vt-word">{data.word}</div>
        <div className="vt-def">{data.def}</div>
        <div className="vt-foot">
          <button
            className={`vt-mark${mastered ? " is-done" : ""}`}
            onClick={handleMark}
            type="button"
          >
            {mastered ? (
              <svg className="vt-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <polyline points="2.5,6 5.5,9 9.5,3" />
              </svg>
            ) : (
              <svg className="vt-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                <circle cx="6" cy="6" r="4.5" />
              </svg>
            )}
            {mastered ? "已掌握" : "标记掌握"}
          </button>
        </div>
      </div>
      {/* SVG arrow — inherits drop-shadow from parent filter */}
      {visible && (
        <svg
          className={`vt-arrow ${pos.above ? "vt-arrow-bot" : "vt-arrow-top"}`}
          style={{ left: pos.arrowX }}
          width="16" height="8" viewBox="0 0 16 8"
        >
          <polygon
            points={pos.above ? "0,0 8,8 16,0" : "0,8 8,0 16,8"}
            fill="rgba(16,16,18,0.96)"
          />
        </svg>
      )}
    </div>
  );
}
