import { createContext, useCallback, useContext, useState } from "react";

// 업로드 화면이 보여주는 segment 한 건.
// 백엔드 /api/119/realtime/process (mode=diarization) 응답의 segment 형식과
// 동일하게 맞춰서 role / source_language / translated 까지 그대로 전달받는다.
// 구버전(diarize 전용) 응답에서는 speaker/start/end/text 만 채워지고
// 나머지 필드는 undefined.
export type TranscriptSegment = {
  speaker: string;
  start: number;
  end: number;
  text: string;
  // 119 자동 분류 / 자동 번역 결과 (mode=diarization 응답에서 채워진다).
  role?: "caller" | "operator" | "interpreter" | "unknown" | string;
  role_reason?: string;
  role_confidence?: number;
  source_language?: string;
  target_language?: string;
  // segment 원문 → 한국어(또는 상대 언어) 자동 번역.
  translated?: string;
  // segment 단위 오류 / 사유.
  error?: string;
  reason?: string;
};

export type TranscriptionResponse = {
  // STT 가 반환한 전체 transcript (segment.text join). 항상 채워짐.
  text: string;
  segments: TranscriptSegment[];
  // 음성 파일 전체 길이(초). 백엔드가 latency.total_ms 만 줄 경우 undefined 가능.
  duration?: number;
  processing_time?: number;
  timings?: {
    load?: number;
    diarize?: number;
    asr?: number;
  };
  // ---- 119 자동 분석 / 자동 번역 필드 (mode=diarization 응답 정규화 결과) ----
  // 전체 대화에 대한 한국어(또는 신고자 언어) 통합 번역. segment 별 번역의 줄단위 결합.
  translated?: string;
  // 자동 감지된 신고자 언어 코드 (en/zh/ja/...) — 없으면 undefined.
  caller_language?: string;
  // 백엔드가 결정한 대표 화자 / 언어쌍. segments 가 있으면 segment 별 값이 더 정확.
  source_language?: string;
  target_language?: string;
  speaker?: string;
  speaker_reason?: string;
  speaker_confidence?: number;
  // 처리 모드.
  mode?: "normal" | "diarization";
  // 백엔드 latency (envelope.latency 그대로).
  latency?: {
    stt_ms?: number;
    translate_ms?: number;
    tts_ms?: number;
    total_ms?: number;
  };
  // 처리 중 발생한 오류 모음 (chunk 단위 / segment 단위).
  errors?: string[];
  // envelope.status — "ok" | "skipped" | "error".
  status?: string;
};

type MessageTranslationMap = Record<number, string>;

/**
 * 실시간 통역 화면(RealtimePage)에서 누적되는 대화 메시지 한 건.
 * ResultPage에서 이 데이터를 읽어 실시간 통역 기반 사건 기록 문서를 생성한다.
 */
// 자동 화자 판단 결과.
//   caller       — 신고자
//   operator     — 구급대원
//   interpreter  — 통역사 ("He says...", "신고자가 말하기를..." 등 메타 발화)
//   unknown      — 언어 식별 실패 또는 같은 언어 화자 간 분리 불가로 판단 보류
// (같은 언어 화자 간 완전 분리는 서버 diarization 또는 2채널 오디오가 필요 — 후속 과제.)
export type RealtimeSpeaker = "caller" | "operator" | "interpreter" | "unknown";

// 서버 화자분리 STT(실험) 응답의 segment 한 건.
// 백엔드 ems_realtime.py 의 diarization mode 가 segment 단위로 source_language,
// target_language, role 분류와 번역 결과까지 채워 보낸다 — 모두 optional 로 둬서
// normal mode 응답이나 구버전 서버에서도 그대로 파싱된다.
export type DiarizationSegment = {
  speaker: string;
  start: number;
  end: number;
  text: string;
  source_language?: string;
  target_language?: string;
  role?: "caller" | "operator" | "interpreter" | "unknown" | string;
  role_reason?: string;
  role_confidence?: number;
  translated?: string;
  error?: string;
  reason?: string;
};

