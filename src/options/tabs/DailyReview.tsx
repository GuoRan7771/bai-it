import { useState } from "react";
import { GlassCard } from "../components/GlassCard.tsx";
import { ChunkLines } from "../components/ChunkLines.tsx";
import { BreakPointSentence } from "../components/BreakPointSentence.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { useReviewData } from "../hooks/useReviewData.ts";
import { useMasteredWords } from "../hooks/useMasteredWords.ts";

interface DailyReviewProps {
  db: IDBDatabase | null;
  isExample: boolean;
}

export function DailyReview({ db, isExample }: DailyReviewProps) {
  const { practiseSentence, todayVocab, weekSentenceCount, loading } = useReviewData(db, isExample);
  const { isMastered, toggleMastered } = useMasteredWords();
  const [breakCount, setBreakCount] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);

  if (loading) return null;

  const hasSentence = practiseSentence !== null;
  const hasVocab = todayVocab.length > 0;

  if (!hasSentence && !hasVocab) {
    return <EmptyState text="今天还没掰过句子，去浏览英文网页试试" />;
  }

  return (
    <>
      {/* Title + weekly stat */}
      <div className="rv" style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 36 }}>
        <div>
          <div className="section-head" style={{ marginBottom: 4 }}>每日回味</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.2)" }}>打开看一眼，10 秒搞定</div>
        </div>
        <div className="weekly-stat">
          这周掰了 <span className="weekly-stat-num">{weekSentenceCount}</span> 句
        </div>
      </div>

      {/* 断句练习 */}
      {hasSentence && (
        <div className="rv">
          <div className="sub-label">断句练习</div>
          <GlassCard className="learn-sentence">
            <BreakPointSentence
              sentence={practiseSentence.sentence}
              onBreakCountChange={setBreakCount}
            />
          </GlassCard>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, marginBottom: 44 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.15)" }}>
              凭语感断，不用想语法 · 断了 {breakCount} 处
            </div>
            <button
              className="cta-btn"
              style={{ padding: "10px 28px", fontSize: 13 }}
              onClick={() => setShowAnswer(!showAnswer)}
              type="button"
            >
              {showAnswer ? "收起答案" : "看答案"}
            </button>
          </div>

          {/* Answer section */}
          {showAnswer && (
            <div className="answer-section rv">
              <div className="sub-label">AI 分块</div>
              <GlassCard className="sentence-card" style={{ marginBottom: 0 }}>
                <ChunkLines
                  chunked={practiseSentence.chunked}
                  newWords={practiseSentence.new_words}
                  language={practiseSentence.language ?? "english"}
                />
              </GlassCard>
            </div>
          )}
        </div>
      )}

      {/* 高频词汇 */}
      {hasVocab && (
        <div className="rv">
          <div className="sub-label">今天掰过的词</div>
          <div className="review-vocab-grid">
            {todayVocab.map((v) => {
              const mastered = v.status === "mastered" || isMastered(v.word, "english");
              return (
                <GlassCard key={v.id} className="review-vocab-item">
                  <div className="review-vocab-top">
                    <span className="review-vocab-word">{v.word}</span>
                    <span className="review-vocab-freq">×{v.encounterToday}</span>
                  </div>
                  <div className="review-vocab-def">{v.definition || ""}</div>
                  <button
                    className="review-vocab-mastered"
                    onClick={() => toggleMastered(v.word, "english")}
                    type="button"
                  >
                    {mastered ? "✓ 已掌握" : "标记掌握"}
                  </button>
                </GlassCard>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
