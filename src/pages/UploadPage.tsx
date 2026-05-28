import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import UploadPanel from "../components/UploadPanel";
import TranscriptPanel from "../components/TranscriptPanel";
import AppHeader from "../components/AppHeader";
import { useAppData } from "../context/AppDataContext";
import type {
  TranscriptSegment,
  TranscriptionResponse,
} from "../context/AppDataContext";
import { COLORS } from "../theme";
import { apiUrl, diag } from "../api";

type MessageTranslationMap = Record<number, string>;

// 서버 화자분리 응답 한 건. envelope 의 segment 형식과 동일.
type ServerSegment = {
  speaker?: string;
  start?: number;
  end?: number;
  text?: string;
  source_language?: string;
  target_language?: string;
  role?: string;
  role_reason?: string;
  role_confidence?: number;
  translated?: string;
  error?: string;
  reason?: string;
};

type ServerEnvelope = {
  session_id?: string;
  client_seq?: number;
  status?: string;
  text?: string;
  translated?: string;
  source_language?: string;
  target_language?: string;
  speaker?: string;
  speaker_reason?: string;
  speaker_confidence?: number;
  segments?: ServerSegment[];
  latency?: {
    stt_ms?: number;
    translate_ms?: number;
    tts_ms?: number;
    total_ms?: number;
  };
  error?: string | null;
  reason?: string | null;
};

// 서버 envelope segment → 컨텍스트가 보관하는 TranscriptSegment 로 정규화.
// 빠진 필드는 보수적으로 채우고, 빈 텍스트 segment 는 제외한다.
function normalizeSegments(raw?: ServerSegment[]): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const s of raw) {
    const text = String(s?.text ?? "").trim();
    if (!text) continue;
    out.push({
      speaker: String(s?.speaker ?? ""),
      start: Number(s?.start ?? 0),
      end: Number(s?.end ?? 0),
      text,
      source_language:
        typeof s?.source_language === "string" && s.source_language
          ? s.source_language
          : undefined,
      target_language:
        typeof s?.target_language === "string" && s.target_language
          ? s.target_language
          : undefined,
      role: typeof s?.role === "string" && s.role ? s.role : undefined,
      role_reason:
        typeof s?.role_reason === "string" && s.role_reason
          ? s.role_reason
          : undefined,
      role_confidence:
        typeof s?.role_confidence === "number" ? s.role_confidence : undefined,
      translated:
        typeof s?.translated === "string" && s.translated
          ? s.translated
          : undefined,
      error:
        typeof s?.error === "string" && s.error ? s.error : undefined,
      reason:
        typeof s?.reason === "string" && s.reason ? s.reason : undefined,
    });
  }
  return out;
}

// 가장 먼저 등장하는 caller 역할의 source_language 를 신고자 언어로 추정.
// 없으면 한국어가 아닌 첫 source_language. 그것도 없으면 undefined.
function deriveCallerLanguage(segments: TranscriptSegment[]): string | undefined {
  for (const s of segments) {
    if (s.role === "caller" && s.source_language && s.source_language !== "unknown") {
      return s.source_language;
    }
  }
  for (const s of segments) {
    if (
      s.source_language &&
      s.source_language !== "ko" &&
      s.source_language !== "unknown"
    ) {
      return s.source_language;
    }
  }
  return undefined;
}