export type RealtimeMessage = {
  id: number;
  timestamp: number; // 발화 시작 시각 (epoch ms)
  speaker: RealtimeSpeaker;
  speakerLabel: string; // 신고자 / 구급대원 / 통역사 / 판단 불가
  sourceLanguage: string;
  targetLanguage: string;
  original: string;
  translated: string;
  status: string;
  // 서버 envelope 의 error / reason 을 그대로 보관. translated 가 비어 있어도
  // 원문 + 실패 사유를 ResultPage 가 함께 보여줄 수 있게 한다.
  error?: string;
  // 현장형 자동 감지 구조에서 첫 신고자 발화로부터 추정한 신고자 언어 코드 (primary).
  // 발화 단위로 함께 기록되어 ResultPage가 "감지된 신고자 언어"를 표시할 수 있다.
  detectedCallerLanguage?: string;
  // 분류기(classifySpeakerRole) 출력 — UI/문서에서 근거를 표시하는 데 사용.
  speakerConfidence?: number;
  speakerReason?: string;
  // 서버 화자분리 모드(실험)에서 STT가 반환한 화자 segment 목록.
  // 단일 마이크 chunk 단위라 화자 라벨(SPK_0 등)이 chunk 간 유지되지 않을 수 있어
  // 자동 역할 판단의 근거로는 사용하지 않고 UI/문서에 참고용으로 표시한다.
  diarizationSegments?: DiarizationSegment[];
  // Local-agreement 안정화 결과.
  //   transcriptConfirmed : STT 텍스트가 dedup/중복 필터를 통과해 문서에 포함되는지 여부
  //   duplicateOfSeqId    : 이전 chunk와 동일한 발화로 판단되어 폐기된 경우 그 chunk의 seqId
  //   overlapRemoved      : 직전 chunk 끝부분과 겹쳐 자동으로 제거한 텍스트
  transcriptConfirmed?: boolean;
  duplicateOfSeqId?: number;
  overlapRemoved?: string;
  sttMs?: number;
  translateMs?: number;
  ttsMs?: number;
  ttfaMs?: number; // 발화 종료 → 첫 음성 출력 (E2E 체감 지연)
  totalMs?: number; // STT + 번역 합계
};

// 실시간 통역 세션의 메타데이터 — chunk 메시지 자체에는 담기지 않는 세션 전역 정보.
// RealtimePage가 갱신하고 ResultPage가 문서에 반영한다.
export type RealtimeMeta = {
  vadPresetKey?: string;
  vadPresetLabel?: string;
  // 검증 필터(짧은 발화/낮은 RMS/VAD misfire/환각 등)로 폐기된 chunk 수.
  // 실제 chunks 배열에는 남지 않으므로 별도 카운트.
  discardedCount?: number;
  // local-agreement으로 중복 처리되어 문서에서 제외된 chunk 수.
  duplicateCount?: number;
  // 서버 화자분리 사용 여부 (실험).
  diarizationEnabled?: boolean;
};

// ---- 문서 생성 소스 히스토리 ----
// 사용자가 업로드 분석을 여러 번 수행하거나 실시간 통역 세션을 여러 번 진행할 수 있어,
// ResultPage 에서 모든 기록을 시간순으로 나열하고 선택할 수 있어야 한다.
// 두 종류 모두 createdAt(ms) 으로 정렬해 최신순 카드 목록을 만든다.

export type UploadRecord = {
  // 동일 파일 재업로드를 식별 가능하도록 sessionId(UUID) 또는 random id 를 사용.
  id: string;
  // 업로드가 완료된 시각 (ms epoch).
  createdAt: number;
  fileName: string;
  result: TranscriptionResponse;
  // segment 별 자동 번역을 미리 채워둔 맵 (TranscriptPanel/ResultPage 가 사용).
  translations: MessageTranslationMap;
};

export type RealtimeRecord = {
  // RealtimePage 의 sessionIdRef 와 동일 — "통역 시작" 마다 새 UUID 가 생성된다.
  id: string;
  // 세션 시작 시각 (ms). realtimeSessionStart 와 동일.
  createdAt: number;
  // 세션 종료 시각 (ms). 아직 진행 중이거나 미저장이면 null.
  endedAt: number | null;
  messages: RealtimeMessage[];
  meta: RealtimeMeta;
};

