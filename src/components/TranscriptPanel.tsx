import { COLORS, sectionHeading, whiteCard } from "../theme";
import type { TranscriptSegment, TranscriptionResponse } from "../context/AppDataContext";
import { LANGUAGE_OPTIONS } from "../languages";

type MessageTranslationMap = Record<number, string>;

type TranscriptPanelProps = {
  loading: boolean;
  result: TranscriptionResponse | null;
  // 서버가 segment.translated 를 채워주지 못한 경우 fallback 으로 사용하는 보조 맵.
  // 새 자동 처리 흐름에서는 UploadPage 가 segment.translated 를 그대로 이 맵에 미러링한다.
  translations: MessageTranslationMap;
  formatTime: (seconds: number) => string;
};

const ROLE_LABEL: Record<string, string> = {
  caller: "🆘 신고자",
  operator: "🚑 구급대원",
  interpreter: "🗣️ 통역사",
  unknown: "❓ 판단 불가",
};

function langLabel(code?: string): string {
  if (!code) return "-";
  if (code === "unknown") return "감지 실패";
  return LANGUAGE_OPTIONS.find((l) => l.value === code)?.label ?? code;
}

function confidenceLabel(c?: number): string {
  if (c === undefined) return "";
  if (c >= 0.7) return "높음";
  if (c >= 0.4) return "보통";
  return "낮음";
}

function confidenceColor(c?: number): string {
  if (c === undefined) return COLORS.slate;
  if (c >= 0.7) return "#0f7b54";
  if (c >= 0.4) return "#d97706";
  return "#dc2626";
}

// 서버가 role 을 채워주지 못한 경우, 라벨에 등장한 화자 인덱스(SPK_0/SPK_1 또는 화자 1/화자 2)
// 와 segment 의 source_language 를 보고 휴리스틱으로 caller/operator 배치를 정한다.
// 첫 외국어 화자를 caller, 한국어 화자를 operator 로 본다.
function deriveDisplayRole(
  seg: TranscriptSegment,
  speakerToRole: Map<string, "caller" | "operator" | "unknown">
): "caller" | "operator" | "interpreter" | "unknown" {
  if (
    seg.role === "caller" ||
    seg.role === "operator" ||
    seg.role === "interpreter" ||
    seg.role === "unknown"
  ) {
    return seg.role;
  }
  return speakerToRole.get(seg.speaker) ?? "unknown";
}

// segment 리스트 → speaker 라벨별 추정 role 매핑 (서버 role 이 비어 있을 때만 사용).
function buildSpeakerRoleMap(
  segments: TranscriptSegment[]
): Map<string, "caller" | "operator" | "unknown"> {
  const map = new Map<string, "caller" | "operator" | "unknown">();
  for (const s of segments) {
    if (!s.speaker) continue;
    if (map.has(s.speaker)) continue;
    if (s.source_language === "ko") {
      map.set(s.speaker, "operator");
    } else if (s.source_language && s.source_language !== "unknown") {
      map.set(s.speaker, "caller");
    }
  }
  // 두 라벨이 모두 한국어/외국어면 첫 라벨을 caller, 나머지를 operator 로.
  if (map.size === 0) {
    const labels = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
    labels.forEach((label, idx) => {
      map.set(label, idx === 0 ? "caller" : "operator");
    });
  }
  return map;
}

