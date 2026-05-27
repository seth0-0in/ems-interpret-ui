import { COLORS, sectionHeading, whiteCard } from "../theme";
import { LANGUAGE_OPTIONS } from "../languages";

type UploadPanelProps = {
  selectedFile: File | null;
  loading: boolean;
  error: string;
  duration?: number;
  processingTime?: number;
  // 서버가 자동 감지한 신고자 언어 코드 (en/zh/ja/...).
  callerLanguage?: string;
  // 처리 모드 — 업로드 화면은 기본 "diarization".
  mode?: "normal" | "diarization";
  // 처리 중 발생한 오류 개수.
  errorsCount?: number;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onUpload: () => void;
};

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontWeight: 700,
  fontSize: 14,
  color: COLORS.inkSoft,
};

function langLabel(code?: string): string {
  if (!code) return "자동 감지 대기";
  if (code === "unknown") return "감지 실패";
  return LANGUAGE_OPTIONS.find((l) => l.value === code)?.label ?? code;
}

function UploadPanel({
  selectedFile,
  loading,
  error,
  duration,
  processingTime,
  callerLanguage,
  mode,
  errorsCount,
  onFileChange,
  onUpload,
}: UploadPanelProps) {
  return (
    <div style={{ ...whiteCard, height: "fit-content" }}>
      <div style={sectionHeading}>음성파일 업로드</div>

      <div style={{ marginBottom: 16 }}>
        <label style={fieldLabelStyle}>오디오 파일</label>
        <input
          type="file"
          accept=".mp3,.wav,.m4a,.ogg,.webm,audio/*"
          onChange={onFileChange}
          style={{ color: COLORS.ink, fontSize: 13 }}
        />
      </div>

      {/* 119 자동 처리 안내 — 수동 언어 선택 UI 대신 자동 처리 흐름을 보여준다. */}
      <div
        style={{
          marginBottom: 18,
          padding: "10px 12px",
          backgroundColor: "#e9f0f9",
          border: `1px solid ${COLORS.operator}55`,
          borderLeft: `4px solid ${COLORS.operator}`,
          borderRadius: 8,
          fontSize: 12.5,
          color: COLORS.inkSoft,
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontWeight: 800, color: COLORS.operator, marginBottom: 4 }}>
          🤖 자동 처리 모드
        </div>
        업로드된 음성은 서버가 자동으로:
        <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
          <li>화자를 분리하고 (화자 1 / 화자 2)</li>
          <li>각 발화의 언어를 자동 감지하고</li>
          <li>신고자/구급대원 역할을 추정하고</li>
          <li>외국어 → 한국어, 한국어 → 신고자 언어로 자동 번역합니다.</li>
        </ul>
      </div>

      <button
        onClick={onUpload}
        disabled={loading}
        style={{
          width: "100%",
          padding: "14px",
          borderRadius: 10,
          border: "none",
          backgroundColor: loading ? COLORS.slate : COLORS.navy,
          color: "#ffffff",
          fontWeight: 800,
          fontSize: 17,
          cursor: loading ? "not-allowed" : "pointer",
        }}
      >
        {loading ? "전사 처리 중..." : "전사 시작"}
      </button>

      {selectedFile && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            backgroundColor: COLORS.track,
            border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 9,
            fontSize: 13,
            color: COLORS.inkSoft,
          }}
        >
          선택 파일:{" "}
          <strong style={{ color: COLORS.ink }}>{selectedFile.name}</strong>
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            backgroundColor: COLORS.redSoft,
            border: `1px solid ${COLORS.red}55`,
            borderRadius: 9,
            color: COLORS.redDark,
            fontSize: 13,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {error}
        </div>
      )}

      {(callerLanguage !== undefined || mode !== undefined) && (
        <div
          style={{
            marginTop: 18,
            padding: 14,
            borderRadius: 10,
            backgroundColor: COLORS.track,
            border: `1px solid ${COLORS.cardBorder}`,
            fontSize: 13,
            lineHeight: 1.65,
          }}
        >
          <div style={{ marginBottom: 6, color: COLORS.inkSoft }}>
            감지된 신고자 언어:{" "}
            <strong style={{ color: COLORS.ink }}>
              {langLabel(callerLanguage)}
            </strong>
          </div>
          <div style={{ marginBottom: 6, color: COLORS.inkSoft }}>
            구급대원 언어:{" "}
            <strong style={{ color: COLORS.ink }}>한국어</strong>
          </div>
          {mode && (
            <div style={{ color: COLORS.inkMuted, fontSize: 12 }}>
              처리 모드: {mode === "diarization" ? "화자분리 자동 분석" : "일반"}
            </div>
          )}
        </div>
      )}

      {duration !== undefined && processingTime !== undefined && (
        <div
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 10,
            backgroundColor: COLORS.track,
            border: `1px solid ${COLORS.cardBorder}`,
            fontSize: 13,
          }}
        >
          <div style={{ marginBottom: 8, color: COLORS.inkSoft }}>
            전체 길이:{" "}
            <strong style={{ color: COLORS.ink }}>
              {duration.toFixed(2)}s
            </strong>
          </div>
          <div style={{ marginBottom: 8, color: COLORS.inkSoft }}>
            처리 시간:{" "}
            <strong style={{ color: COLORS.ink }}>
              {processingTime.toFixed(2)}s
            </strong>
          </div>
          {errorsCount !== undefined && errorsCount > 0 && (
            <div style={{ color: COLORS.redDark, fontWeight: 700 }}>
              ⚠ 처리 중 오류 {errorsCount}건 (결과 문서에서 확인하세요)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default UploadPanel;