type AppDataContextType = {
  transcriptionResult: TranscriptionResponse | null;
  setTranscriptionResult: (value: TranscriptionResponse | null) => void;

  selectedFileName: string;
  setSelectedFileName: (value: string) => void;

  inputLanguage: string;
  setInputLanguage: (value: string) => void;

  targetLanguage: string;
  setTargetLanguage: (value: string) => void;

  translations: MessageTranslationMap;
  setTranslations: React.Dispatch<React.SetStateAction<MessageTranslationMap>>;

  // ---- 실시간 통역 세션 ----
  realtimeMessages: RealtimeMessage[];
  setRealtimeMessages: React.Dispatch<React.SetStateAction<RealtimeMessage[]>>;
  realtimeSessionStart: number | null;
  setRealtimeSessionStart: (value: number | null) => void;
  realtimeSessionEnd: number | null;
  setRealtimeSessionEnd: (value: number | null) => void;
  realtimeMeta: RealtimeMeta;
  setRealtimeMeta: React.Dispatch<React.SetStateAction<RealtimeMeta>>;
  clearRealtimeSession: () => void;

  // ---- 문서 소스 히스토리 ----
  uploadHistory: UploadRecord[];
  realtimeHistory: RealtimeRecord[];
  upsertUploadRecord: (record: UploadRecord) => void;
  upsertRealtimeRecord: (record: RealtimeRecord) => void;
  removeUploadRecord: (id: string) => void;
  removeRealtimeRecord: (id: string) => void;
  clearAllHistory: () => void;
};

const AppDataContext = createContext<AppDataContextType | undefined>(undefined);

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const [transcriptionResult, setTranscriptionResult] =
    useState<TranscriptionResponse | null>(null);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [inputLanguage, setInputLanguage] = useState("ko");
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [translations, setTranslations] = useState<MessageTranslationMap>({});

  const [realtimeMessages, setRealtimeMessages] = useState<RealtimeMessage[]>(
    []
  );
  const [realtimeSessionStart, setRealtimeSessionStart] = useState<
    number | null
  >(null);
  const [realtimeSessionEnd, setRealtimeSessionEnd] = useState<number | null>(
    null
  );
  const [realtimeMeta, setRealtimeMeta] = useState<RealtimeMeta>({});

  const [uploadHistory, setUploadHistory] = useState<UploadRecord[]>([]);
  const [realtimeHistory, setRealtimeHistory] = useState<RealtimeRecord[]>([]);

  const clearRealtimeSession = useCallback(() => {
    setRealtimeMessages([]);
    setRealtimeSessionStart(null);
    setRealtimeSessionEnd(null);
    setRealtimeMeta({});
  }, []);

  // 동일 id 가 이미 있으면 업데이트, 없으면 새로 추가. id 가 같다는 것은
  // "같은 세션의 갱신(예: 통역 종료 후 다시 결과로 이동)" 또는 "같은 파일 재처리"
  // 를 의미하므로 카드를 두 개로 늘리지 않고 최신 내용으로 교체한다.
  const upsertUploadRecord = useCallback((record: UploadRecord) => {
    setUploadHistory((prev) => {
      const idx = prev.findIndex((r) => r.id === record.id);
      if (idx === -1) return [...prev, record];
      const next = prev.slice();
      next[idx] = record;
      return next;
    });
  }, []);

  const upsertRealtimeRecord = useCallback((record: RealtimeRecord) => {
    setRealtimeHistory((prev) => {
      const idx = prev.findIndex((r) => r.id === record.id);
      if (idx === -1) return [...prev, record];
      const next = prev.slice();
      next[idx] = record;
      return next;
    });
  }, []);

  const removeUploadRecord = useCallback((id: string) => {
    setUploadHistory((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const removeRealtimeRecord = useCallback((id: string) => {
    setRealtimeHistory((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const clearAllHistory = useCallback(() => {
    setUploadHistory([]);
    setRealtimeHistory([]);
  }, []);

  return (
    <AppDataContext.Provider
      value={{
        transcriptionResult,
        setTranscriptionResult,
        selectedFileName,
        setSelectedFileName,
        inputLanguage,
        setInputLanguage,
        targetLanguage,
        setTargetLanguage,
        translations,
        setTranslations,
        realtimeMessages,
        setRealtimeMessages,
        realtimeSessionStart,
        setRealtimeSessionStart,
        realtimeSessionEnd,
        setRealtimeSessionEnd,
        realtimeMeta,
        setRealtimeMeta,
        clearRealtimeSession,
        uploadHistory,
        realtimeHistory,
        upsertUploadRecord,
        upsertRealtimeRecord,
        removeUploadRecord,
        removeRealtimeRecord,
        clearAllHistory,
      }}
    >
      {children}
    </AppDataContext.Provider>
  );
}

export function useAppData() {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error("useAppData must be used within an AppDataProvider");
  }
  return context;
}