function TranscriptPanel({
  loading,
  result,
  translations,
  formatTime,
}: TranscriptPanelProps) {
  return (
    <div style={whiteCard}>
      <div style={sectionHeading}>전사 결과</div>

      {!result && !loading && (
        <p
          style={{
            color: COLORS.inkMuted,
            textAlign: "center",
            padding: "40px 0",
          }}
        >
          아직 전사 결과가 없습니다. 음성파일을 업로드해 자동 분석을 시작하세요.
        </p>
      )}

      {loading && (
        <p
          style={{
            color: COLORS.navy,
            textAlign: "center",
            padding: "40px 0",
            fontWeight: 700,
          }}
        >
          음성을 분석하고 화자를 분리하고 있습니다...
        </p>
      )}

      {result && (
        <>
          {/* 1. 사건 개요 (자동 감지된 언어/화자/번역 방향) */}
          <div
            style={{
              marginBottom: 18,
              padding: 14,
              backgroundColor: "#e9f0f9",
              borderRadius: 10,
              border: `1px solid ${COLORS.operator}55`,
              borderLeft: `4px solid ${COLORS.operator}`,
            }}
          >
            <h3
              style={{
                marginTop: 0,
                marginBottom: 8,
                fontSize: 15,
                color: COLORS.operator,
                fontWeight: 800,
              }}
            >
              🤖 자동 분석 결과
            </h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                fontSize: 13,
                color: COLORS.inkSoft,
                lineHeight: 1.7,
              }}
            >
              <div>
                감지된 신고자 언어:{" "}
                <strong style={{ color: COLORS.ink }}>
                  {langLabel(result.caller_language)}
                </strong>
              </div>
              <div>
                구급대원 언어:{" "}
                <strong style={{ color: COLORS.ink }}>한국어</strong>
              </div>
              <div>
                segment 수:{" "}
                <strong style={{ color: COLORS.ink }}>
                  {result.segments.length}건
                </strong>
              </div>
              <div>
                처리 모드:{" "}
                <strong style={{ color: COLORS.ink }}>
                  {result.mode === "diarization" ? "화자분리 자동 분석" : "일반"}
                </strong>
              </div>
            </div>
            {result.errors && result.errors.length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  color: COLORS.redDark,
                  fontWeight: 700,
                }}
              >
                ⚠ 처리 중 오류 {result.errors.length}건 (결과 문서에서 확인)
              </div>
            )}
          </div>

          {/* 2. 전체 원문 */}
          <div
            style={{
              marginBottom: 18,
              padding: 16,
              backgroundColor: COLORS.track,
              borderRadius: 10,
              border: `1px solid ${COLORS.cardBorder}`,
            }}
          >
            <h3
              style={{
                marginTop: 0,
                marginBottom: 10,
                fontSize: 16,
                color: COLORS.ink,
              }}
            >
              전체 원문
            </h3>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                fontFamily: "inherit",
                margin: 0,
                lineHeight: 1.7,
                color: COLORS.inkSoft,
                fontSize: 15,
              }}
            >
              {result.text || "(원문이 없습니다)"}
            </pre>
          </div>

          {/* 3. 한국어 통합 번역문 (서버 envelope.translated) */}
          {result.translated && (
            <div
              style={{
                marginBottom: 22,
                padding: 16,
                backgroundColor: "#fffbeb",
                borderRadius: 10,
                border: "1px solid #fde68a",
                borderLeft: "4px solid #d97706",
              }}
            >
              <h3
                style={{
                  marginTop: 0,
                  marginBottom: 10,
                  fontSize: 16,
                  color: "#92400e",
                }}
              >
                전체 한국어/통역 번역문
              </h3>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  margin: 0,
                  lineHeight: 1.7,
                  color: COLORS.ink,
                  fontSize: 17,
                  fontWeight: 600,
                }}
              >
                {result.translated}
              </pre>
            </div>
          )}

          {/* 4. 화자별 segment — 원문 + 자동 번역 */}
          <h3
            style={{
              fontSize: 17,
              marginBottom: 14,
              color: COLORS.ink,
            }}
          >
            화자별 발화 기록
          </h3>

          <SegmentList
            segments={result.segments}
            translations={translations}
            formatTime={formatTime}
          />
        </>
      )}
    </div>
  );
}