function UploadPage() {
  const navigate = useNavigate();

  const {
    transcriptionResult,
    setTranscriptionResult,
    selectedFileName,
    setSelectedFileName,
    translations,
    setTranslations,
    upsertUploadRecord,
  } = useAppData();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 실시간 페이지와 동일한 endpoint(/api/119/realtime/process) 를 사용한다.
  // 업로드 화면은 항상 diarization 모드로 호출해 segment 단위 화자/언어/번역까지 한 번에 받는다.
  // 추후 normal mode 도 필요해지면 토글로 쉽게 분기 가능 — 지금은 자동화 우선.
  // 새 파일을 업로드할 때마다 새 UUID 가 발급되며, 이 ID 가 upload history record 의
  // 키로 쓰여 같은 작업의 재시도는 카드를 중복 생성하지 않고 갱신한다.
  const sessionIdRef = useRef<string>("");

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setSelectedFileName(file?.name ?? "");
    setTranscriptionResult(null);
    setError("");
    setTranslations({});
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setError("먼저 오디오 파일을 선택해주세요.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      setTranscriptionResult(null);
      setTranslations({});

      sessionIdRef.current = crypto.randomUUID();
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("session_id", sessionIdRef.current);
      formData.append("client_seq", "1");
      // 업로드 분석은 항상 diarization 모드 — segment 단위 결과를 받는다.
      formData.append("mode", "diarization");
      // language hint 는 일절 보내지 않는다 (서버가 자동 감지).

      const startedAt = performance.now();
      // 업로드 분석도 동일 endpoint 사용. apiUrl 이 /api/... 입력은 BASE_URL prefix
      // 없이 서버 루트 origin-relative 로 반환하므로 dev/preview/운영 모두
      // "/api/119/realtime/process" 로 일관되게 나간다.
      const processUrl = apiUrl("/api/119/realtime/process");
      diag("upload_process_request_url", {
        url: processUrl,
        baseUrl: import.meta.env.BASE_URL,
      });
      const response = await fetch(processUrl, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `전사 요청 실패: ${response.status} / ${errorText.slice(0, 200)}`
        );
      }

      const env = (await response.json()) as ServerEnvelope;
      const segments = normalizeSegments(env.segments);
      const fullText =
        (env.text && env.text.trim().length > 0
          ? env.text
          : segments.map((s) => s.text).join("\n")) || "";

      // 오류 모음 — envelope.error / envelope.reason / segment.error 를 한 곳에.
      const errors: string[] = [];
      if (env.error) errors.push(String(env.error));
      if (env.reason && env.status !== "ok") errors.push(String(env.reason));
      for (const s of segments) {
        if (s.error) {
          errors.push(
            `[segment ${s.start.toFixed(2)}–${s.end.toFixed(2)}s] ${s.error}${
              s.reason ? ` (${s.reason})` : ""
            }`
          );
        }
      }

      const totalMs =
        env.latency?.total_ms ?? Math.round(performance.now() - startedAt);
      const callerLanguage = deriveCallerLanguage(segments);
      const duration = (() => {
        if (segments.length === 0) return undefined;
        const lastEnd = segments[segments.length - 1].end;
        return Number.isFinite(lastEnd) && lastEnd > 0 ? lastEnd : undefined;
      })();

      const newResult: TranscriptionResponse = {
        text: fullText,
        segments,
        duration,
        processing_time: totalMs / 1000,
        timings: {
          load: 0,
          diarize:
            env.latency?.stt_ms !== undefined
              ? (env.latency.stt_ms || 0) / 1000
              : undefined,
          asr:
            env.latency?.translate_ms !== undefined
              ? (env.latency.translate_ms || 0) / 1000
              : undefined,
        },
        translated: env.translated || undefined,
        caller_language: callerLanguage,
        source_language: env.source_language || undefined,
        target_language: env.target_language || undefined,
        speaker: env.speaker || undefined,
        speaker_reason: env.speaker_reason || undefined,
        speaker_confidence:
          typeof env.speaker_confidence === "number"
            ? env.speaker_confidence
            : undefined,
        mode: "diarization",
        latency: env.latency,
        errors: errors.length > 0 ? errors : undefined,
        status: env.status,
      };
      setTranscriptionResult(newResult);

      // segment 별 한국어/상대언어 번역을 기존 translations 맵에 미리 채워넣어
      // ResultPage 의 segment 렌더가 즉시 번역을 보여줄 수 있게 한다.
      const trMap: MessageTranslationMap = {};
      segments.forEach((s, i) => {
        if (s.translated) trMap[i] = s.translated;
      });
      setTranslations(trMap);

      // 업로드 히스토리에 추가 — ResultPage 의 카드 목록에서 이 파일을 선택할 수 있게 한다.
      // 동일 sessionId(=동일 업로드 작업)는 upsert 되어 카드가 중복 생성되지 않는다.
      upsertUploadRecord({
        id: sessionIdRef.current,
        createdAt: Date.now(),
        fileName: selectedFile.name,
        result: newResult,
        translations: trMap,
      });

      navigate("/result");
    } catch (err) {
      console.error("업로드 에러:", err);
      if (err instanceof Error) {
        setError(`전사 처리 중 오류가 발생했습니다: ${err.message}`);
      } else {
        setError("전사 처리 중 알 수 없는 오류가 발생했습니다.");
      }
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toFixed(2).padStart(5, "0")}`;
  };

  return (
    <div style={{ minHeight: "100vh", backgroundColor: COLORS.pageBg }}>
      <AppHeader subtitle="음성파일 업로드 · 자동 화자분리 · 자동 언어 감지 · 자동 번역" />

      <main
        style={{
          maxWidth: 1320,
          margin: "0 auto",
          padding: "24px 24px 64px",
        }}
      >
        <div style={{ marginBottom: 18 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 30,
              fontWeight: 800,
              color: "#ffffff",
              letterSpacing: -0.5,
            }}
          >
            업로드 전사
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              color: COLORS.onDarkMuted,
              fontSize: 14,
            }}
          >
            긴급구조 녹취 음성파일을 업로드하면 서버가 자동으로 화자분리·언어
            감지·번역까지 수행합니다. 사용자가 언어를 선택할 필요가 없습니다.
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "350px 1fr",
            gap: 20,
            alignItems: "start",
          }}
        >
          <UploadPanel
            selectedFile={
              selectedFile
                ? selectedFile
                : selectedFileName
                ? new File([], selectedFileName)
                : null
            }
            loading={loading}
            error={error}
            duration={transcriptionResult?.duration}
            processingTime={transcriptionResult?.processing_time}
            callerLanguage={transcriptionResult?.caller_language}
            mode={transcriptionResult?.mode}
            errorsCount={transcriptionResult?.errors?.length ?? 0}
            onFileChange={handleFileChange}
            onUpload={handleUpload}
          />

          <TranscriptPanel
            loading={loading}
            result={transcriptionResult}
            translations={translations}
            formatTime={formatTime}
          />
        </div>
      </main>
    </div>
  );
}

export default UploadPage;