function SegmentList({
  segments,
  translations,
  formatTime,
}: {
  segments: TranscriptSegment[];
  translations: MessageTranslationMap;
  formatTime: (seconds: number) => string;
}) {
  const speakerRoleMap = buildSpeakerRoleMap(segments);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {segments.map((segment, index) => {
        const role = deriveDisplayRole(segment, speakerRoleMap);
        const accent =
          role === "caller"
            ? COLORS.caller
            : role === "operator"
            ? COLORS.operator
            : role === "interpreter"
            ? COLORS.violet
            : COLORS.slate;
        const soft =
          role === "caller"
            ? COLORS.callerSoft
            : role === "operator"
            ? COLORS.operatorSoft
            : role === "interpreter"
            ? "#f5f0ff"
            : COLORS.track;
        const isLeft = role === "caller";
        const isRight = role === "operator";
        const justify = isLeft
          ? "flex-start"
          : isRight
          ? "flex-end"
          : "center";

        const translated = segment.translated || translations[index] || "";
        // 번역 방향 안내 — caller(외국어)는 구급대원에게 한국어로, operator(한국어)는 신고자 언어로.
        const listenerHint =
          role === "caller"
            ? "→ 구급대원에게 표시되는 한국어 번역"
            : role === "operator"
            ? "→ 신고자에게 전달되는 외국어 번역"
            : null;

        return (
          <div
            key={index}
            style={{
              display: "flex",
              justifyContent: justify,
            }}
          >
            <div
              style={{
                maxWidth: "82%",
                minWidth: 320,
                backgroundColor: soft,
                color: COLORS.ink,
                border: `1px solid ${COLORS.cardBorder}`,
                borderLeft: isLeft
                  ? `6px solid ${accent}`
                  : `1px solid ${COLORS.cardBorder}`,
                borderRight: isRight
                  ? `6px solid ${accent}`
                  : `1px solid ${COLORS.cardBorder}`,
                borderTop:
                  !isLeft && !isRight ? `3px solid ${accent}` : undefined,
                borderRadius: 12,
                padding: 16,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <strong style={{ color: accent, fontSize: 15 }}>
                  {segment.speaker || "화자 ?"}
                </strong>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#fff",
                    backgroundColor: accent,
                  }}
                >
                  {ROLE_LABEL[role] ?? "❓ 판단 불가"}
                </span>
                {segment.role_confidence !== undefined && (
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#fff",
                      backgroundColor: confidenceColor(segment.role_confidence),
                    }}
                    title={
                      segment.role_reason
                        ? `근거: ${segment.role_reason}`
                        : "역할 판단 신뢰도"
                    }
                  >
                    신뢰도 {confidenceLabel(segment.role_confidence)} (
                    {Math.round(segment.role_confidence * 100)}%)
                  </span>
                )}
                {(segment.source_language || segment.target_language) && (
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 600,
                      backgroundColor: "#fff",
                      border: `1px solid ${COLORS.cardBorder}`,
                      color: COLORS.inkSoft,
                    }}
                  >
                    {langLabel(segment.source_language)} →{" "}
                    {langLabel(segment.target_language)}
                  </span>
                )}
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 12,
                    color: COLORS.inkMuted,
                  }}
                >
                  {formatTime(segment.start)} ~ {formatTime(segment.end)}
                </span>
              </div>

              {/* 원문 — 보조 텍스트로 약간 작게/연하게. */}
              <div
                style={{
                  fontSize: 14,
                  lineHeight: 1.65,
                  color: COLORS.inkSoft,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: "#fff",
                    backgroundColor: COLORS.slate,
                    padding: "1px 6px",
                    borderRadius: 4,
                    marginRight: 6,
                  }}
                >
                  원문
                </span>
                {segment.text}
              </div>

              {/* 통역 — 원문보다 크고 강조. */}
              {translated ? (
                <div
                  style={{
                    marginTop: 12,
                    padding: "10px 12px",
                    borderTop: `1px dashed ${accent}66`,
                    backgroundColor: "rgba(255,255,255,0.85)",
                    borderRadius: 10,
                    boxShadow: `inset 0 0 0 1px ${accent}33`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: 11.5,
                        fontWeight: 700,
                        color: "#fff",
                        backgroundColor: accent,
                        padding: "3px 10px",
                        borderRadius: 5,
                      }}
                    >
                      📢 통역
                    </span>
                    {listenerHint && (
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: accent,
                        }}
                      >
                        {listenerHint}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 20,
                      lineHeight: 1.55,
                      color: COLORS.ink,
                      fontWeight: 700,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {translated}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 12,
                    color: COLORS.inkMuted,
                    fontStyle: "italic",
                  }}
                >
                  (자동 번역 결과 없음)
                </div>
              )}

              {segment.role_reason && !segment.error && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 11.5,
                    color: COLORS.inkMuted,
                    fontStyle: "italic",
                  }}
                >
                  자동 판단 근거: {segment.role_reason}
                </div>
              )}

              {segment.error && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "6px 9px",
                    fontSize: 12.5,
                    color: COLORS.redDark,
                    backgroundColor: COLORS.redSoft,
                    border: `1px solid ${COLORS.red}55`,
                    borderRadius: 6,
                  }}
                >
                  ⚠ 오류: {segment.error}
                  {segment.reason && (
                    <span style={{ marginLeft: 6, color: COLORS.inkMuted }}>
                      ({segment.reason})
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default TranscriptPanel;
