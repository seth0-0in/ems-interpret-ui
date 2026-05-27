import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MicVAD, utils as vadUtils } from "@ricky0123/vad-web";
import { useAppData } from "../context/AppDataContext";
import AppHeader from "../components/AppHeader";
import { COLORS, sectionHeading, whiteCard } from "../theme";
import { LANGUAGE_OPTIONS } from "../languages";
import { apiUrl } from "../api";

// VAD 자산(worklet + ONNX 모델 + onnxruntime-web WASM)은
// public/vad/ 에 복사되어 있다. Vite의 base("/static/119/")를 반영해 서빙된다.
const VAD_ASSET_BASE = `${import.meta.env.BASE_URL}vad/`;

// ---------------------------------------------------------------------------
// Phase A 진단 로깅 (코드 로직 변경 없음 — 관찰자 패턴)
//
// `diag("event", { ... })` 로 한 줄 JSON-ish 로그를 출력한다. 운영자가
// "첫 문장 후 안 듣는" 문제를 재현하면서 브라우저 콘솔에서 [ems-rt diag]
// 로 grep 하면 VAD 콜백·placeholder·processChunk·audio queue 전 흐름이
// chunk 단위로 한 줄씩 출력된다.
//
// 결정 로직을 바꾸지 않는다 — 단지 관찰한다.
// ---------------------------------------------------------------------------
function diag(event: string, fields: Record<string, unknown> = {}): void {
  // performance.now() 를 단조 증가 타임라인으로 함께 찍어 chunk 간 간격을
  // 콘솔에서 바로 셀 수 있게 한다.
  try {
    // eslint-disable-next-line no-console
    console.log(
      `[ems-rt diag] ${event}`,
      { t: Math.round(performance.now()), ...fields }
    );
  } catch {
    // ignore
  }
}

// 자동 판단된 발화자 역할.
//   caller       — 신고자
//   operator     — 구급대원
//   interpreter  — 통역사 ("He says...", "통역해드리겠습니다" 같은 메타 발화)
//   unknown      — 언어 식별 실패 또는 같은 언어 화자 간 분리 불가로 판단 보류
// (같은 언어 화자 간 완전 분리는 서버 diarization/2채널 오디오 필요 — 후속 과제.)
type Speaker = "caller" | "operator" | "interpreter" | "unknown";

const SPEAKER_LABEL: Record<Speaker, string> = {
  caller: "신고자",
  operator: "구급대원",
  interpreter: "통역사",
  unknown: "판단 불가",
};

const SPEAKER_AUTO_LABEL: Record<Speaker, string> = {
  caller: "신고자 자동 감지",
  operator: "구급대원 자동 감지",
  interpreter: "통역사 자동 감지",
  unknown: "판단 불가",
};

function confidenceLabel(c: number): string {
  if (c >= 0.7) return "높음";
  if (c >= 0.4) return "보통";
  return "낮음";
}

function confidenceColor(c: number): string {
  if (c >= 0.7) return "#0f7b54"; // green
  if (c >= 0.4) return "#d97706"; // amber
  return "#dc2626"; // red
}

// 임의의 role 문자열(서버 segment.role / chunk.speaker 등)을 Speaker union 으로 좁힌다.
// 빈 값/모르는 값은 모두 "unknown" 으로 흡수해 UI 분기를 단순화한다.
function normalizeRole(role?: string | null): Speaker {
  if (role === "caller" || role === "operator" || role === "interpreter") {
    return role;
  }
  return "unknown";
}

// 자동 화자/역할 판단은 백엔드(/api/119/realtime/process)에서 수행한다.
// 프론트는 서버 envelope 의 speaker / source_language / target_language 만 그대로 사용.

// 서버 응답 envelope — /api/119/realtime/process 의 JSON 형식.
// 어떤 필드라도 누락되거나 다른 타입으로 올 수 있어 호출부에서 방어적으로 정규화한다.
type ServerProcessEnvelope = {
  session_id: string;
  client_seq: number;
  status: "ok" | "skipped" | "error" | string;
  text: string;
  translated: string;
  source_language: string;
  target_language: string;
  speaker: string;
  speaker_reason: string;
  speaker_confidence: number;
  segments?: unknown;
  latency?: {
    stt_ms?: number;
    translate_ms?: number;
    tts_ms?: number;
    total_ms?: number;
    // pending fragment 버퍼에 누적된 시간 — status="skipped" reason="need-more-audio"
    // 응답에서만 채워진다. 일반 ok/error 응답에는 없다.
    buffer_ms?: number;
  };
  audio_base64?: string | null;
  error?: string | null;
  reason?: string | null;
  debug_llm_shape?: unknown;
};

type ChunkStatus =
  | "recording"
  | "stt_verifying" // VAD 불확실 → STT 결과로 최종 판단 대기
  | "stt"
  | "translating"
  | "tts"
  | "playing"
  // listening: 서버가 chunk 의 STT 결과를 fragment 로 판정하여 pending 버퍼에
  // 보관 중. 카드는 "듣는 중..." 으로 유지되다가 후속 chunk 의 ok commit (또는
  // force-commit-timeout) 응답이 도착하면 해소(제거)된다.
  | "listening"
  | "done"
  | "error"
  | "empty";

// 서버 화자분리 STT(실험)가 반환하는 segment 한 건.
// diarization mode 일 때 백엔드가 segment 별로 source_language / target_language /
// role / translated 까지 채워 보낸다. 새 필드는 모두 optional 이라 normal mode
// (or 구버전 응답) 에도 안전.
type DiarizationSegment = {
  speaker: string;
  start: number;
  end: number;
  text: string;
  source_language?: string;
  target_language?: string;
  role?: Speaker | string;
  role_reason?: string;
  role_confidence?: number;
  translated?: string;
  error?: string;
  reason?: string;
};

type ChunkRecord = {
  seqId: number;
  speaker: Speaker;
  inputLang: string;
  targetLang: string;
  original: string;
  translated: string;
  status: ChunkStatus;
  startedAt: number; // 발화(녹음) 시작 시각 (epoch ms)
  error?: string;
  // 자동 화자 판단 결과 (classifySpeakerRole 출력)
  speakerConfidence?: number;
  speakerReason?: string;
  // 서버 화자분리 모드(실험)일 때만 채워지는 segment 목록.
  // 자동 역할 판단 근거로는 사용하지 않고 UI에 그대로 표시한다.
  diarizationSegments?: DiarizationSegment[];
  // 화자분리 모드로 생성된 chunk임을 표시 (UI 실험 라벨용).
  diarizationMode?: boolean;
  // Local-agreement 결과.
  transcriptConfirmed?: boolean;
  duplicateOfSeqId?: number;
  overlapRemoved?: string;
  sttMs?: number;
  translateMs?: number;
  ttsMs?: number; // average per piece for this chunk
  ttfaMs?: number; // recorder stop → first audio play (end-to-end perceived)
  totalMs?: number; // STT start → translation end
  piecesTotal?: number;
  piecesPlayed?: number;
};

// VAD 기반 발화 구간 검출 파라미터.
//   positive/negativeSpeechThreshold : silero VAD 모델 확률 임계값
//   preSpeechPadMs                    : 음성 시작 이전 prepend (말 시작 잘림 방지)
//   minSpeechMs                       : 이보다 짧은 segment는 폐기 (misfire) → STT 비호출
//   minValidSpeechMs / minValidRms    : onSpeechEnd 2차 검증 게이트
//   redemptionMs                      : 무음이 이 시간 이상이면 발화 종료로 판단
//
// 5개 프리셋:
//   quiet         — 콜센터/조용한 실내 (작은 음성도 포착, redemption 짧음)
//   normal        — 사무실/일반 (기본값)
//   noisy         — 사이렌/엔진 등 현장 (잡음 오탐 억제)
//   multilingual  — 캄/태/네팔어 등 짧고 익숙하지 않은 비영어권 발화
//                   임계값/길이 게이트를 매우 낮춰 짧은 발화도 STT까지 도달.
//                   추가로 multilingual 모드에서만: onVADMisfire가 발생해도
//                   누적 프레임이 충분(>=300ms, RMS>=0.002)하면 STT로 복구.
//   debug         — 모든 발화 통과 (진단용)
// 다음 통역 시작 시 적용된다 (녹음 중 변경 불가).
type VadProfile = {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechMs: number;
  minValidSpeechMs: number;
  minValidRms: number;
  redemptionMs: number;
};

type VadPresetKey = "quiet" | "normal" | "noisy" | "multilingual" | "debug";

const VAD_PRESETS: Record<
  VadPresetKey,
  { label: string; description: string; profile: VadProfile }
> = {
  quiet: {
    label: "조용한 환경",
    description: "콜센터/실내 — 작은 음성도 포착, 짧은 응답 우선",
    profile: {
      positiveSpeechThreshold: 0.55,
      negativeSpeechThreshold: 0.3,
      minSpeechMs: 400,
      minValidSpeechMs: 350,
      minValidRms: 0.005,
      redemptionMs: 600,
    },
  },
  normal: {
    label: "일반 환경",
    description: "기본값 — 사무실/일반 사용자",
    profile: {
      positiveSpeechThreshold: 0.65,
      negativeSpeechThreshold: 0.35,
      minSpeechMs: 500,
      minValidSpeechMs: 450,
      minValidRms: 0.008,
      redemptionMs: 800,
    },
  },
  noisy: {
    label: "시끄러운 현장 (사이렌·엔진·도로·실외)",
    description:
      "🚨 119 출동 현장 권장 프리셋 — 사이렌·엔진·도로·실외 소음에 강한 노이즈 게이트로 " +
      "공조음/배경잡음 misfire 를 강하게 억제하고, 무음 종료 임계를 1.1s 로 늘려 " +
      "끊긴 문장이 두세 chunk 로 잘리는 것을 막습니다. 짧은 긴급 외침" +
      "('Help!', '119!', '불이야!', 'Ayuda!' 등)은 RMS 가 높기 때문에 " +
      "VAD 최소 길이 게이트를 통과 못 해도 STT 복구 경로로 자동 진입합니다. " +
      "현장에서는 휴대폰을 발화자 입에서 20cm 이내로 두고, 마이크에 손가락/옷이 " +
      "닿지 않게 하세요.",
    profile: {
      // VAD 확률 임계값을 조여 카페/도로/현장 소음에서 발생하는 misfire 를 억제.
      positiveSpeechThreshold: 0.78,
      negativeSpeechThreshold: 0.48,
      // 최소 발화 길이를 늘려 짧은 잡음 spike 를 무시 — 긴급 외침은 minValidSpeechMs 보다
      // 짧더라도 RMS 0.02 이상이면 STT 복구 경로(handleSpeechEnd 의 recoverMinRms 분기)로
      // 살아남는다 (GENERAL_STT_RECOVER_MIN_RMS=0.02).
      minSpeechMs: 700,
      minValidSpeechMs: 650,
      // 잡음 RMS 평균(~0.005)보다 충분히 높은 게이트.
      minValidRms: 0.025,
      // 발화 종료 무음 시간을 1.1s 로 — 너무 짧으면 한 문장이 두세 chunk 로 잘린다.
      redemptionMs: 1100,
    },
  },
  multilingual: {
    label: "다국어 민감 모드",
    description:
      "캄/태/네팔어 등 짧고 익숙하지 않은 발화 — VAD 임계값 완화 + 짧은 misfire도 STT로 복구",
    profile: {
      positiveSpeechThreshold: 0.45,
      negativeSpeechThreshold: 0.25,
      minSpeechMs: 150,
      minValidSpeechMs: 120,
      minValidRms: 0.002,
      redemptionMs: 1200,
    },
  },
  debug: {
    label: "디버그 모드",
    description: "임계값 완화 — 실제 발화가 STT까지 가는지 확인용",
    profile: {
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.25,
      minSpeechMs: 200,
      minValidSpeechMs: 150,
      minValidRms: 0.003,
      redemptionMs: 500,
    },
  },
};

const DEFAULT_VAD_PRESET: VadPresetKey = "normal";

// 브라우저 VAD는 참고 신호일 뿐 STT 전송 여부의 절대 기준이 아니다.
// "VAD가 misfire라고 판정"하거나 "onSpeechEnd 2차 검증 게이트(minValidSpeechMs/minValidRms)에
// 실패"해도 아래 임계값 중 하나만 충족하면 발화 후보로 보고 STT로 보낸다.
// 폐기는 STT 응답이 비어있거나 환각 문장일 때만 최종 처리한다.
//   - 일반(quiet/normal/noisy/debug): 700ms 이상 OR RMS 0.02 이상
//   - 다국어 민감 모드(multilingual): 300ms 이상 OR RMS 0.002 이상
//     (캄/태/네팔어 등 짧고 작은 발화도 잡기 위해 더 관대하게)
const GENERAL_STT_RECOVER_MIN_MS = 700;
const GENERAL_STT_RECOVER_MIN_RMS = 0.02;
const MULTI_STT_RECOVER_MIN_MS = 300;
const MULTI_STT_RECOVER_MIN_RMS = 0.002;

const VAD_PRE_SPEECH_PAD_MS = 250;
const VAD_SAMPLE_RATE = 16000;

// 브라우저 DSP 명시. vad-web 의 기본 getStream 도 동일한 플래그를 사용하지만,
// 라이브러리 default 에 의존하지 않고 코드에 명시적으로 남겨 유지보수 시 시야에 들어오도록.
const EMS_MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

// Phase B diag — getUserMedia 호출 추적.
// `_emsGetMicStreamCore` 가 src 전체에서 navigator.mediaDevices.getUserMedia 를
// 부르는 유일한 진입점이다. MicVAD 의 getStream / resumeStream 은 서로 다른
// thin wrapper 를 통과하므로 [ems-rt diag] getusermedia_call 의 source 필드로
// "VAD 초기 stream" / "VAD resume stream" 호출이 각각 몇 번 발생하는지 분간된다.
// (이 프로젝트에서는 별도의 마이크 미터가 getUserMedia 를 따로 부르지 않는다 —
// MicMeter 는 VAD 의 onFrameProcessed 콜백 결과를 보여주는 단순 UI 다.)
async function _emsGetMicStreamCore(source: string): Promise<MediaStream> {
  diag("getusermedia_call", {
    source,
    constraints: EMS_MIC_CONSTRAINTS,
  });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: EMS_MIC_CONSTRAINTS,
  });
  // 받은 stream 의 첫 audio track 메타데이터를 함께 찍는다 — label/deviceId 가
  // 비교용으로 가장 직접적인 단서. (브라우저가 권한 정책으로 label 을 비울 수도 있음.)
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  diag("getusermedia_result", {
    source,
    streamId: stream.id,
    trackCount: stream.getAudioTracks().length,
    trackLabel: track?.label ?? null,
    trackEnabled: track?.enabled,
    trackMuted: track?.muted,
    trackReadyState: track?.readyState,
    deviceId: (settings as MediaTrackSettings).deviceId ?? null,
    settingsSampleRate: (settings as MediaTrackSettings).sampleRate ?? null,
    settingsChannelCount: (settings as MediaTrackSettings).channelCount ?? null,
  });
  return stream;
}

// MicVAD 의 getStream(): Promise<MediaStream> 시그니처와 호환되는 wrapper.
// 의미적으로 기존 emsGetMicStream() 호출과 동일 — 단지 호출자를 라벨링한다.
async function emsGetMicStream(): Promise<MediaStream> {
  return _emsGetMicStreamCore("vad-get");
}
// MicVAD 의 resumeStream(stream): Promise<MediaStream> 시그니처와 호환되는 wrapper.
// 기존 동작과 동일하게 새 stream 을 만들어 반환한다 (인자 stream 은 의도적으로 무시).
async function emsResumeMicStream(_prev: MediaStream): Promise<MediaStream> {
  return _emsGetMicStreamCore("vad-resume");
}
const MAX_DISCARDED_LOG = 5;
const MAX_DEV_LOG = 5;


function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}


// 발화 종료로 판정하기 위한 무음 임계값(ms). VAD의 redemptionMs로 전달된다.
// 값이 크면 한 chunk가 길어져 문장이 덜 잘리지만 latency가 커진다.
const SILENCE_OPTIONS = [
  { value: 500, label: "0.5초 (빠른 응답)" },
  { value: 800, label: "0.8초 (균형)" },
  { value: 1200, label: "1.2초 (긴 문장)" },
];

const STATUS_LABEL: Record<ChunkStatus, string> = {
  recording: "녹음 중",
  stt_verifying: "VAD 불확실 → STT 검증 중",
  stt: "음성 인식 중",
  translating: "번역 중",
  tts: "음성 합성 중",
  playing: "재생 중",
  listening: "🎧 듣는 중 (컨텍스트 누적)",
  done: "완료",
  error: "실패",
  empty: "무음",
};

const STATUS_COLOR: Record<ChunkStatus, string> = {
  recording: "#dc2626",
  stt_verifying: "#ea580c",
  stt: "#d97706",
  translating: "#1c4e8f",
  tts: "#6d44b8",
  playing: "#0e7490",
  // listening 상태 — 보라색으로 다른 처리중 상태와 구분.
  listening: "#9333ea",
  done: "#0f7b54",
  error: "#dc2626",
  empty: "#64748b",
};

const TERMINAL_STATUSES: ReadonlySet<ChunkStatus> = new Set([
  "done",
  "error",
  "empty",
]);

// VAD가 반환하는 Float32 PCM(-1~1, 16kHz, mono)을 STT 서버에 보낼 WAV Blob으로 인코딩.
// vad-web의 encodeWAV 기본값은 PCM/16kHz/1ch/16bit 이므로 그대로 사용.
function float32ToWavBlob(samples: Float32Array): Blob {
  const arrayBuffer = vadUtils.encodeWAV(samples);
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function formatMs(ms?: number): string {
  if (ms === undefined || Number.isNaN(ms)) return "-";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function langLabel(code: string): string {
  if (!code || code === "unknown") return "감지 필요";
  if (code === "auto") return "자동 감지 중";
  return LANGUAGE_OPTIONS.find((l) => l.value === code)?.label ?? code;
}


type Piece = {
  status: "pending" | "ready" | "queued" | "played" | "error";
  blob?: Blob;
};

type ChunkAudio = {
  pieces: Piece[];
  complete: boolean;
};

function RealtimePage() {
  const navigate = useNavigate();
  const {
    setRealtimeMessages,
    setRealtimeSessionStart,
    setRealtimeSessionEnd,
    setRealtimeMeta,
    clearRealtimeSession,
    upsertRealtimeRecord,
    realtimeMessages: ctxRealtimeMessages,
    realtimeMeta: ctxRealtimeMeta,
    realtimeSessionStart: ctxRealtimeSessionStart,
    realtimeSessionEnd: ctxRealtimeSessionEnd,
  } = useAppData();

  // Phase A diag — RealtimePage 컴포넌트 인스턴스 식별자.
  // mount/unmount 로그에 함께 찍어 mid-session remount 여부를 즉시 판별한다:
  //   같은 instance 가 destroy 됐다 → 진짜 unmount
  //   같은 instance 가 살아 있는데 VAD 만 사라졌다 → VAD 자체 / 외부 요인
  //   다른 instance 로 새로 mount 됐다 → React 가 컴포넌트를 교체함
  // useRef 의 lazy init 으로 첫 mount 시 한 번만 ID 발급.
  const instanceIdRef = useRef<string>("");
  if (instanceIdRef.current === "") {
    instanceIdRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
  }

  const [chunks, setChunks] = useState<ChunkRecord[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [status, setStatus] = useState("대기 중");
  // 현장형 자동 감지 구조 — 신고자 언어는 사전 선택할 수 없으므로 자동 감지된 코드만 보관.
  // null: 아직 감지 전. unknown: 감지 실패. ko/en/... : 정상 감지.
  // 신고자 언어 — 자동 감지 결과를 다중으로 누적.
  //   detectedCallerLanguage : 첫 감지된 primary. 화면/문서에서 "감지된 신고자 언어"로 표시.
  //   latestCallerLanguage   : 마지막으로 들어온 신고자 발화의 언어. operator 발화의 target.
  //   secondaryCallerLanguages : primary 외에 새로 감지된 언어들 (중복 없음).
  const [detectedCallerLanguage, setDetectedCallerLanguage] = useState<
    string | null
  >(null);
  const [latestCallerLanguage, setLatestCallerLanguage] = useState<
    string | null
  >(null);
  const [secondaryCallerLanguages, setSecondaryCallerLanguages] = useState<
    string[]
  >([]);
  const [silenceMs, setSilenceMs] = useState(800);
  const [autoTts, setAutoTts] = useState(true);
  // 실시간 마이크 게이지 (throttled: 100ms 마다 1회 setState)
  const [meter, setMeter] = useState<{ rms: number; prob: number }>({
    rms: 0,
    prob: 0,
  });
  // 최근 폐기 사유 로그 (최대 5개). 디버그 모드 + 노이즈 튜닝 가시화용.
  const [discardedLog, setDiscardedLog] = useState<
    Array<{ id: number; at: number; reason: string }>
  >([]);
  // VAD 프리셋 — 다음 통역 시작부터 적용 (녹음 중 변경 불가).
  const [vadPresetKey, setVadPresetKey] = useState<VadPresetKey>(
    DEFAULT_VAD_PRESET
  );
  // 서버 화자분리 STT(실험) 사용 여부. on일 때 /diarize 엔드포인트로 STT 전송.
  // chunk 단위 STT라서 chunk 간 SPK_x 라벨 동일성이 보장되지 않으므로 화면에 "실험 모드"임을 명시.
  const [useDiarization, setUseDiarization] = useState(false);
  // 화자분리 누적 진행 표시용 — diarizationBufferRef 와 함께 갱신되는 표시 전용 상태.
  // (ref 자체는 setState 를 트리거하지 않아 별도 state 가 필요.)
  const [diarizationStats, setDiarizationStats] = useState<{
    segments: number;
    samples: number;
  }>({ segments: 0, samples: 0 });
  // 누적 카운터 — 폐기 chunk와 local-agreement 중복 chunk는 chunks 배열에 남지 않으므로
  // 별도 카운트 후 ResultPage/파이프라인 패널에 노출한다.
  const [discardedCount, setDiscardedCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  // 개발 디버그 패널용 로그 (DEV 빌드에서만 노출).
  const [sttLog, setSttLog] = useState<
    Array<{ id: number; at: number; text: string; seqId: number }>
  >([]);
  const [roleLog, setRoleLog] = useState<
    Array<{
      id: number;
      at: number;
      seqId: number;
      speaker: Speaker;
      confidence: number;
      reason: string;
    }>
  >([]);
  const [apiErrorLog, setApiErrorLog] = useState<
    Array<{ id: number; at: number; stage: string; message: string; seqId?: number }>
  >([]);

  // VAD-driven recording state.
  // SpeechStart 시점에 seqId를 발급하고 recording chunk를 즉시 추가한다.
  // 폐기(misfire/짧음/낮은 RMS)되면 해당 row를 다시 제거해 무음 카드가 누적되지 않게 한다.
  const vadRef = useRef<MicVAD | null>(null);
  const isRecordingRef = useRef(false);
  const seqIdRef = useRef(0);
  const lastMeterUpdateAtRef = useRef(0);
  // Phase B diag — onFrameProcessed 콜백 throttle 카운터.
  // setMeter 의 100ms throttle 과 별도로, vad_frame 로그용으로 ~10 frame 마다 1회.
  const diagFrameCounterRef = useRef(0);
  // Phase B diag — 첫 onFrameProcessed 호출 시 한 번 AudioContext 상태를 다시 찍기 위한 latch.
  // (vad.start() 직후 + 첫 프레임 진입 시 — context 가 suspended 로 남는 변수 환경 감지용.)
  const diagFirstFrameLoggedRef = useRef(false);
  // 현재 발화 중인 임시 chunk의 seqId — SpeechEnd/misfire에서 사용 후 null로.
  const pendingSeqIdRef = useRef<number | null>(null);
  // 활성 VAD가 사용한 프로파일 (검증 게이트가 일관된 값을 쓰도록 캡처).
  const activeVadProfileRef = useRef<VadProfile>(VAD_PRESETS.normal.profile);
  const activeVadPresetKeyRef = useRef<VadPresetKey>(DEFAULT_VAD_PRESET);
  // SpeechStart→End/misfire 구간의 frame Float32Array 누적 버퍼.
  // (1) 폐기 로그에 durationMs/RMS 표기, (2) multilingual 프리셋의 misfire 복구에 사용.
  // vad-web이 frame 버퍼를 재사용할 수 있어 push 시 반드시 slice() 복사.
  const speechFramesRef = useRef<Float32Array[]>([]);
  // 화자분리 모드 전용 누적 버퍼.
  //   useDiarization=true 일 때 VAD speechEnd 마다 STT 로 보내지 않고
  //   이 ref 에 발화 PCM 을 모은 뒤 "통역 종료" 버튼에서 한 번에 전송한다.
  //   normal mode 에서는 절대 사용하지 않는다.
  const diarizationBufferRef = useRef<Float32Array[]>([]);
  const diarizationSamplesRef = useRef<number>(0);
  const discardedIdRef = useRef(0);
  const devLogIdRef = useRef(0);
  // 서버 측 SessionState 키. mount 시 UUID 발급, "대화 초기화" 시 새 UUID 로 교체.
  // 매 chunk 요청의 multipart 에 session_id 로 동봉되며 서버가 동일 세션의 신고자 언어/
  // 최근 텍스트 컨텍스트를 누적한다. ref 로 보관해 비동기 콜백에서도 안정적으로 참조.
  const sessionIdRef = useRef<string>("");
  if (sessionIdRef.current === "") {
    sessionIdRef.current = crypto.randomUUID();
  }

  // Ordered audio playback
  const chunkAudioMapRef = useRef<Map<number, ChunkAudio>>(new Map());
  const nextAudioSeqRef = useRef(1);
  const audioPlayChainRef = useRef<Promise<void>>(Promise.resolve());
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentResolveRef = useRef<(() => void) | null>(null);
  const playingSeqRef = useRef<number | null>(null);
  const recorderStopTimesRef = useRef<Map<number, number>>(new Map());

  // Live config mirrors — VAD 콜백은 비동기로 상태 스냅샷이 필요해 ref로 mirror.
  const autoTtsRef = useRef(autoTts);
  const useDiarizationRef = useRef(useDiarization);
  // 신고자 언어 추적 refs (primary / latest / secondary). hasKoreanCallerRef는
  // "이전에 한국어 신고자가 등장한 적이 있는가"를 분류기에 전달하기 위한 보조 ref.
  const detectedCallerLangRef = useRef<string | null>(null);
  const latestCallerLangRef = useRef<string | null>(null);
  const secondaryCallerLangsRef = useRef<string[]>([]);
  const hasKoreanCallerRef = useRef<boolean>(false);

  useEffect(() => {
    autoTtsRef.current = autoTts;
  }, [autoTts]);
  useEffect(() => {
    useDiarizationRef.current = useDiarization;
  }, [useDiarization]);
  useEffect(() => {
    detectedCallerLangRef.current = detectedCallerLanguage;
  }, [detectedCallerLanguage]);
  useEffect(() => {
    latestCallerLangRef.current = latestCallerLanguage;
  }, [latestCallerLanguage]);
  useEffect(() => {
    secondaryCallerLangsRef.current = secondaryCallerLanguages;
  }, [secondaryCallerLanguages]);

  // 새 caller 발화가 분류기에서 확정되면 호출. primary/latest/secondary를 일관되게 갱신.
  const registerCallerLanguage = (lang: string) => {
    if (!lang || lang === "unknown") return;
    if (lang === "ko") hasKoreanCallerRef.current = true;
    if (detectedCallerLangRef.current == null) {
      detectedCallerLangRef.current = lang;
      setDetectedCallerLanguage(lang);
    } else if (detectedCallerLangRef.current !== lang) {
      if (!secondaryCallerLangsRef.current.includes(lang)) {
        const next = [...secondaryCallerLangsRef.current, lang];
        secondaryCallerLangsRef.current = next;
        setSecondaryCallerLanguages(next);
      }
    }
    if (latestCallerLangRef.current !== lang) {
      latestCallerLangRef.current = lang;
      setLatestCallerLanguage(lang);
    }
  };

  useEffect(() => {
    // Phase A diag — mount-only effect.
    //   mount 시 realtime_page_mount + unmount_effect_registered
    //   cleanup 시 realtime_page_unmount + unmount_effect_cleanup
    // instanceIdRef 를 함께 찍어 동일 instance 의 mount→unmount 인지,
    // 새 instance 가 mount 되었는지 구분 가능하게 한다.
    diag("realtime_page_mount", { instance: instanceIdRef.current });
    diag("unmount_effect_registered", { instance: instanceIdRef.current });
    return () => {
      diag("realtime_page_unmount", { instance: instanceIdRef.current });
      diag("unmount_effect_cleanup", {
        instance: instanceIdRef.current,
        hadVad: vadRef.current !== null,
        isRecordingRef: isRecordingRef.current,
        // 호출 stack 을 함께 남겨 정확한 trigger 를 식별.
        // StrictMode dev 의 초기 mount→cleanup→mount 패턴이면 hadVad=false 로 무해.
        // mid-session 에 hadVad=true 로 찍히면 그게 진범.
        stack: new Error("trace").stack?.split("\n").slice(0, 12).join("\n"),
      });
      isRecordingRef.current = false;
      void teardownVad();
      cancelCurrentAudio();
      chunkAudioMapRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 실시간 대화 chunk → 전역 context(realtimeMessages)로 누적 동기화.
  // ResultPage가 이 데이터를 읽어 실시간 통역 기반 문서를 생성한다.
  useEffect(() => {
    setRealtimeMessages(
      chunks.map((c) => ({
        id: c.seqId,
        timestamp: c.startedAt,
        speaker: c.speaker,
        speakerLabel: SPEAKER_LABEL[c.speaker],
        sourceLanguage: c.inputLang,
        targetLanguage: c.targetLang,
        original: c.original,
        translated: c.translated,
        status: c.status,
        // 서버 envelope 의 error/reason 을 그대로 보존 — translated 가 비어도
        // ResultPage 가 원문 + 실패 사유를 함께 보여줄 수 있도록.
        error: c.error,
        // 현재까지 감지된 신고자 언어 (모든 message에 동일하게 전파해 ResultPage가 일관되게 표시).
        detectedCallerLanguage: detectedCallerLanguage ?? undefined,
        speakerConfidence: c.speakerConfidence,
        speakerReason: c.speakerReason,
        diarizationSegments: c.diarizationSegments,
        transcriptConfirmed: c.transcriptConfirmed,
        duplicateOfSeqId: c.duplicateOfSeqId,
        overlapRemoved: c.overlapRemoved,
        sttMs: c.sttMs,
        translateMs: c.translateMs,
        ttsMs: c.ttsMs,
        ttfaMs: c.ttfaMs,
        totalMs: c.totalMs,
      }))
    );
  }, [chunks, detectedCallerLanguage, setRealtimeMessages]);

  // discarded/duplicate 카운터 → realtimeMeta 동기화 (문서 생성 시 사용).
  useEffect(() => {
    setRealtimeMeta((prev) => ({
      ...prev,
      discardedCount,
      duplicateCount,
    }));
  }, [discardedCount, duplicateCount, setRealtimeMeta]);

  // ---------- Discarded / dev logs ----------

  // 폐기 사유 + (선택) 오디오 길이/RMS를 한 줄로 포맷.
  // 예: "폐기: VAD misfire (짧은 잡음) / 420ms / RMS 0.004"
  const addDiscarded = (
    reason: string,
    meta?: { durationMs?: number; rms?: number }
  ) => {
    const id = ++discardedIdRef.current;
    const parts: string[] = [];
    if (meta?.durationMs !== undefined) {
      parts.push(`${Math.round(meta.durationMs)}ms`);
    }
    if (meta?.rms !== undefined) {
      parts.push(`RMS ${meta.rms.toFixed(3)}`);
    }
    const line = parts.length > 0 ? `${reason} / ${parts.join(" / ")}` : reason;
    setDiscardedLog((prev) =>
      [{ id, at: Date.now(), reason: line }, ...prev].slice(0, MAX_DISCARDED_LOG)
    );
    setDiscardedCount((c) => c + 1);
  };

  const addSttLog = (seqId: number, text: string) => {
    const id = ++devLogIdRef.current;
    setSttLog((prev) =>
      [{ id, at: Date.now(), seqId, text }, ...prev].slice(0, MAX_DEV_LOG)
    );
  };

  const addRoleLog = (
    seqId: number,
    speaker: Speaker,
    confidence: number,
    reason: string
  ) => {
    const id = ++devLogIdRef.current;
    setRoleLog((prev) =>
      [
        { id, at: Date.now(), seqId, speaker, confidence, reason },
        ...prev,
      ].slice(0, MAX_DEV_LOG)
    );
  };

  const addApiError = (stage: string, message: string, seqId?: number) => {
    const id = ++devLogIdRef.current;
    setApiErrorLog((prev) =>
      [
        { id, at: Date.now(), stage, message, seqId },
        ...prev,
      ].slice(0, MAX_DEV_LOG)
    );
  };

  // ---------- Chunk mutation ----------

  const updateChunk = (
    seqId: number,
    patch:
      | Partial<ChunkRecord>
      | ((prev: ChunkRecord) => Partial<ChunkRecord>)
  ) => {
    setChunks((prev) =>
      prev.map((c) => {
        if (c.seqId !== seqId) return c;
        const p = typeof patch === "function" ? patch(c) : patch;
        return { ...c, ...p };
      })
    );
  };

  // empty/노이즈 chunk가 화면에 누적되지 않도록 행 자체를 제거.
  // audio queue 정합성을 위해 호출 전 반드시 skipChunkAudio(seqId)도 함께 호출할 것.
  const removeChunk = (seqId: number) => {
    diag("placeholder_remove", { seqId });
    setChunks((prev) => prev.filter((c) => c.seqId !== seqId));
  };

  // 변경 1 — listening placeholder 해소 헬퍼.
  // 어떤 chunk 가 ok/error/done 응답으로 commit 되었을 때, 그 chunk 의 seqId 보다
  // 작은 seqId 의 listening placeholder 들은 이미 서버 pending 에서 이 chunk 안으로
  // 흡수(또는 force-commit) 된 stale fragment 들이므로 제거한다.
  // 진단 로그: 해소된 seqId 목록 + 해소 사유 (force-commit-timeout 여부 포함).
  // 진단 패널의 sttLog 에도 한 줄 남겨 사용자가 한눈에 볼 수 있게 한다.
  const resolveEarlierListening = (
    committedSeqId: number,
    byReason: string | null
  ) => {
    let clearedSeqIds: number[] = [];
    setChunks((prev) => {
      clearedSeqIds = prev
        .filter((c) => c.status === "listening" && c.seqId < committedSeqId)
        .map((c) => c.seqId);
      if (clearedSeqIds.length === 0) return prev;
      return prev.filter(
        (c) => !(c.status === "listening" && c.seqId < committedSeqId)
      );
    });
    if (clearedSeqIds.length > 0) {
      diag("placeholder_resolved", {
        resolvedBy: committedSeqId,
        cleared: clearedSeqIds,
        clearedCount: clearedSeqIds.length,
        reason: byReason,
        forceCommitTimeout: byReason === "force-commit-timeout",
      });
      const label =
        byReason === "force-commit-timeout"
          ? `🚀 force-commit(timeout) → 듣는중 ${clearedSeqIds.length}건 해소`
          : `✅ commit(seq#${committedSeqId}) → 듣는중 ${clearedSeqIds.length}건 해소`;
      setSttLog((prev) =>
        [
          {
            id: ++devLogIdRef.current,
            at: Date.now(),
            seqId: committedSeqId,
            text: label,
          },
          ...prev,
        ].slice(0, MAX_DEV_LOG)
      );
    }
  };

  // ---------- API calls ----------

  // 단일 서버 엔드포인트(/api/119/realtime/process)로 chunk 전송.
  // 백엔드가 STT → 화자/언어 자동 판단 → 번역 → TTS 까지 전부 처리해 envelope 으로 반환한다.
  // 프론트에서는 더 이상 STT/번역/TTS 엔드포인트를 개별 호출하지 않는다.
  const processChunkOnServer = async (
    blob: Blob,
    seqId: number,
    mode: "normal" | "diarization"
  ): Promise<ServerProcessEnvelope> => {
    const form = new FormData();
    // VAD 가 만든 chunk 는 WAV. file.content_type 은 서버 측 mime 추정에 사용되므로 그대로 보존.
    const ext = blob.type.includes("wav") ? "wav" : "webm";
    form.append("file", blob, `chunk-${seqId}.${ext}`);
    form.append("session_id", sessionIdRef.current);
    form.append("client_seq", String(seqId));
    form.append("mode", mode);
    // 서버 메모리가 휘발됐을 때 신고자 언어 컨텍스트를 부트스트랩할 수 있도록 hint 로 전달.
    const prevCallerLang = latestCallerLangRef.current;
    if (prevCallerLang) {
      form.append("previous_caller_language", prevCallerLang);
    }

    // API 는 항상 서버 루트 (/api/...) 로 나간다 — 정적 자산 base (/static/119/) 와 분리.
    // dev / preview / 운영 모두 "/api/119/realtime/process" 로 동일.
    // 브라우저가 현재 origin (localhost / ai2.jb.go.kr 등) 을 자동 prefix.
    const requestUrl = apiUrl("/api/119/realtime/process");
    // chunk 마다 호출되므로 빈도 폭주를 막기 위해 첫 호출에서만 baseUrl 까지 풀로
    // 한 번 찍고, 이후 호출은 mode/seq 단위의 요약만 남긴다.
    diag("process_request_url", {
      seqId,
      mode,
      url: requestUrl,
      baseUrl: import.meta.env.BASE_URL,
    });

    const res = await fetch(requestUrl, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`process ${res.status}: ${t.slice(0, 200)}`);
    }
    return (await res.json()) as ServerProcessEnvelope;
  };

  // 서버가 audio_base64 (mp3) 를 보내준 경우 ArrayBuffer→Blob 으로 변환해
  // 기존 ordered audio queue 에 넣는다. 한 chunk = 한 piece(idx=0) 로 처리.
  const decodeBase64Audio = (b64: string, mime = "audio/mpeg"): Blob => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  };

  // 서버 응답의 speaker 문자열(런타임 신뢰 불가)을 UI 의 Speaker union 으로 좁힌다.
  const normalizeServerSpeaker = (s: unknown): Speaker => {
    if (s === "caller" || s === "operator" || s === "interpreter") return s;
    return "unknown";
  };

  // 서버 segments 는 항상 배열로 오지만 빈 배열이면 UI 에 표시할 게 없으므로 undefined.
  // diarization mode 에서는 segment 별로 source_language / target_language / role /
  // role_confidence / translated / error / reason 가 추가로 들어온다 — 모두 optional 로
  // 안전하게 파싱해 normal mode segment(필드 없음)도 동일 코드로 처리한다.
  const normalizeServerSegments = (
    segs: unknown
  ): DiarizationSegment[] | undefined => {
    if (!Array.isArray(segs) || segs.length === 0) return undefined;
    const out: DiarizationSegment[] = [];
    for (const s of segs) {
      if (!s || typeof s !== "object") continue;
      const seg = s as Record<string, unknown>;
      const text = String(seg.text ?? "").trim();
      if (!text) continue;
      const optString = (v: unknown): string | undefined => {
        if (typeof v !== "string") return undefined;
        const t = v.trim();
        return t ? t : undefined;
      };
      const optNumber = (v: unknown): number | undefined => {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string" && v.trim() !== "") {
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        }
        return undefined;
      };
      out.push({
        speaker: String(seg.speaker ?? ""),
        start: Number(seg.start ?? 0),
        end: Number(seg.end ?? 0),
        text,
        source_language: optString(seg.source_language),
        target_language: optString(seg.target_language),
        role: optString(seg.role),
        role_reason: optString(seg.role_reason),
        role_confidence: optNumber(seg.role_confidence),
        translated: optString(seg.translated),
        error: optString(seg.error),
        reason: optString(seg.reason),
      });
    }
    return out.length > 0 ? out : undefined;
  };

  // ---------- Audio queue (ordered by seqId, sub-ordered by pieceIdx) ----------

  const initChunkAudio = (seqId: number) => {
    if (seqId < nextAudioSeqRef.current) {
      diag("queue_init_skip_stale", {
        seqId,
        nextAudioSeq: nextAudioSeqRef.current,
      });
      return; // dropped (flushed past)
    }
    if (chunkAudioMapRef.current.has(seqId)) return;
    chunkAudioMapRef.current.set(seqId, { pieces: [], complete: false });
    diag("queue_init", {
      seqId,
      nextAudioSeq: nextAudioSeqRef.current,
      mapSize: chunkAudioMapRef.current.size,
    });
  };

  const ensurePieceSlot = (audio: ChunkAudio, idx: number) => {
    while (audio.pieces.length <= idx) {
      audio.pieces.push({ status: "pending" });
    }
  };

  const setPieceReady = (seqId: number, idx: number, blob: Blob) => {
    const audio = chunkAudioMapRef.current.get(seqId);
    if (!audio) return;
    ensurePieceSlot(audio, idx);
    const p = audio.pieces[idx];
    if (
      p.status === "played" ||
      p.status === "error" ||
      p.status === "queued"
    )
      return;
    audio.pieces[idx] = { status: "ready", blob };
    drainAudio();
  };

  const markChunkAudioComplete = (seqId: number, totalPieces: number) => {
    const audio = chunkAudioMapRef.current.get(seqId);
    if (!audio) return;
    while (audio.pieces.length < totalPieces) {
      audio.pieces.push({ status: "pending" });
    }
    audio.complete = true;
    drainAudio();
  };

  const skipChunkAudio = (seqId: number) => {
    if (seqId < nextAudioSeqRef.current) {
      diag("queue_skip_stale", {
        seqId,
        nextAudioSeq: nextAudioSeqRef.current,
      });
      return;
    }
    const audio = chunkAudioMapRef.current.get(seqId);
    if (audio) {
      audio.complete = true;
    } else {
      chunkAudioMapRef.current.set(seqId, { pieces: [], complete: true });
    }
    diag("queue_skip", {
      seqId,
      nextAudioSeq: nextAudioSeqRef.current,
      mapSize: chunkAudioMapRef.current.size,
    });
    drainAudio();
  };

  const drainAudio = () => {
    while (true) {
      const seq = nextAudioSeqRef.current;
      const audio = chunkAudioMapRef.current.get(seq);
      if (!audio) {
        diag("queue_drain_wait", {
          waitingFor: seq,
          mapSize: chunkAudioMapRef.current.size,
          mapKeys: [...chunkAudioMapRef.current.keys()],
        });
        break;
      }

      const allTerminal = audio.pieces.every(
        (p) => p.status === "played" || p.status === "error"
      );
      if (allTerminal && audio.complete) {
        chunkAudioMapRef.current.delete(seq);
        nextAudioSeqRef.current = seq + 1;
        diag("queue_advance", {
          from: seq,
          to: nextAudioSeqRef.current,
          remainingMapSize: chunkAudioMapRef.current.size,
        });
        updateChunk(seq, (prev) => {
          if (prev.status === "error" || prev.status === "empty") return {};
          return { status: "done" };
        });
        continue;
      }

      const idx = audio.pieces.findIndex((p) => p.status !== "played");
      if (idx === -1) {
        diag("queue_drain_no_pending_piece", {
          seq,
          complete: audio.complete,
          piecesLen: audio.pieces.length,
        });
        break; // no pieces yet → wait
      }
      const piece = audio.pieces[idx];
      if (piece.status === "pending" || piece.status === "queued") {
        diag("queue_drain_piece_busy", {
          seq,
          pieceIdx: idx,
          pieceStatus: piece.status,
        });
        break;
      }
      if (piece.status === "error") {
        audio.pieces[idx] = { status: "played" };
        continue;
      }
      if (piece.status === "ready" && piece.blob) {
        audio.pieces[idx] = { status: "queued" };
        playOneAudio(seq, idx, piece.blob);
        continue;
      }
      break;
    }
  };

  const playOneAudio = (
    seqId: number,
    pieceIdx: number,
    blob: Blob
  ) => {
    const url = URL.createObjectURL(blob);
    const prev = audioPlayChainRef.current;
    audioPlayChainRef.current = (async () => {
      try {
        await prev;
      } catch {
        // ignore prior errors
      }
      // If the audio map was flushed/cleared for this chunk, drop the piece.
      if (!chunkAudioMapRef.current.has(seqId)) {
        URL.revokeObjectURL(url);
        return;
      }

      if (pieceIdx === 0) {
        const stoppedAt = recorderStopTimesRef.current.get(seqId);
        if (stoppedAt !== undefined) {
          const ttfa = performance.now() - stoppedAt;
          updateChunk(seqId, (cur) =>
            cur.ttfaMs === undefined ? { ttfaMs: ttfa } : {}
          );
        }
      }

      updateChunk(seqId, (cur) =>
        cur.status === "error" || cur.status === "empty"
          ? {}
          : { status: "playing" }
      );

      await new Promise<void>((resolve) => {
        const audio = new Audio(url);
        currentAudioRef.current = audio;
        currentResolveRef.current = resolve;
        playingSeqRef.current = seqId;
        const done = () => {
          URL.revokeObjectURL(url);
          if (currentAudioRef.current === audio) {
            currentAudioRef.current = null;
            currentResolveRef.current = null;
            playingSeqRef.current = null;
          }
          resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        audio.play().catch(done);
      });

      const audioState = chunkAudioMapRef.current.get(seqId);
      if (audioState && audioState.pieces[pieceIdx]) {
        audioState.pieces[pieceIdx] = { status: "played" };
      }
      updateChunk(seqId, (cur) => ({
        piecesPlayed: (cur.piecesPlayed ?? 0) + 1,
      }));
      drainAudio();
    })();
  };

  const cancelCurrentAudio = () => {
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
      } catch {
        // ignore
      }
    }
    if (currentResolveRef.current) {
      try {
        currentResolveRef.current();
      } catch {
        // ignore
      }
      currentResolveRef.current = null;
    }
    currentAudioRef.current = null;
    playingSeqRef.current = null;
  };

  const flushAudio = () => {
    cancelCurrentAudio();
    chunkAudioMapRef.current.clear();
    audioPlayChainRef.current = Promise.resolve();
    nextAudioSeqRef.current = seqIdRef.current + 1;
    setChunks((prev) =>
      prev.map((c) => {
        if (TERMINAL_STATUSES.has(c.status)) return c;
        if (c.status === "tts" || c.status === "playing") {
          return { ...c, status: "done" as ChunkStatus };
        }
        return c;
      })
    );
  };

  // ---------- Chunk pipeline (server-first) ----------
  //
  // 모든 chunk 는 단일 서버 엔드포인트 /api/119/realtime/process 로 전송된다.
  // 서버가 STT → 화자/언어 자동 판단 → 번역 → TTS 까지 수행하고 단일 envelope 으로 응답.
  // 프론트는 envelope 의 필드를 그대로 ChunkRecord 에 매핑하고, audio_base64 가 있으면
  // 기존 ordered audio queue 에 한 piece(idx=0) 로 enqueue 한다.
  const processChunk = async (
    blob: Blob,
    seqId: number,
    recorderStoppedAt: number,
    // VAD가 미심쩍다고 판단한 발화 후보(미스파이어 복구/2차 검증 실패).
    // 서버 STT 결과로 최종 채택 여부를 결정하므로 시작 상태를 "stt_verifying"으로 표시한다.
    uncertain = false
  ) => {
    recorderStopTimesRef.current.set(seqId, recorderStoppedAt);
    initChunkAudio(seqId);
    const t0 = performance.now();

    const useDiarize = useDiarizationRef.current;
    const mode: "normal" | "diarization" = useDiarize ? "diarization" : "normal";
    diag("process_in", {
      seqId,
      mode,
      uncertain,
      blobBytes: blob.size,
      blobType: blob.type,
      nextAudioSeq: nextAudioSeqRef.current,
      chunkAudioMapSize: chunkAudioMapRef.current.size,
      pendingSeqId: pendingSeqIdRef.current,
      isRecordingRef: isRecordingRef.current,
    });
    updateChunk(seqId, {
      status: uncertain ? "stt_verifying" : "stt",
      diarizationMode: useDiarize ? true : undefined,
    });

    // ---- 서버 호출 (단일 트랜잭션) ----
    let env: ServerProcessEnvelope;
    try {
      env = await processChunkOnServer(blob, seqId, mode);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "서버 처리 오류";
      addApiError("Process", msg, seqId);
      diag("process_out", {
        seqId,
        outcome: "fetch-failed",
        error: msg,
        durationMs: Math.round(performance.now() - t0),
      });
      updateChunk(seqId, {
        status: "error",
        error: msg,
        totalMs: performance.now() - t0,
      });
      skipChunkAudio(seqId);
      return;
    }
    diag("process_response", {
      seqId,
      status: env.status,
      reason: env.reason ?? null,
      text_len: (env.text ?? "").length,
      translated_len: (env.translated ?? "").length,
      source_language: env.source_language,
      target_language: env.target_language,
      speaker: env.speaker,
      speaker_confidence: env.speaker_confidence,
      has_audio: !!env.audio_base64,
      segments_count: Array.isArray(env.segments) ? env.segments.length : 0,
      stt_ms: env.latency?.stt_ms,
      translate_ms: env.latency?.translate_ms,
      tts_ms: env.latency?.tts_ms,
      total_ms: env.latency?.total_ms,
      buffer_ms: env.latency?.buffer_ms,
      e2e_ms: Math.round(performance.now() - t0),
    });

    // ---- envelope 정규화 ----
    const speaker = normalizeServerSpeaker(env.speaker);
    const inputLang = env.source_language || "unknown";
    const targetLang = env.target_language || "unknown";
    const segments = normalizeServerSegments(env.segments);
    const latency = env.latency || {};
    const latencyPatch: Partial<ChunkRecord> = {
      sttMs: latency.stt_ms,
      translateMs: latency.translate_ms,
      ttsMs: latency.tts_ms,
      totalMs: latency.total_ms ?? performance.now() - t0,
    };
    const reason = env.reason || null;

    // overlap-removed:<tail> reason 을 chunk 의 overlapRemoved 필드로 직접 노출.
    let overlapRemoved: string | undefined;
    if (reason && reason.startsWith("overlap-removed:")) {
      const tail = reason.slice("overlap-removed:".length);
      overlapRemoved = tail || undefined;
    }

    // 변경 1 — 이 응답이 fragment(need-more-audio) 가 아니면, 이전의 listening
    // placeholder 들은 서버 pending 에서 흡수/force-commit 되어 stale 이므로 제거.
    // force-commit-timeout 인 경우에는 사용자/운영자에게 그 사실이 보이도록 한다.
    const isAnotherFragmentResponse =
      env.status === "skipped" && reason === "need-more-audio";
    if (!isAnotherFragmentResponse) {
      resolveEarlierListening(seqId, reason);
    }

    // ---- status === "skipped" ----
    // 서버가 chunk 자체를 폐기한 경우. 사유별로 UI 처리.
    if (env.status === "skipped") {
      // (0) need-more-audio — 짧고 불완전한 STT 결과가 서버 pending 버퍼에 누적됨.
      // chunk 자체는 폐기 카드/오류 카드로 표시하지 말고 조용히 제거한다.
      // (다음 chunk 가 합쳐서 commit 되면 그때 새로운 chunk 카드로 등장.)
      // 폐기 카운터를 올리지 않고 별도 pending 안내만 로그.
      if (reason === "need-more-audio") {
        // 변경 1 — 카드를 제거하지 않고 "듣는 중..." 으로 유지한다.
        // 이렇게 해야 (a) 사용자가 "발화가 사라지지 않았다" 는 신호를 보고,
        // (b) 다음 chunk 의 ok commit (또는 force-commit-timeout) 이 도착하면
        // 그 placeholder 가 정상 해소되는지 진단할 수 있다.
        // audio queue 는 즉시 advance — listening placeholder 가 다음 chunk 의
        // 오디오 재생을 막지 않게 한다.
        skipChunkAudio(seqId);
        const fragmentPreview = (env.text || "").trim();
        const bufferMs = env.latency?.buffer_ms;
        updateChunk(seqId, {
          status: "listening",
          original: fragmentPreview,
          // language/role 은 서버가 fragment 단계에서 확정하지 않으므로 그대로 둔다.
          ...latencyPatch,
        });
        diag("placeholder_listening", {
          seqId,
          fragmentHead: fragmentPreview.slice(0, 60),
          bufferMs,
        });
        diag("process_out", {
          seqId,
          outcome: "skipped-need-more-audio-listening",
          buffer_ms: bufferMs,
        });
        const previewSuffix = fragmentPreview
          ? ` · "${fragmentPreview.slice(0, 40)}${
              fragmentPreview.length > 40 ? "…" : ""
            }"`
          : "";
        const ageSuffix =
          bufferMs !== undefined ? ` · ${Math.round(bufferMs)}ms 누적` : "";
        // 디버그 로그용 — discardedCount 는 건드리지 않는다.
        setSttLog((prev) =>
          [
            {
              id: ++devLogIdRef.current,
              at: Date.now(),
              seqId,
              text: `🎧 듣는 중${ageSuffix}${previewSuffix}`,
            },
            ...prev,
          ].slice(0, MAX_DEV_LOG)
        );
        return;
      }
      // (1) 무음/환각/완전 겹침 — 카드 자체를 제거 (기존 동작과 동일).
      if (
        reason === "audio-too-short" ||
        reason === "stt-empty-or-hallucinated" ||
        reason === "overlap-empty"
      ) {
        diag("process_out", {
          seqId,
          outcome: "skipped-discarded",
          reason,
        });
        skipChunkAudio(seqId);
        removeChunk(seqId);
        addDiscarded(`서버 폐기: ${reason}`);
        return;
      }
      // (2) 중복 발화 — chunk row 는 유지하되 transcriptConfirmed=false 로 표시 (문서 제외).
      if (reason && reason.startsWith("duplicate-of-")) {
        const dupSeq = Number(reason.slice("duplicate-of-".length));
        diag("process_out", {
          seqId,
          outcome: "skipped-duplicate",
          reason,
          dupSeq,
        });
        updateChunk(seqId, {
          original: env.text,
          ...latencyPatch,
          transcriptConfirmed: false,
          duplicateOfSeqId: Number.isFinite(dupSeq) ? dupSeq : undefined,
          status: "done",
          translated: "",
          error: `직전 chunk #${dupSeq}와 동일한 발화 — 중복 제거 (문서 제외)`,
        });
        addDiscarded(`중복 발화: chunk #${dupSeq} 와 동일`);
        setDuplicateCount((c) => c + 1);
        skipChunkAudio(seqId);
        return;
      }
      // (3) 그 외 — no-translation-target 등. 카드 유지, done.
      if (speaker === "caller" && inputLang && inputLang !== "unknown") {
        registerCallerLanguage(inputLang);
      }
      if (env.text) addSttLog(seqId, env.text);
      if (env.speaker || env.speaker_reason) {
        addRoleLog(
          seqId,
          speaker,
          env.speaker_confidence ?? 0,
          env.speaker_reason || ""
        );
      }
      updateChunk(seqId, {
        original: env.text,
        translated: env.translated || "",
        inputLang,
        targetLang,
        speaker,
        speakerReason: env.speaker_reason,
        speakerConfidence: env.speaker_confidence,
        diarizationSegments: segments,
        transcriptConfirmed: !!env.text,
        overlapRemoved,
        ...latencyPatch,
        error: reason || undefined,
        status: "done",
      });
      diag("process_out", {
        seqId,
        outcome: "skipped-other",
        reason: reason ?? "skipped",
        speaker,
        inputLang,
        targetLang,
      });
      addDiscarded(`서버 처리: ${reason ?? "skipped"}`);
      skipChunkAudio(seqId);
      return;
    }

    // ---- status === "error" / "ok" 공통 — chunk 기본 필드 채우기 ----
    if (speaker === "caller" && inputLang && inputLang !== "unknown") {
      registerCallerLanguage(inputLang);
    }
    if (env.text) addSttLog(seqId, env.text);
    if (env.speaker || env.speaker_reason) {
      addRoleLog(
        seqId,
        speaker,
        env.speaker_confidence ?? 0,
        env.speaker_reason || ""
      );
    }

    updateChunk(seqId, {
      original: env.text,
      translated: env.translated || "",
      inputLang,
      targetLang,
      speaker,
      speakerReason: env.speaker_reason,
      speakerConfidence: env.speaker_confidence,
      diarizationSegments: segments,
      transcriptConfirmed: !!env.text,
      overlapRemoved,
      ...latencyPatch,
    });

    // ---- status === "error" ----
    // 카드는 남기고 빨간 실패로 표시. 원문(env.text)이 있으면 함께 보여주기 위해 위 patch 에서 채움.
    if (env.status === "error") {
      const errMsg = env.error || reason || "서버 처리 실패";
      diag("process_out", {
        seqId,
        outcome: "error",
        reason,
        error: errMsg,
      });
      updateChunk(seqId, { status: "error", error: errMsg });
      addApiError("Process", errMsg, seqId);
      skipChunkAudio(seqId);
      return;
    }

    // ---- status === "ok" + audio_base64 → TTS queue ----
    // 서버가 합성한 mp3 가 같이 오면 기존 ordered audio chain 에 한 piece 로 enqueue.
    // autoTts 가 꺼져 있으면 재생하지 않고 done 처리.
    if (env.audio_base64 && autoTtsRef.current) {
      try {
        const audioBlob = decodeBase64Audio(env.audio_base64, "audio/mpeg");
        updateChunk(seqId, (cur) =>
          TERMINAL_STATUSES.has(cur.status)
            ? { piecesTotal: 1 }
            : { status: "tts", piecesTotal: 1 }
        );
        setPieceReady(seqId, 0, audioBlob);
        markChunkAudioComplete(seqId, 1);
        diag("process_out", {
          seqId,
          outcome: "ok-with-audio",
          speaker,
          inputLang,
          targetLang,
          audioBytes: audioBlob.size,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "오디오 디코드 실패";
        console.error("audio_base64 decode error", e);
        addApiError("TTS", msg, seqId);
        updateChunk(seqId, (cur) =>
          TERMINAL_STATUSES.has(cur.status) ? {} : { status: "done" }
        );
        diag("process_out", {
          seqId,
          outcome: "ok-audio-decode-failed",
          error: msg,
        });
        skipChunkAudio(seqId);
      }
      return;
    }

    // ---- ok 이지만 오디오 없음 — 번역 텍스트만으로 완료. ----
    updateChunk(seqId, (cur) =>
      TERMINAL_STATUSES.has(cur.status) ? {} : { status: "done" }
    );
    diag("process_out", {
      seqId,
      outcome: "ok-no-audio",
      speaker,
      inputLang,
      targetLang,
      autoTtsOn: autoTtsRef.current,
    });
    skipChunkAudio(seqId);
  };

  // ---------- VAD-driven recording ----------
  //
  // silero VAD가 검출한 발화 구간 경계로 chunk를 생성한다.
  // 단, 브라우저 VAD는 작은 음성/어눌한 발음/주변 소음에서 misfire가 잦으므로
  // STT 전송 여부의 절대 기준으로 쓰지 않는다 — 어디까지나 "참고 신호".
  // 실제 발화 후보의 최종 판단은 서버 STT 응답(빈/환각 여부)에 위임한다.
  //
  //   onSpeechStart    → 새 seqId 예약 + "recording" chunk 추가
  //   onSpeechEnd      → 16kHz Float32 PCM을 WAV로 인코딩 후 processChunk 호출.
  //                      길이/RMS 1차 게이트를 통과하면 정상 STT,
  //                      통과 못해도 STT 복구 임계값(일반 700ms·0.02, 다국어 300ms·0.002)
  //                      중 하나만 충족하면 "stt_verifying" 상태로 STT 검증 진입.
  //                      이후 translate(stream) → TTS → audio queue 흐름은 동일.
  //   onVADMisfire     → 너무 짧다고 판정된 segment. 누적 frame 길이/RMS가 위 복구
  //                      임계값을 충족하면 "stt_verifying"으로 STT 검증, 아니면 폐기.

  const teardownVad = async () => {
    const vad = vadRef.current;
    // Phase A diag — 누가 teardownVad 를 부르는지 정확한 call site 를 기록.
    // 정상 trigger 는 3 곳뿐: handleStop / handleStart catch / unmount cleanup.
    // 그 외에서 stack 이 가리키면 그게 진범.
    diag("teardown_vad_called", {
      hadVad: vad !== null,
      isRecordingRef: isRecordingRef.current,
      stack: new Error("trace").stack?.split("\n").slice(0, 12).join("\n"),
    });
    vadRef.current = null;
    if (vad) {
      try {
        await vad.destroy();
        diag("teardown_vad_destroyed", {});
      } catch (e) {
        console.error("VAD destroy 실패", e);
        diag("teardown_vad_destroy_error", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  // SpeechStart 시점에 임시 "recording" chunk를 즉시 추가한다.
  // 발화가 검증을 통과하지 못하면 (misfire/짧음/낮은 RMS) 해당 row를
  // 다시 제거해 무음 카드가 누적되는 것을 막는다.
  const discardPendingChunk = (
    reason: string,
    meta?: { durationMs?: number; rms?: number }
  ) => {
    const seqId = pendingSeqIdRef.current;
    pendingSeqIdRef.current = null;
    if (seqId !== null) {
      // audio queue도 진전시켜야 다음 chunk가 막히지 않는다.
      skipChunkAudio(seqId);
      removeChunk(seqId);
    }
    addDiscarded(reason, meta);
  };

  // 화자 자동 판단 모드 — SpeechStart 시점에는 누구의 발화인지 알 수 없으므로
  // speaker="unknown" 임시 chunk(placeholder)를 추가한다. STT/언어 식별이 끝나면
  // processChunk가 speaker/inputLang/targetLang을 채워 넣는다.
  const handleSpeechStart = () => {
    diag("vad_start", {
      isRecordingRef: isRecordingRef.current,
      useDiarize: useDiarizationRef.current,
      pendingSeqIdBefore: pendingSeqIdRef.current,
      nextAudioSeq: nextAudioSeqRef.current,
      lastAssignedSeq: seqIdRef.current,
      chunkAudioMapSize: chunkAudioMapRef.current.size,
    });
    if (!isRecordingRef.current) {
      diag("vad_start_ignored_not_recording", {});
      return;
    }
    setIsSpeaking(true);
    speechFramesRef.current = [];

    // 화자분리 모드 — 발화별 placeholder chunk 를 만들지 않는다.
    // 모든 발화는 buffer 에 누적된 뒤 "통역 종료" 시 한 번에 처리되므로 화면에
    // 임시 chunk 가 깜박이는 것을 피한다. misfire 복구용 speechFramesRef 는 그대로 사용.
    if (useDiarizationRef.current) return;

    // 이전 임시 chunk가 정리되지 않은 채 새 발화가 시작된 경우 — 안전 정리.
    if (pendingSeqIdRef.current !== null) {
      const prevSeq = pendingSeqIdRef.current;
      pendingSeqIdRef.current = null;
      diag("placeholder_orphan_cleanup", { prevSeq });
      skipChunkAudio(prevSeq);
      removeChunk(prevSeq);
    }

    const seqId = ++seqIdRef.current;
    pendingSeqIdRef.current = seqId;
    diag("placeholder_create", { seqId, nextAudioSeq: nextAudioSeqRef.current });

    setChunks((prev) => [
      ...prev,
      {
        seqId,
        speaker: "unknown",
        inputLang: "auto",
        targetLang: "auto",
        original: "",
        translated: "",
        status: "recording",
        startedAt: Date.now(),
      },
    ]);
  };

  // 누적된 SpeechStart→End/misfire frame 버퍼를 단일 Float32Array로 병합.
  const flushAccumulatedFrames = (): Float32Array | null => {
    const frames = speechFramesRef.current;
    speechFramesRef.current = [];
    if (frames.length === 0) return null;
    const total = frames.reduce((sum, f) => sum + f.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const f of frames) {
      merged.set(f, offset);
      offset += f.length;
    }
    return merged;
  };

  // 화자분리 모드 한정 — 발화 단위 PCM 을 차곡차곡 buffer 에 쌓고 UI 카운터를 동기화한다.
  // vad-web 이 같은 Float32Array 버퍼를 재사용할 수 있어 반드시 slice() 복사본을 push.
  const appendToDiarizationBuffer = (audio: Float32Array) => {
    if (!audio || audio.length === 0) return;
    diarizationBufferRef.current.push(audio.slice());
    diarizationSamplesRef.current += audio.length;
    setDiarizationStats({
      segments: diarizationBufferRef.current.length,
      samples: diarizationSamplesRef.current,
    });
  };

  // 화자분리 버퍼를 단일 Float32Array 로 병합 후 비운다.
  const drainDiarizationBuffer = (): Float32Array | null => {
    const frames = diarizationBufferRef.current;
    diarizationBufferRef.current = [];
    diarizationSamplesRef.current = 0;
    if (frames.length === 0) return null;
    const total = frames.reduce((sum, f) => sum + f.length, 0);
    if (total === 0) return null;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const f of frames) {
      merged.set(f, offset);
      offset += f.length;
    }
    return merged;
  };

  const resetDiarizationBuffer = () => {
    diarizationBufferRef.current = [];
    diarizationSamplesRef.current = 0;
    setDiarizationStats({ segments: 0, samples: 0 });
  };

  // 인식된 오디오를 STT 파이프라인으로 진입시킨다. pending chunk가 있으면 reuse,
  // 없으면 새 placeholder를 추가한다 (handleSpeechEnd와 misfire 복구가 공유).
  // uncertain=true는 VAD가 확정하지 못한 발화 후보를 STT 결과로 검증하는 경로.
  // UI에는 "VAD 불확실 → STT 검증 중" 상태로 표시된다.
  const enterSttPipeline = (
    audio: Float32Array,
    recorderStoppedAt: number,
    durationMs: number,
    uncertain = false
  ) => {
    const wavBlob = float32ToWavBlob(audio);
    if (wavBlob.size === 0) {
      discardPendingChunk("폐기: WAV 인코딩 실패", {
        durationMs,
        rms: computeRms(audio),
      });
      return;
    }

    const startStatus: ChunkStatus = uncertain ? "stt_verifying" : "stt";
    let seqId = pendingSeqIdRef.current;
    pendingSeqIdRef.current = null;
    if (seqId === null) {
      seqId = ++seqIdRef.current;
      const newSeqId = seqId;
      setChunks((prev) => [
        ...prev,
        {
          seqId: newSeqId,
          speaker: "unknown",
          inputLang: "auto",
          targetLang: "auto",
          original: "",
          translated: "",
          status: startStatus,
          startedAt: Date.now() - Math.round(durationMs),
        },
      ]);
    } else {
      updateChunk(seqId, {
        status: startStatus,
        startedAt: Date.now() - Math.round(durationMs),
      });
    }

    void processChunk(wavBlob, seqId, recorderStoppedAt, uncertain);
  };

  const handleSpeechEnd = (audio: Float32Array) => {
    diag("vad_end_enter", {
      isRecordingRef: isRecordingRef.current,
      useDiarize: useDiarizationRef.current,
      pendingSeqId: pendingSeqIdRef.current,
      audioLen: audio.length,
      audioDurMs: Math.round((audio.length / VAD_SAMPLE_RATE) * 1000),
      audioRms: Number(computeRms(audio).toFixed(4)),
    });
    setIsSpeaking(false);
    // SpeechEnd가 호출되면 misfire 복구용 누적 버퍼는 더 이상 필요 없다.
    speechFramesRef.current = [];

    // 화자분리 모드 — 발화 단위로 서버에 보내지 않고 buffer 에만 누적한다.
    // isRecordingRef 가 이미 false 가 된 상태(teardown 도중 flush 된 마지막 발화 포함)에서도
    // 누적하도록 isRecording 체크보다 먼저 분기. handleStop 이 종료 직전 buffer 를 한 번에 전송.
    if (useDiarizationRef.current) {
      const durMs = (audio.length / VAD_SAMPLE_RATE) * 1000;
      const rms = computeRms(audio);
      // 명백한 잡음(짧고 약함)은 누적에서 제외 — 일반 모드와 동일한 보수적 게이트.
      const isMulti = activeVadPresetKeyRef.current === "multilingual";
      const recoverMinMs = isMulti
        ? MULTI_STT_RECOVER_MIN_MS
        : GENERAL_STT_RECOVER_MIN_MS;
      const recoverMinRms = isMulti
        ? MULTI_STT_RECOVER_MIN_RMS
        : GENERAL_STT_RECOVER_MIN_RMS;
      if (durMs >= recoverMinMs || rms >= recoverMinRms) {
        appendToDiarizationBuffer(audio);
      } else {
        addDiscarded("화자분리 누적 제외: 잡음 임계값 미만", {
          durationMs: durMs,
          rms,
        });
      }
      return;
    }

    if (!isRecordingRef.current) {
      diag("vad_end_decision", { action: "abort-not-recording" });
      // 정지 중 — 임시 chunk가 남아있다면 정리.
      if (pendingSeqIdRef.current !== null) {
        discardPendingChunk("녹음 종료");
      }
      return;
    }
    const recorderStoppedAt = performance.now();
    const profile = activeVadProfileRef.current;
    const isMulti = activeVadPresetKeyRef.current === "multilingual";

    const durationMs = (audio.length / VAD_SAMPLE_RATE) * 1000;
    const rms = computeRms(audio);

    // 브라우저 VAD는 참고용. 길이/RMS 2차 게이트를 통과하지 못한 발화 후보라도
    // STT 복구 임계값을 충족하면 STT로 보내고, 빈/환각 응답일 때만 최종 폐기한다.
    const passesPrimary =
      durationMs >= profile.minValidSpeechMs && rms >= profile.minValidRms;
    if (passesPrimary) {
      diag("vad_end_decision", {
        action: "enter-stt-pipeline",
        gate: "primary",
        durationMs: Math.round(durationMs),
        rms: Number(rms.toFixed(4)),
        thrMs: profile.minValidSpeechMs,
        thrRms: profile.minValidRms,
      });
      enterSttPipeline(audio, recorderStoppedAt, durationMs);
      return;
    }

    const recoverMinMs = isMulti
      ? MULTI_STT_RECOVER_MIN_MS
      : GENERAL_STT_RECOVER_MIN_MS;
    const recoverMinRms = isMulti
      ? MULTI_STT_RECOVER_MIN_RMS
      : GENERAL_STT_RECOVER_MIN_RMS;
    if (durationMs >= recoverMinMs || rms >= recoverMinRms) {
      diag("vad_end_decision", {
        action: "enter-stt-pipeline",
        gate: "recover-uncertain",
        durationMs: Math.round(durationMs),
        rms: Number(rms.toFixed(4)),
        recoverMinMs,
        recoverMinRms,
      });
      // VAD 2차 게이트 실패 — 그러나 길이/에너지가 STT 검증 가치가 있어 uncertain 경로로 진입.
      enterSttPipeline(audio, recorderStoppedAt, durationMs, true);
      return;
    }

    diag("vad_end_decision", {
      action: "discard-below-thresholds",
      durationMs: Math.round(durationMs),
      rms: Number(rms.toFixed(4)),
      recoverMinMs,
      recoverMinRms,
    });
    // 임계값 미만 — 명확히 잡음으로 판단되는 경우에만 STT 전송 전 폐기.
    discardPendingChunk(
      durationMs < recoverMinMs && rms < recoverMinRms
        ? "폐기: 길이·RMS 모두 임계값 미만"
        : "폐기: STT 검증 임계값 미만",
      { durationMs, rms }
    );
  };

  // VAD misfire (segment < minSpeechMs로 판정된 짧은 segment).
  // 브라우저 VAD를 STT 전송 여부의 절대 기준으로 쓰지 않는다 — 누적 프레임의 길이/RMS가
  // 의미 발화 가능성을 충분히 보일 때 STT까지 보내고 빈/환각 여부로 최종 판단한다.
  //   일반 모드(quiet/normal/noisy/debug): durationMs >= 700ms OR RMS >= 0.02
  //   다국어 민감 모드(multilingual)      : durationMs >= 300ms OR RMS >= 0.002
  // 일반 모드에서 RMS가 높은 짧은 외침("도와줘요!" 등)도 살리기 위해 OR 조건.
  const handleVadMisfire = () => {
    diag("vad_misfire_enter", {
      isRecordingRef: isRecordingRef.current,
      useDiarize: useDiarizationRef.current,
      pendingSeqId: pendingSeqIdRef.current,
      accumulatedFrames: speechFramesRef.current.length,
    });
    setIsSpeaking(false);

    // 화자분리 모드 — misfire 라도 누적 임계값을 넘으면 buffer 로 합류.
    // (음운 사이 짧은 호흡으로 끊긴 발화도 일괄 분석 대상에 포함시키기 위함.)
    if (useDiarizationRef.current) {
      const merged = flushAccumulatedFrames();
      if (merged) {
        const durMs = (merged.length / VAD_SAMPLE_RATE) * 1000;
        const rms = computeRms(merged);
        const isMulti = activeVadPresetKeyRef.current === "multilingual";
        const recoverMinMs = isMulti
          ? MULTI_STT_RECOVER_MIN_MS
          : GENERAL_STT_RECOVER_MIN_MS;
        const recoverMinRms = isMulti
          ? MULTI_STT_RECOVER_MIN_RMS
          : GENERAL_STT_RECOVER_MIN_RMS;
        if (durMs >= recoverMinMs || rms >= recoverMinRms) {
          appendToDiarizationBuffer(merged);
          return;
        }
        addDiscarded("화자분리 misfire 누적 제외: 임계값 미만", {
          durationMs: durMs,
          rms,
        });
      }
      return;
    }

    const isMulti = activeVadPresetKeyRef.current === "multilingual";
    const merged = flushAccumulatedFrames();
    const durationMs = merged
      ? (merged.length / VAD_SAMPLE_RATE) * 1000
      : 0;
    const rms = merged ? computeRms(merged) : 0;

    if (merged !== null) {
      const recoverMinMs = isMulti
        ? MULTI_STT_RECOVER_MIN_MS
        : GENERAL_STT_RECOVER_MIN_MS;
      const recoverMinRms = isMulti
        ? MULTI_STT_RECOVER_MIN_RMS
        : GENERAL_STT_RECOVER_MIN_RMS;
      if (durationMs >= recoverMinMs || rms >= recoverMinRms) {
        // misfire는 항상 uncertain 경로 — STT 결과 검증 후 채택/폐기.
        enterSttPipeline(merged, performance.now(), durationMs, true);
        return;
      }
    }

    const meta = merged ? { durationMs, rms } : undefined;
    discardPendingChunk("폐기: VAD misfire · 임계값 미만 (STT 미전송)", meta);
  };

  const handleFrameProcessed = (
    probs: { isSpeech: number; notSpeech: number },
    frame: Float32Array
  ) => {
    // Phase B diag — 첫 프레임이 실제로 들어왔을 때 AudioContext 상태를 한 번 더 찍는다.
    // vad.start() 직후 로그가 "suspended" 였더라도 첫 프레임 시점엔 "running" 이어야 정상.
    if (!diagFirstFrameLoggedRef.current) {
      diagFirstFrameLoggedRef.current = true;
      try {
        type VadPrivates = { _audioContext: AudioContext | null };
        const ctx = (vadRef.current as unknown as VadPrivates | null)
          ?._audioContext ?? null;
        diag("vad_audioctx_first_frame", {
          state: ctx?.state ?? "null",
          sampleRate: ctx?.sampleRate ?? null,
          resumed: ctx?.state === "running",
          firstFrameLen: frame.length,
          firstProbSpeech: Number(probs.isSpeech.toFixed(3)),
          firstFrameRms: Number(computeRms(frame).toFixed(4)),
        });
      } catch (e) {
        diag("vad_audioctx_first_frame_failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // Phase B diag — VAD 프레임 도달 + 음성 확률 + RMS.
    //   콜백이 한 번도 안 불림  → 프레임 미도달 ((a) 스트림/노드 연결 문제)
    //   불리는데 rms 도 ~0      → VAD 가 무음 stream 을 물고 있음 ((a/b))
    //   rms 는 큰데 prob 만 ~0  → VAD 내부 (threshold / 샘플레이트 / 모델 입력) ((c))
    //   prob 이 threshold 를 넘는데도 vad_start 안 뜸 → 콜백/배선 ((c))
    // 매 프레임마다 찍으면 콘솔이 폭주하므로 ~10 frame (대략 300ms) 에 1회만 로그.
    // throttle 은 meter setState 와 별개로 관리한다.
    diagFrameCounterRef.current += 1;
    if (diagFrameCounterRef.current >= 10) {
      diagFrameCounterRef.current = 0;
      diag("vad_frame", {
        prob: Number(probs.isSpeech.toFixed(3)),
        notSpeech: Number(probs.notSpeech.toFixed(3)),
        rms: Number(computeRms(frame).toFixed(4)),
        frameLen: frame.length,
        recording: isRecordingRef.current,
        speaking: pendingSeqIdRef.current !== null,
      });
    }
    // SpeechStart~End/misfire 구간의 프레임을 항상 보관 — 폐기 로그(durationMs/RMS)
    // 및 multilingual 모드의 misfire 복구에 사용. vad-web이 frame 버퍼를 재사용하므로
    // 반드시 slice() 복사본을 저장한다.
    if (pendingSeqIdRef.current !== null) {
      speechFramesRef.current.push(frame.slice());
    }
    const now = performance.now();
    // 100ms throttle — 매 frame(30Hz+)마다 setState하면 re-render 폭주.
    if (now - lastMeterUpdateAtRef.current < 100) return;
    lastMeterUpdateAtRef.current = now;
    setMeter({ rms: computeRms(frame), prob: probs.isSpeech });
  };

  const handleStart = async () => {
    if (isRecording) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("이 브라우저는 마이크를 지원하지 않습니다.");
      return;
    }

    seqIdRef.current = 0;
    nextAudioSeqRef.current = 1;
    pendingSeqIdRef.current = null;
    speechFramesRef.current = [];
    resetDiarizationBuffer();
    chunkAudioMapRef.current = new Map();
    recorderStopTimesRef.current = new Map();
    audioPlayChainRef.current = Promise.resolve();
    cancelCurrentAudio();
    setChunks([]);
    setDiscardedLog([]);
    setDiscardedCount(0);
    setDuplicateCount(0);
    setSttLog([]);
    setRoleLog([]);
    setApiErrorLog([]);
    // 새 대화 시작 — 서버 측 SessionState 도 새로 시작하도록 UUID 갱신.
    sessionIdRef.current = crypto.randomUUID();
    setDetectedCallerLanguage(null);
    setLatestCallerLanguage(null);
    setSecondaryCallerLanguages([]);
    detectedCallerLangRef.current = null;
    latestCallerLangRef.current = null;
    secondaryCallerLangsRef.current = [];
    hasKoreanCallerRef.current = false;
    setMeter({ rms: 0, prob: 0 });
    lastMeterUpdateAtRef.current = 0;
    setRealtimeSessionStart(Date.now());
    setRealtimeSessionEnd(null);
    isRecordingRef.current = true;
    setIsRecording(true);
    setIsSpeaking(false);
    setStatus("VAD 로딩 중...");

    const preset = VAD_PRESETS[vadPresetKey];
    const profile = preset.profile;
    activeVadProfileRef.current = profile;
    activeVadPresetKeyRef.current = vadPresetKey;
    setRealtimeMeta({
      vadPresetKey,
      vadPresetLabel: preset.label,
      discardedCount: 0,
      duplicateCount: 0,
      diarizationEnabled: useDiarization,
    });

    try {
      const vad = await MicVAD.new({
        model: "v5",
        baseAssetPath: VAD_ASSET_BASE,
        onnxWASMBasePath: VAD_ASSET_BASE,
        positiveSpeechThreshold: profile.positiveSpeechThreshold,
        negativeSpeechThreshold: profile.negativeSpeechThreshold,
        preSpeechPadMs: VAD_PRE_SPEECH_PAD_MS,
        minSpeechMs: profile.minSpeechMs,
        // 프리셋의 redemptionMs를 silenceMs 슬라이더로 override 가능 (둘 중 큰 값을 사용).
        redemptionMs: Math.max(profile.redemptionMs, silenceMs),
        // pause 시점에 진행 중이던 발화도 마감되도록.
        submitUserSpeechOnPause: true,
        // 브라우저 DSP 를 명시적으로 활성화. 라이브러리 default 가 동일한 플래그를 쓰지만,
        // 의존하지 않고 코드에 직접 표기 — 향후 다른 마이크 옵션(deviceId 선택 등)을
        // 끼워 넣을 때도 여기서 한 줄로 처리할 수 있다.
        getStream: emsGetMicStream,
        resumeStream: emsResumeMicStream,
        onSpeechStart: handleSpeechStart,
        onSpeechEnd: handleSpeechEnd,
        onVADMisfire: handleVadMisfire,
        onFrameProcessed: handleFrameProcessed,
      });
      vadRef.current = vad;
      diagFrameCounterRef.current = 0;
      // 다음 vad_frame 로그에서 "첫 발화 시도 시점" AudioContext 상태도 한 번 더
      // 찍도록 플래그를 리셋.
      diagFirstFrameLoggedRef.current = false;
      await vad.start();
      diag("vad_started", {
        preset: vadPresetKey,
        positiveThr: profile.positiveSpeechThreshold,
        negativeThr: profile.negativeSpeechThreshold,
        minSpeechMs: profile.minSpeechMs,
        redemptionMs: Math.max(profile.redemptionMs, silenceMs),
        preSpeechPadMs: VAD_PRE_SPEECH_PAD_MS,
        useDiarize: useDiarization,
        sessionId: sessionIdRef.current,
      });

      // ----- Phase B diag — VAD 시작 직후 AudioContext / track / sampleRate 캡처.
      //
      // vad-web 의 MicVAD 인스턴스는 _audioContext / _stream / _vadNode 를 private
      // 필드로 보유한다. 라이브러리 내부 구현(real-time-vad.js) 을 직접 읽어 확인.
      // 진단 목적으로 한 번 들여다볼 뿐이며 외부 코드가 수정·교체하지 않는다.
      try {
        type VadPrivates = {
          _audioContext: AudioContext | null;
          _stream: MediaStream | null;
        };
        const privates = vad as unknown as VadPrivates;
        const ctx = privates._audioContext;
        const stream = privates._stream;

        if (ctx) {
          // AudioContext 가 suspended 상태로 남아 있으면 frame 자체가 안 흐른다.
          // 브라우저 autoplay 정책으로 user gesture 없이 만들어진 context 는
          // suspended 가 기본값 — "통역 시작" 버튼 클릭이 gesture 이므로 resume 까지
          // 정상이어야 한다. resume() 을 명시적으로 호출하지 않고 현재 상태만 관찰한다.
          diag("vad_audioctx", {
            state: ctx.state,
            sampleRate: ctx.sampleRate,
            resumed: ctx.state === "running",
            baseLatency: (ctx as AudioContext & { baseLatency?: number })
              .baseLatency,
            outputLatency: (ctx as AudioContext & { outputLatency?: number })
              .outputLatency,
          });
          diag("samplerate", {
            // 이 프로젝트에서는 미터/VAD 가 동일 AudioContext 를 공유한다 — 미터는
            // VAD 의 onFrameProcessed 콜백 결과를 화면에 그릴 뿐 별도 AudioContext 를
            // 생성하지 않는다. 따라서 meter == vadCtx 가 정상.
            meter: ctx.sampleRate,
            vadCtx: ctx.sampleRate,
            vadModelInput: VAD_SAMPLE_RATE,
            match: ctx.sampleRate === VAD_SAMPLE_RATE,
          });
        } else {
          diag("vad_audioctx", { state: "null", note: "MicVAD._audioContext is null" });
        }

        if (stream) {
          const track = stream.getAudioTracks()[0];
          const settings = track?.getSettings?.() ?? {};
          diag("vad_track", {
            streamId: stream.id,
            label: track?.label ?? null,
            enabled: track?.enabled,
            muted: track?.muted,
            readyState: track?.readyState,
            deviceId: (settings as MediaTrackSettings).deviceId ?? null,
            settingsSampleRate:
              (settings as MediaTrackSettings).sampleRate ?? null,
            settingsChannelCount:
              (settings as MediaTrackSettings).channelCount ?? null,
            settingsEchoCancellation:
              (settings as MediaTrackSettings).echoCancellation ?? null,
            settingsNoiseSuppression:
              (settings as MediaTrackSettings).noiseSuppression ?? null,
            settingsAutoGainControl:
              (settings as MediaTrackSettings).autoGainControl ?? null,
          });
          // meter_source — 이 프로젝트에서는 MicMeter UI 가 VAD frame 결과를
          // 그대로 표시한다 (별도 stream/AudioContext/AnalyserNode 없음).
          // 즉 sameStreamAsVad / sameAudioContextAsVad 는 정의상 true.
          // 만약 향후 별도 미터가 추가되면 이 로그 위치에 비교가 추가돼야 한다.
          diag("meter_source", {
            label: track?.label ?? null,
            deviceId: (settings as MediaTrackSettings).deviceId ?? null,
            sameStreamAsVad: true,
            sameAudioContextAsVad: true,
            note:
              "MicMeter 는 VAD onFrameProcessed 결과를 표시하는 단순 UI — " +
              "별도 getUserMedia/AudioContext 없음.",
          });
        } else {
          diag("vad_track", { note: "MicVAD._stream is null" });
        }
      } catch (probeErr) {
        diag("vad_probe_failed", {
          error:
            probeErr instanceof Error ? probeErr.message : String(probeErr),
        });
      }
      setStatus(
        useDiarization
          ? "🧪 화자분리 녹음 중 (종료 시 일괄 분석)"
          : "녹음 중"
      );
    } catch (e) {
      console.error("VAD 초기화 실패", e);
      diag("vad_start_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      setStatus("마이크 권한 또는 VAD 초기화 실패");
      isRecordingRef.current = false;
      setIsRecording(false);
      setIsSpeaking(false);
      await teardownVad();
    }
  };

  const handleStop = async () => {
    // useDiarizationRef.current 는 checkbox 가 녹음 중 disabled 라 안정적이지만,
    // teardown/await 도중 state 가 바뀔 가능성을 차단하기 위해 시작 시점에 캡처.
    const wasDiarize = useDiarizationRef.current;

    diag("vad_stop_called", {
      wasDiarize,
      pendingSeqId: pendingSeqIdRef.current,
      nextAudioSeq: nextAudioSeqRef.current,
      chunkAudioMapSize: chunkAudioMapRef.current.size,
      // Phase A diag — 정적 분석상 handleStop 의 진입 경로는 "통역 종료" 버튼
      // (line 2676) 또는 "결과 문서로 이동" 버튼 (line 2702 → handleGoToResult)
      // 두 곳뿐이다. stack 으로 어느 버튼인지 / 다른 경로가 있는지 확정한다.
      stack: new Error("trace").stack?.split("\n").slice(0, 12).join("\n"),
    });
    isRecordingRef.current = false;
    setIsSpeaking(false);
    await teardownVad();
    // teardown 도중 SpeechEnd가 발생해 임시 chunk가 남아있을 수 있으니 정리.
    if (pendingSeqIdRef.current !== null) {
      const seqId = pendingSeqIdRef.current;
      pendingSeqIdRef.current = null;
      skipChunkAudio(seqId);
      removeChunk(seqId);
    }
    speechFramesRef.current = [];
    setIsRecording(false);
    setMeter({ rms: 0, prob: 0 });
    // 녹음 종료 시각 자동 저장
    setRealtimeSessionEnd(Date.now());

    if (wasDiarize) {
      // 누적된 발화 buffer 를 단일 WAV 로 합쳐 mode="diarization" 으로 한 번 전송.
      const merged = drainDiarizationBuffer();
      if (merged && merged.length > 0) {
        const wavBlob = float32ToWavBlob(merged);
        if (wavBlob.size > 0) {
          const seqId = ++seqIdRef.current;
          const durationMs = (merged.length / VAD_SAMPLE_RATE) * 1000;
          initChunkAudio(seqId);
          setChunks((prev) => [
            ...prev,
            {
              seqId,
              speaker: "unknown",
              inputLang: "auto",
              targetLang: "auto",
              original: "",
              translated: "",
              status: "stt",
              startedAt: Date.now() - Math.round(durationMs),
              diarizationMode: true,
            },
          ]);
          setStatus("🧪 화자분리 일괄 분석 중...");
          // useDiarizationRef.current === true 이므로 processChunk 내부 mode 분기가
          // "diarization" 으로 동작 — 별도 modeOverride 인자 없이 그대로 호출.
          void processChunk(wavBlob, seqId, performance.now()).then(() => {
            setStatus("대기 중");
          });
          return;
        }
      }
      // 누적된 유효 발화가 없음 — 일반 종료 흐름.
      addDiscarded("화자분리 누적된 유효 발화 없음");
    }

    setStatus("대기 중");
  };

  const handleFlushAudio = () => {
    flushAudio();
    setStatus(isRecordingRef.current ? "녹음 중" : "대기 중");
  };

  // 대화 초기화 — 실수 방지를 위해 confirm 확인
  const handleClearConversation = () => {
    if (isRecording || chunks.length === 0) return;
    const ok = window.confirm(
      "현재 실시간 대화 기록을 모두 삭제하시겠습니까?\n삭제한 기록은 복구할 수 없습니다."
    );
    if (!ok) return;
    cancelCurrentAudio();
    chunkAudioMapRef.current.clear();
    recorderStopTimesRef.current.clear();
    seqIdRef.current = 0;
    nextAudioSeqRef.current = 1;
    audioPlayChainRef.current = Promise.resolve();
    resetDiarizationBuffer();
    setChunks([]);
    setDiscardedLog([]);
    setDiscardedCount(0);
    setDuplicateCount(0);
    setSttLog([]);
    setRoleLog([]);
    setApiErrorLog([]);
    // 새 대화 시작 — 서버 측 SessionState 도 새로 시작하도록 UUID 갱신.
    sessionIdRef.current = crypto.randomUUID();
    setDetectedCallerLanguage(null);
    setLatestCallerLanguage(null);
    setSecondaryCallerLanguages([]);
    detectedCallerLangRef.current = null;
    latestCallerLangRef.current = null;
    secondaryCallerLangsRef.current = [];
    hasKoreanCallerRef.current = false;
    clearRealtimeSession();
    setStatus("대기 중");
  };

  // 결과 문서 화면으로 이동 — 진행 중이면 먼저 안전하게 종료한 뒤 이동한다.
  // handleStop 이 비동기로 audio teardown / 마지막 chunk flush 를 수행하므로 await 한다.
  // (await 하지 않으면 history 에 종료 시각이 누락된 채로 record 가 push 될 수 있다.)
  const handleGoToResult = async () => {
    if (isRecording) {
      await handleStop();
    }
    navigate("/result");
  };

  // 현재 세션을 history 에 upsert — sessionIdRef.current 를 key 로 하여 같은 세션의
  // 갱신은 카드를 중복 생성하지 않고 최신 messages/meta/endedAt 으로 교체한다.
  // ctxRealtimeMessages / ctxRealtimeSessionStart / End / Meta 가 바뀔 때마다 실행되므로
  // 녹음 중에도 history 가 실시간 반영된다. (chunk 수가 많아도 history 배열은 짧아 비용이 작다.)
  useEffect(() => {
    if (ctxRealtimeSessionStart == null) return;
    if (ctxRealtimeMessages.length === 0) return;
    if (!sessionIdRef.current) return;
    upsertRealtimeRecord({
      id: sessionIdRef.current,
      createdAt: ctxRealtimeSessionStart,
      endedAt: ctxRealtimeSessionEnd,
      messages: ctxRealtimeMessages,
      meta: ctxRealtimeMeta,
    });
  }, [
    ctxRealtimeMessages,
    ctxRealtimeSessionStart,
    ctxRealtimeSessionEnd,
    ctxRealtimeMeta,
    upsertRealtimeRecord,
  ]);

  // ---------- Derived state ----------

  const summary = useMemo(() => {
    let translatedChunks = 0;
    let sttSum = 0;
    let sttCount = 0;
    let trSum = 0;
    let trCount = 0;
    let ttsSum = 0;
    let ttsChunkCount = 0;
    let ttfaSum = 0;
    let ttfaCount = 0;
    let totalSum = 0;
    let totalCount = 0;
    let errors = 0;
    let recording = 0;
    let processing = 0;
    let playing = 0;
    let done = 0;
    let unknown = 0;
    let backlog = 0;
    for (const c of chunks) {
      if (c.status === "error") errors++;
      if (c.status === "recording") recording++;
      if (
        c.status === "stt_verifying" ||
        c.status === "stt" ||
        c.status === "translating" ||
        c.status === "tts"
      )
        processing++;
      if (c.status === "playing") playing++;
      if (c.status === "done") done++;
      if (c.speaker === "unknown" && c.original) unknown++;
      // 큐 backlog = 번역/TTS/재생 대기 중인 chunk
      if (
        c.status === "translating" ||
        c.status === "tts" ||
        c.status === "playing"
      ) {
        backlog++;
      }
      if (c.sttMs !== undefined && c.status !== "error") {
        sttSum += c.sttMs;
        sttCount++;
      }
      if (c.translateMs !== undefined && c.status !== "error") {
        trSum += c.translateMs;
        trCount++;
        translatedChunks++;
      }
      if (
        c.ttsMs !== undefined &&
        c.piecesTotal !== undefined &&
        c.piecesTotal > 0
      ) {
        ttsSum += c.ttsMs;
        ttsChunkCount++;
      }
      if (c.ttfaMs !== undefined) {
        ttfaSum += c.ttfaMs;
        ttfaCount++;
      }
      if (
        c.totalMs !== undefined &&
        c.status !== "empty" &&
        c.status !== "error"
      ) {
        totalSum += c.totalMs;
        totalCount++;
      }
    }
    return {
      errors,
      recording,
      processing,
      playing,
      done,
      unknown,
      backlog,
      translatedChunks,
      sttAvg: sttCount ? sttSum / sttCount : 0,
      trAvg: trCount ? trSum / trCount : 0,
      ttsAvg: ttsChunkCount ? ttsSum / ttsChunkCount : 0,
      ttfaAvg: ttfaCount ? ttfaSum / ttfaCount : 0,
      totalAvg: totalCount ? totalSum / totalCount : 0,
    };
  }, [chunks]);

  // ---------- Render ----------

  return (
    <div style={{ minHeight: "100vh", backgroundColor: COLORS.pageBg }}>
      <AppHeader subtitle="실시간 양방향 음성 통역 · 음성인식 · 번역 · 음성합성" />

      <main
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: "24px 24px 64px",
        }}
      >
        <PageTitle
          title="실시간 통역"
          desc="신고자와 구급대원의 발화를 실시간으로 인식·번역·음성 합성합니다."
        />

        {/* 1. 상태 중심 대시보드 */}
        <section style={{ ...whiteCard, marginBottom: 18 }}>
          <div style={sectionHeading}>실시간 상태 대시보드</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 12,
            }}
          >
            <StatTile
              label="통역 상태"
              value={
                !isRecording
                  ? "대기 중"
                  : useDiarization
                  ? isSpeaking
                    ? "🧪 화자분리 녹음 중 — 발화 누적"
                    : "🧪 화자분리 녹음 중 — 무음 대기"
                  : isSpeaking
                  ? "음성 감지 중 — 자동 화자 판단"
                  : "무음 — 대기"
              }
              accent={
                !isRecording
                  ? COLORS.slate
                  : isSpeaking
                  ? COLORS.red
                  : COLORS.amber
              }
              pulse={isRecording && isSpeaking}
            />
            <StatTile
              label="평균 음성인식 (STT)"
              value={summary.sttAvg ? formatMs(summary.sttAvg) : "—"}
              accent={COLORS.amber}
            />
            <StatTile
              label="평균 번역"
              value={summary.trAvg ? formatMs(summary.trAvg) : "—"}
              accent={COLORS.navy}
            />
            <StatTile
              label="평균 음성합성 (TTS)"
              value={summary.ttsAvg ? formatMs(summary.ttsAvg) : "—"}
              accent={COLORS.violet}
            />
            <StatTile
              label="평균 응답지연 (E2E)"
              value={summary.ttfaAvg ? formatMs(summary.ttfaAvg) : "—"}
              accent={COLORS.green}
            />
          </div>

          <div
            style={{
              marginTop: 14,
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
            }}
          >
            <LiveChip label="녹음" n={summary.recording} color={COLORS.red} />
            <LiveChip
              label="처리 중"
              n={summary.processing}
              color={COLORS.navy}
            />
            <LiveChip
              label="재생 중"
              n={summary.playing}
              color={COLORS.green}
            />
            <LiveChip label="완료" n={summary.done} color={COLORS.slate} />
            <LiveChip label="오류" n={summary.errors} color={COLORS.red} />
            <LiveChip
              label="총 대화"
              n={chunks.length}
              color={COLORS.ink}
              suffix="건"
            />
            <span
              style={{
                marginLeft: "auto",
                fontSize: 13,
                color: COLORS.inkMuted,
              }}
            >
              현재 상태:{" "}
              <strong style={{ color: COLORS.ink }}>{status}</strong>
            </span>
          </div>
          {isRecording && (
            <div
              style={{
                marginTop: 12,
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
                padding: "8px 12px",
                backgroundColor: COLORS.track,
                border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 8,
              }}
            >
              <MicMeter
                rms={meter.rms}
                prob={meter.prob}
                threshold={activeVadProfileRef.current.positiveSpeechThreshold}
              />
            </div>
          )}
          <DiscardedLogPanel
            log={discardedLog}
            debugMode={vadPresetKey === "debug"}
          />
          <div
            style={{
              marginTop: 10,
              fontSize: 11.5,
              color: COLORS.inkMuted,
            }}
          >
            E2E = 발화 종료 → 첫 통역 음성 출력까지의 체감 지연 · 마이크
            게이지가 노이즈에만 반응한다면 마이크/주변 환경을 확인하세요.
          </div>
        </section>

        {/* 2. 실시간 파이프라인 상태 */}
        <PipelineStatusPanel
          totalChunks={chunks.length}
          successChunks={summary.done}
          errorChunks={summary.errors}
          discardedCount={discardedCount}
          duplicateCount={duplicateCount}
          unknownChunks={summary.unknown}
          backlog={summary.backlog}
          sttAvg={summary.sttAvg}
          trAvg={summary.trAvg}
          ttsAvg={summary.ttsAvg}
          ttfaAvg={summary.ttfaAvg}
          presetLabel={VAD_PRESETS[vadPresetKey].label}
          detectedCallerLanguage={detectedCallerLanguage}
          secondaryCallerLanguages={secondaryCallerLanguages}
          diarizationEnabled={useDiarization}
        />

        {/* 3. 통역 설정 */}
        <section style={{ ...whiteCard, marginBottom: 18 }}>
          <div style={sectionHeading}>통역 설정</div>

          {/* 자동 감지 상태 표시 — 119 현장형 구조에서는 신고자 언어를 사전에 알 수 없으므로
              감지된 결과만 표시한다. 수동 언어 선택 UI는 제거됨. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 14,
            }}
          >
            <DetectedLangTile
              title="신고자 언어 (1차 감지)"
              code={detectedCallerLanguage}
              latestCode={latestCallerLanguage}
              secondary={secondaryCallerLanguages}
              autoDetect
            />
            <DetectedLangTile
              title="구급대원 언어"
              code="ko"
              autoDetect={false}
            />
            <div>
              <label style={fieldLabelStyle}>발화 종료 무음 임계값</label>
              <select
                value={silenceMs}
                onChange={(e) => setSilenceMs(Number(e.target.value))}
                disabled={isRecording}
                style={lightSelectStyle}
              >
                {SILENCE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ marginTop: 18 }}>
            <label style={fieldLabelStyle}>자동 화자 판단</label>
            <div
              style={{
                marginTop: 8,
                padding: "12px 14px",
                borderRadius: 10,
                backgroundColor: COLORS.track,
                border: `1px solid ${COLORS.cardBorder}`,
                color: COLORS.inkSoft,
                fontSize: 13.5,
                lineHeight: 1.65,
              }}
            >
              <div style={{ fontWeight: 700, color: COLORS.ink }}>
                발화 언어에 따라 신고자/구급대원이 자동으로 판단됩니다.
              </div>
              <ul
                style={{
                  margin: "6px 0 0",
                  paddingLeft: 18,
                  fontSize: 12.5,
                  color: COLORS.inkMuted,
                }}
              >
                <li>한국어 발화 → 🚑 구급대원으로 자동 분류, 신고자 언어로 통역</li>
                <li>한국어가 아닌 발화 → 🆘 신고자로 자동 분류, 한국어로 통역</li>
                <li>언어 식별 불가 → 판단 불가로 표시, 원문만 기록</li>
                <li>
                  같은 언어 화자 분리(예: 한국어 신고자/구급대원 동시 발화)는
                  현재 단계에서 지원하지 않습니다 — 서버 diarization 또는
                  2채널 오디오 도입 시 고도화 예정.
                </li>
              </ul>
            </div>
          </div>

          <label
            style={{
              marginTop: 16,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 14,
              color: COLORS.inkSoft,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={autoTts}
              onChange={(e) => setAutoTts(e.target.checked)}
              style={{ width: 17, height: 17 }}
            />
            번역 결과 음성(TTS) 자동 재생
          </label>

          <div style={{ marginTop: 14 }}>
            <label style={fieldLabelStyle}>VAD 프리셋</label>
            <select
              value={vadPresetKey}
              disabled={isRecording}
              onChange={(e) => setVadPresetKey(e.target.value as VadPresetKey)}
              style={{ ...lightSelectStyle, opacity: isRecording ? 0.6 : 1 }}
              title={
                isRecording
                  ? "녹음 중에는 변경할 수 없습니다 — 종료 후 적용됩니다"
                  : ""
              }
            >
              {(Object.keys(VAD_PRESETS) as VadPresetKey[]).map((k) => (
                <option key={k} value={k}>
                  {VAD_PRESETS[k].label}
                </option>
              ))}
            </select>
            <div
              style={{
                marginTop: 4,
                fontSize: 11.5,
                color: COLORS.inkMuted,
              }}
            >
              {VAD_PRESETS[vadPresetKey].description}
            </div>
            {/* 현장 소음이 큰 환경에서의 일반 안내 — 프리셋 선택과 자세 가이드.
                사용자가 언어를 직접 선택하지 않는 119 자동 처리 흐름에서는 마이크 위치/주변
                소음 통제가 자동 화자·언어 판단 정확도를 좌우하므로 강조해서 안내한다. */}
            <div
              style={{
                marginTop: 8,
                padding: "10px 12px",
                backgroundColor: "#fef9c3",
                border: "1px solid #fde68a",
                borderLeft: "5px solid #ea580c",
                borderRadius: 8,
                fontSize: 12.5,
                color: "#78350f",
                lineHeight: 1.65,
              }}
            >
              <div style={{ fontWeight: 800, marginBottom: 4 }}>
                🎙 시끄러운 현장 사용 가이드
              </div>
              <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
                <li>
                  사이렌/엔진/도로 소음이 들리면{" "}
                  <strong>“시끄러운 현장”</strong> 프리셋을 사용하세요 —
                  배경음을 발화로 오인하는 빈도가 크게 줄어듭니다.
                </li>
                <li>
                  휴대폰을 발화자 입에서 <strong>20cm 이내</strong>에 두세요.
                  마이크가 멀어지면 외국어 신호가 약해져 자동 언어 감지 정확도가
                  떨어집니다.
                </li>
                <li>
                  손바닥/옷/주머니가 마이크에 닿는 마찰음은 매우 큰 RMS 로 잡혀
                  발화로 오인됩니다 — 손에 들고 사용하는 것을 권장합니다.
                </li>
                <li>
                  언어 선택은 시스템이 자동으로 처리합니다. 사용자는{" "}
                  <strong>발화자 가까이 마이크를 두는 것에만 집중</strong>
                  하세요.
                </li>
              </ul>
            </div>
          </div>

          {/* 실시간 즉시 통역 모드 안내 — diarization off 일 때 기본 동작을 명시. */}
          <div
            style={{
              marginTop: 16,
              padding: "12px 14px",
              backgroundColor: useDiarization ? COLORS.track : "#e9f0f9",
              border: useDiarization
                ? `1px solid ${COLORS.cardBorder}`
                : `1px solid ${COLORS.operator}55`,
              borderLeft: useDiarization
                ? `4px solid ${COLORS.slate}`
                : `5px solid ${COLORS.operator}`,
              borderRadius: 10,
              opacity: useDiarization ? 0.7 : 1,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13.5,
                fontWeight: 800,
                color: useDiarization ? COLORS.inkSoft : COLORS.operator,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  backgroundColor: useDiarization
                    ? COLORS.slate
                    : COLORS.operator,
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {useDiarization ? "비활성" : "기본"}
              </span>
              ⚡ 실시간 즉시 통역 모드
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 12.5,
                color: COLORS.inkSoft,
                lineHeight: 1.6,
              }}
            >
              VAD 가 발화 종료를 감지하면 해당 chunk 를 즉시 서버
              <code style={inlineCodeStyle}>
                /api/119/realtime/process
              </code>{" "}
              로 보내고, 응답이 오는 대로 화면에 카드가 채워집니다 — 흐름은{" "}
              <strong>VAD → STT → 번역 → TTS → 재생</strong> 순서이며, 카드는{" "}
              <code style={inlineCodeStyle}>client_seq</code> 순서로 표시되어
              응답이 늦어도 순서가 꼬이지 않습니다. (현재는 chunk 단위
              request-response — 향후 translate / TTS stream 으로 전환 시에도
              동일한 카드 골격을 재사용합니다.)
            </div>
          </div>

          <div
            style={{
              marginTop: 18,
              paddingTop: 16,
              borderTop: `1px dashed ${COLORS.cardBorder}`,
            }}
          >
            <div style={fieldLabelStyle}>
              사후 분석 옵션 (선택사항 · 실시간 통역과 별개)
            </div>
            <label
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 14,
                color: COLORS.inkSoft,
                fontWeight: 600,
                cursor: isRecording ? "not-allowed" : "pointer",
                opacity: isRecording ? 0.6 : 1,
              }}
              title={
                isRecording
                  ? "녹음 중에는 변경할 수 없습니다 — 종료 후 적용됩니다"
                  : ""
              }
            >
              <input
                type="checkbox"
                checked={useDiarization}
                disabled={isRecording}
                onChange={(e) => setUseDiarization(e.target.checked)}
                style={{ width: 17, height: 17 }}
              />
              통화 종료 후 화자분리 정밀 분석
            </label>
            <div
              style={{
                marginTop: 4,
                fontSize: 11.5,
                color: COLORS.inkMuted,
                lineHeight: 1.55,
              }}
            >
              실시간 통역용이 <strong>아닙니다</strong> — 통화가 끝난 뒤 전체
              녹음을 한 번에 화자분리 엔드포인트로 보내 사후 문서화/근거 추적에
              사용합니다. 활성화 시 녹음 중에는 카드가 채워지지 않고, “통역
              종료”를 눌러야 결과가 표시됩니다.
            </div>
          </div>

          {useDiarization && (
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                backgroundColor: "#fff7ed",
                border: "1px solid #fdba74",
                borderRadius: 8,
                fontSize: 12.5,
                color: "#9a3412",
                lineHeight: 1.6,
              }}
            >
              <strong>⚠ 사후 분석 모드 — 실시간 통역 비활성</strong>
              <div style={{ marginTop: 4 }}>
                <strong>화자분리 모드는 통역 종료 시 전체 대화를 분석합니다.</strong>{" "}
                녹음 중에는 발화별로 STT/번역을 즉시 보내지 않고, “통역 종료”
                버튼을 누르면 누적된 전체 오디오를 한 번에 화자분리 엔드포인트로
                전송합니다. 일괄 분석 결과의 화자 라벨(SPK_0/SPK_1 …)은 같은
                통화 안에서 동일 인물을 가리키지만, 다른 세션 간에는 보장되지
                않습니다.
              </div>
            </div>
          )}
        </section>

        {/* 3. 대화 기록 */}
        <section style={{ ...whiteCard, marginBottom: 18, minHeight: 320 }}>
          <div style={sectionHeading}>
            실시간 대화 기록
            <span
              style={{
                marginLeft: "auto",
                fontSize: 13,
                fontWeight: 600,
                color: COLORS.inkMuted,
              }}
            >
              신고자 좌측 · 구급대원 우측
            </span>
          </div>

          {/* 화자분리 녹음 중 — 발화별 chunk 가 표시되지 않으므로 진행 상황 안내 배너. */}
          {isRecording && useDiarization && (
            <DiarizationRecordingBanner
              segments={diarizationStats.segments}
              samples={diarizationStats.samples}
              isSpeaking={isSpeaking}
            />
          )}

          {chunks.length === 0 ? (
            isRecording && useDiarization ? null : (
              <div
                style={{
                  padding: "48px 16px",
                  textAlign: "center",
                  color: COLORS.inkMuted,
                  lineHeight: 1.8,
                }}
              >
                아직 실시간 대화가 없습니다.
                <br />
                하단의 <strong style={{ color: COLORS.ink }}>통역 시작</strong>{" "}
                버튼을 눌러 녹음을 시작하세요.
              </div>
            )
          ) : (
            chunks.map((c) => <ConvBubble key={c.seqId} chunk={c} />)
          )}
        </section>

        {/* 4. 하단 액션 영역 */}
        <section style={whiteCard}>
          <div style={sectionHeading}>통역 제어</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <button
              onClick={handleStart}
              disabled={isRecording}
              style={actionButtonStyle(
                isRecording ? COLORS.slate : COLORS.navy,
                isRecording
              )}
            >
              ● 통역 시작
            </button>
            <button
              onClick={() => void handleStop()}
              disabled={!isRecording}
              style={actionButtonStyle(
                !isRecording ? COLORS.slate : COLORS.red,
                !isRecording
              )}
            >
              ■ 통역 종료
            </button>
            <button
              onClick={handleFlushAudio}
              style={actionButtonStyle(COLORS.slate, false)}
            >
              음성 큐 비우기
            </button>
            <button
              onClick={handleClearConversation}
              disabled={isRecording || chunks.length === 0}
              style={outlineButtonStyle(
                COLORS.red,
                isRecording || chunks.length === 0
              )}
            >
              대화 초기화
            </button>
            <button
              onClick={handleGoToResult}
              disabled={chunks.length === 0}
              style={{
                ...actionButtonStyle(COLORS.green, chunks.length === 0),
                marginLeft: "auto",
              }}
            >
              결과 문서로 이동 →
            </button>
          </div>
          <div
            style={{
              marginTop: 12,
              fontSize: 12.5,
              color: COLORS.inkMuted,
            }}
          >
            ‘결과 문서로 이동’을 누르면 현재까지의 실시간 대화 기록이 결과 문서
            화면에서 사건 기록 문서로 정리됩니다.
          </div>
        </section>

        {import.meta.env.DEV && (
          <DevDebugPanel
            discardedLog={discardedLog}
            sttLog={sttLog}
            roleLog={roleLog}
            apiErrorLog={apiErrorLog}
          />
        )}
      </main>
    </div>
  );
}

// ---------- 보조 컴포넌트 ----------

function PageTitle({ title, desc }: { title: string; desc: string }) {
  return (
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
        {title}
      </h1>
      <p style={{ margin: "6px 0 0", color: COLORS.onDarkMuted, fontSize: 14 }}>
        {desc}
      </p>
    </div>
  );
}

function StatTile({
  label,
  value,
  accent,
  pulse,
}: {
  label: string;
  value: string;
  accent: string;
  pulse?: boolean;
}) {
  return (
    <div
      style={{
        backgroundColor: COLORS.track,
        border: `1px solid ${COLORS.cardBorder}`,
        borderTop: `3px solid ${accent}`,
        borderRadius: 10,
        padding: "13px 14px",
      }}
    >
      <div
        style={{ fontSize: 12.5, color: COLORS.inkMuted, fontWeight: 700 }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {pulse && (
          <span
            style={{
              width: 11,
              height: 11,
              borderRadius: "50%",
              backgroundColor: accent,
              animation: "ems-pulse 1.1s infinite",
            }}
          />
        )}
        <span style={{ fontSize: 24, fontWeight: 800, color: accent }}>
          {value}
        </span>
      </div>
    </div>
  );
}

function LiveChip({
  label,
  n,
  color,
  suffix,
}: {
  label: string;
  n: number;
  color: string;
  suffix?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        backgroundColor: COLORS.track,
        border: `1px solid ${COLORS.cardBorder}`,
        fontSize: 12.5,
        color: COLORS.inkSoft,
        fontWeight: 600,
      }}
    >
      {label}
      <strong style={{ color }}>
        {n}
        {suffix ?? ""}
      </strong>
    </span>
  );
}

// 실시간 마이크 입력 게이지 + VAD 확률 표시.
// rms는 0~0.3 정도가 일반적인 발성 영역. 표시 폭은 sqrt 스케일링.
function MicMeter({
  rms,
  prob,
  threshold,
}: {
  rms: number;
  prob: number;
  threshold: number;
}) {
  const pct = Math.min(100, Math.round(Math.sqrt(rms) * 240));
  const probPct = Math.round(prob * 100);
  const voiced = prob >= threshold;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 11.5,
        color: COLORS.inkMuted,
        fontWeight: 600,
        flex: 1,
        minWidth: 240,
      }}
    >
      <span style={{ minWidth: 36 }}>마이크</span>
      <div
        style={{
          flex: 1,
          height: 8,
          backgroundColor: "#e2e8f0",
          borderRadius: 4,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            backgroundColor: voiced ? COLORS.red : COLORS.amber,
            transition: "width 80ms linear",
          }}
        />
      </div>
      <span
        style={{
          minWidth: 70,
          textAlign: "right",
          color: voiced ? COLORS.red : COLORS.inkMuted,
        }}
      >
        VAD {probPct}%
      </span>
      <span style={{ minWidth: 64, color: COLORS.inkMuted }}>
        RMS {rms.toFixed(3)}
      </span>
    </div>
  );
}

// 개발 빌드에서만 표시되는 접이식 디버그 패널. 운영 빌드(import.meta.env.DEV=false)에서는
// 호출처에서 아예 렌더되지 않는다. 4개 카테고리의 최근 5개 로그를 보여준다.
function DevDebugPanel({
  discardedLog,
  sttLog,
  roleLog,
  apiErrorLog,
}: {
  discardedLog: Array<{ id: number; at: number; reason: string }>;
  sttLog: Array<{ id: number; at: number; text: string; seqId: number }>;
  roleLog: Array<{
    id: number;
    at: number;
    seqId: number;
    speaker: Speaker;
    confidence: number;
    reason: string;
  }>;
  apiErrorLog: Array<{
    id: number;
    at: number;
    stage: string;
    message: string;
    seqId?: number;
  }>;
}) {
  const colStyle: React.CSSProperties = {
    backgroundColor: COLORS.track,
    border: `1px solid ${COLORS.cardBorder}`,
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 12,
    color: COLORS.inkSoft,
    minHeight: 60,
  };
  const headerStyle: React.CSSProperties = {
    fontWeight: 700,
    color: COLORS.inkMuted,
    marginBottom: 6,
    fontSize: 11.5,
  };
  const lineStyle: React.CSSProperties = {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 11.5,
    color: COLORS.ink,
    paddingBottom: 2,
  };
  return (
    <section style={{ ...whiteCard, marginTop: 18 }}>
      <details>
        <summary
          style={{
            cursor: "pointer",
            fontWeight: 700,
            color: COLORS.inkSoft,
            fontSize: 13,
            padding: "4px 0",
          }}
        >
          🔧 개발 디버그 패널 (DEV 빌드 전용) · 최근 5개 로그 ·{" "}
          <span style={{ color: COLORS.inkMuted, fontWeight: 600 }}>
            펼치기/접기
          </span>
        </summary>
        <div
          style={{
            marginTop: 10,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <div style={colStyle}>
            <div style={headerStyle}>최근 폐기 로그</div>
            {discardedLog.length === 0 ? (
              <div style={{ color: COLORS.inkMuted }}>(없음)</div>
            ) : (
              discardedLog.map((d) => (
                <div key={d.id} style={lineStyle}>
                  <span style={{ color: COLORS.inkMuted }}>
                    {formatClock(d.at)}
                  </span>{" "}
                  · {d.reason}
                </div>
              ))
            )}
          </div>
          <div style={colStyle}>
            <div style={headerStyle}>최근 STT 원문</div>
            {sttLog.length === 0 ? (
              <div style={{ color: COLORS.inkMuted }}>(없음)</div>
            ) : (
              sttLog.map((s) => (
                <div key={s.id} style={lineStyle}>
                  <span style={{ color: COLORS.inkMuted }}>
                    {formatClock(s.at)} #{s.seqId}
                  </span>{" "}
                  · {s.text}
                </div>
              ))
            )}
          </div>
          <div style={colStyle}>
            <div style={headerStyle}>최근 역할 판단</div>
            {roleLog.length === 0 ? (
              <div style={{ color: COLORS.inkMuted }}>(없음)</div>
            ) : (
              roleLog.map((r) => (
                <div key={r.id} style={lineStyle}>
                  <span style={{ color: COLORS.inkMuted }}>
                    {formatClock(r.at)} #{r.seqId}
                  </span>{" "}
                  ·{" "}
                  <strong>
                    {SPEAKER_LABEL[r.speaker]} (
                    {Math.round(r.confidence * 100)}%)
                  </strong>{" "}
                  · {r.reason}
                </div>
              ))
            )}
          </div>
          <div style={colStyle}>
            <div style={headerStyle}>최근 API 에러</div>
            {apiErrorLog.length === 0 ? (
              <div style={{ color: COLORS.inkMuted }}>(없음)</div>
            ) : (
              apiErrorLog.map((e) => (
                <div key={e.id} style={lineStyle}>
                  <span style={{ color: COLORS.inkMuted }}>
                    {formatClock(e.at)}
                    {e.seqId !== undefined ? ` #${e.seqId}` : ""}
                  </span>{" "}
                  · <strong style={{ color: COLORS.red }}>{e.stage}</strong> ·{" "}
                  {e.message}
                </div>
              ))
            )}
          </div>
        </div>
      </details>
    </section>
  );
}

// 자동 감지된 언어를 표시하는 타일. 신고자 타일은 primary + 최근 + 추가 감지 외국어를 함께 보여준다.
function DetectedLangTile({
  title,
  code,
  autoDetect,
  latestCode,
  secondary,
}: {
  title: string;
  code: string | null;
  autoDetect: boolean;
  latestCode?: string | null;
  secondary?: string[];
}) {
  const pending = autoDetect && (code === null || code === "unknown");
  const label = pending
    ? "자동 감지 중..."
    : code
    ? langLabel(code)
    : "감지 필요";
  const accent = pending ? COLORS.amber : COLORS.navy;
  const showLatest =
    autoDetect &&
    latestCode &&
    latestCode !== "unknown" &&
    latestCode !== code;
  const filteredSecondary = (secondary ?? []).filter(
    (l) => l && l !== "unknown" && l !== code
  );
  return (
    <div
      style={{
        backgroundColor: COLORS.track,
        border: `1px solid ${COLORS.cardBorder}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 9,
        padding: "11px 12px",
        marginTop: 7,
      }}
    >
      <div style={{ fontSize: 12.5, color: COLORS.inkMuted, fontWeight: 700 }}>
        {title}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 17,
          fontWeight: 700,
          color: pending ? COLORS.amber : COLORS.ink,
        }}
      >
        {label}
      </div>
      {showLatest && (
        <div style={{ marginTop: 4, fontSize: 11.5, color: COLORS.inkSoft }}>
          최근 신고자 발화: <strong>{langLabel(latestCode!)}</strong>
        </div>
      )}
      {filteredSecondary.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11.5, color: COLORS.inkSoft }}>
          추가 감지 언어:{" "}
          <strong>
            {filteredSecondary.map((l) => langLabel(l)).join(", ")}
          </strong>
        </div>
      )}
      <div style={{ marginTop: 4, fontSize: 11.5, color: COLORS.inkMuted }}>
        {autoDetect
          ? pending
            ? "신고자 발화가 한 번 인식되면 감지됩니다."
            : "신고자 발화에서 자동 감지된 언어입니다."
          : "구급대원 발화는 항상 한국어로 처리됩니다."}
      </div>
    </div>
  );
}

// 실시간 파이프라인 상태 패널 — Pipecat 스타일의 단계별 진단판.
// chunk 수/성공/오류/폐기/판단 불가/큐 backlog + 평균 latency + 현재 프리셋/언어를 한 눈에.
function PipelineStatusPanel({
  totalChunks,
  successChunks,
  errorChunks,
  discardedCount,
  duplicateCount,
  unknownChunks,
  backlog,
  sttAvg,
  trAvg,
  ttsAvg,
  ttfaAvg,
  presetLabel,
  detectedCallerLanguage,
  secondaryCallerLanguages,
  diarizationEnabled,
}: {
  totalChunks: number;
  successChunks: number;
  errorChunks: number;
  discardedCount: number;
  duplicateCount: number;
  unknownChunks: number;
  backlog: number;
  sttAvg: number;
  trAvg: number;
  ttsAvg: number;
  ttfaAvg: number;
  presetLabel: string;
  detectedCallerLanguage: string | null;
  secondaryCallerLanguages: string[];
  diarizationEnabled: boolean;
}) {
  const cell: React.CSSProperties = {
    backgroundColor: COLORS.track,
    border: `1px solid ${COLORS.cardBorder}`,
    borderRadius: 8,
    padding: "8px 10px",
  };
  const k: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    color: COLORS.inkMuted,
  };
  const v: React.CSSProperties = {
    marginTop: 3,
    fontSize: 16,
    fontWeight: 800,
    color: COLORS.ink,
  };
  return (
    <section style={{ ...whiteCard, marginBottom: 18 }}>
      <div style={sectionHeading}>
        실시간 파이프라인 상태
        <span
          style={{
            marginLeft: "auto",
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.inkMuted,
          }}
        >
          chunk 처리 흐름 진단 (VAD → STT → 번역 → TTS → 재생)
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, 1fr)",
          gap: 8,
        }}
      >
        <div style={cell}>
          <div style={k}>총 chunk</div>
          <div style={v}>{totalChunks}</div>
        </div>
        <div style={cell}>
          <div style={k}>성공</div>
          <div style={{ ...v, color: COLORS.green }}>{successChunks}</div>
        </div>
        <div style={cell}>
          <div style={k}>오류</div>
          <div style={{ ...v, color: COLORS.red }}>{errorChunks}</div>
        </div>
        <div style={cell}>
          <div style={k}>폐기</div>
          <div style={{ ...v, color: COLORS.amber }}>{discardedCount}</div>
        </div>
        <div style={cell}>
          <div style={k}>중복 제거</div>
          <div style={{ ...v, color: COLORS.amber }}>{duplicateCount}</div>
        </div>
        <div style={cell}>
          <div style={k}>판단 불가</div>
          <div style={{ ...v, color: COLORS.slate }}>{unknownChunks}</div>
        </div>
        <div style={cell}>
          <div style={k}>평균 STT</div>
          <div style={v}>{sttAvg ? formatMs(sttAvg) : "—"}</div>
        </div>
        <div style={cell}>
          <div style={k}>평균 번역</div>
          <div style={v}>{trAvg ? formatMs(trAvg) : "—"}</div>
        </div>
        <div style={cell}>
          <div style={k}>평균 TTS</div>
          <div style={v}>{ttsAvg ? formatMs(ttsAvg) : "—"}</div>
        </div>
        <div style={cell}>
          <div style={k}>평균 E2E/TTFA</div>
          <div style={v}>{ttfaAvg ? formatMs(ttfaAvg) : "—"}</div>
        </div>
        <div style={cell}>
          <div style={k}>큐 backlog</div>
          <div
            style={{
              ...v,
              color: backlog > 3 ? COLORS.red : COLORS.ink,
            }}
          >
            {backlog}
          </div>
        </div>
        <div style={cell}>
          <div style={k}>VAD 프리셋</div>
          <div style={{ ...v, fontSize: 13 }}>{presetLabel}</div>
        </div>
      </div>
      <div
        style={{
          marginTop: 10,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          fontSize: 12,
          color: COLORS.inkSoft,
        }}
      >
        <span>
          신고자 언어:{" "}
          <strong style={{ color: COLORS.ink }}>
            {detectedCallerLanguage
              ? langLabel(detectedCallerLanguage)
              : "자동 감지 중"}
          </strong>
        </span>
        {secondaryCallerLanguages.length > 0 && (
          <span>
            추가 감지:{" "}
            <strong style={{ color: COLORS.ink }}>
              {secondaryCallerLanguages.map((l) => langLabel(l)).join(", ")}
            </strong>
          </span>
        )}
        {diarizationEnabled && (
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              backgroundColor: "#fff7ed",
              border: "1px solid #fdba74",
              color: "#9a3412",
              fontWeight: 700,
            }}
          >
            🧪 서버 화자분리 실험 활성
          </span>
        )}
      </div>
    </section>
  );
}

function DiscardedLogPanel({
  log,
  debugMode,
}: {
  log: Array<{ id: number; at: number; reason: string }>;
  debugMode: boolean;
}) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        backgroundColor: debugMode ? "#fff7ed" : COLORS.track,
        border: `1px solid ${debugMode ? "#fdba74" : COLORS.cardBorder}`,
        borderRadius: 8,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
          color: COLORS.inkSoft,
          fontWeight: 700,
        }}
      >
        최근 폐기 사유 (최근 {MAX_DISCARDED_LOG}개)
        {debugMode && (
          <span
            style={{
              fontSize: 11,
              padding: "1px 7px",
              borderRadius: 999,
              backgroundColor: "#ea580c",
              color: "#fff",
              fontWeight: 700,
            }}
          >
            디버그 모드
          </span>
        )}
        <span style={{ marginLeft: "auto", color: COLORS.inkMuted, fontWeight: 500 }}>
          {log.length === 0
            ? "아직 폐기된 발화가 없습니다"
            : `${log.length}건`}
        </span>
      </div>
      {log.length > 0 && (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {log.map((d) => (
            <li
              key={d.id}
              style={{
                color: COLORS.inkSoft,
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 12,
              }}
            >
              <span style={{ color: COLORS.inkMuted }}>
                {formatClock(d.at)}
              </span>{" "}
              · {d.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// 화자분리 모드 녹음 진행 안내 — 발화별 chunk 가 화면에 표시되지 않는 동안
// 사용자에게 "통역 종료 시 일괄 분석"이라는 흐름과 누적 진행 상황을 보여준다.
function DiarizationRecordingBanner({
  segments,
  samples,
  isSpeaking,
}: {
  segments: number;
  samples: number;
  isSpeaking: boolean;
}) {
  const durationSec = samples / VAD_SAMPLE_RATE;
  return (
    <div
      style={{
        margin: "0 0 14px",
        padding: "12px 14px",
        backgroundColor: "#fff7ed",
        border: "1px solid #fdba74",
        borderLeft: "5px solid #ea580c",
        borderRadius: 10,
        color: "#9a3412",
        lineHeight: 1.6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 14,
          fontWeight: 700,
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            backgroundColor: isSpeaking ? "#dc2626" : "#fdba74",
            animation: isSpeaking ? "ems-pulse 1.1s infinite" : undefined,
          }}
        />
        🧪 화자분리 녹음 중 — 통역 종료 시 전체 대화를 한 번에 분석합니다
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 12.5,
          color: "#9a3412",
        }}
      >
        누적 발화 {segments}개 · 약 {durationSec.toFixed(1)}초
        {segments === 0 && (
          <span style={{ marginLeft: 8, color: COLORS.inkMuted }}>
            (아직 발화가 인식되지 않았습니다 — 마이크 입력을 확인하세요)
          </span>
        )}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 11.5,
          color: "#9a3412",
          fontStyle: "italic",
        }}
      >
        “통역 종료” 버튼을 누르면 누적된 오디오가 화자분리 엔드포인트로 한 번에
        전송되고, 응답이 도착하면 화자별 segment 와 번역이 아래에 표시됩니다.
      </div>
    </div>
  );
}

// 서버 화자분리 segments와 프론트 자동 역할 판단 결과를 한 줄에 나란히 비교.
// chunk 라벨 동일성이 보장되지 않아도 chunk 내부 화자 분포가 자동 판단과 어긋나는지
// 빠르게 확인할 수 있다.
function DiarizationVsAutoBlock({
  diarizationSegments,
  autoSpeakerLabel,
  autoSpeakerReason,
}: {
  diarizationSegments: DiarizationSegment[];
  autoSpeakerLabel: string;
  autoSpeakerReason?: string;
}) {
  // chunk 내부에서 가장 길게 말한 화자(누적 duration 기준)를 대표 화자로 표시.
  const totals = new Map<string, number>();
  for (const s of diarizationSegments) {
    const dur = Math.max(0, s.end - s.start);
    totals.set(s.speaker, (totals.get(s.speaker) ?? 0) + dur);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const primary = ranked[0]?.[0] ?? "SPK_?";
  const otherCount = ranked.length - 1;
  return (
    <div
      style={{
        marginTop: 10,
        padding: "6px 10px",
        backgroundColor: "#fef3c7",
        border: "1px solid #fde68a",
        borderRadius: 8,
        fontSize: 12,
        color: "#78350f",
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
      }}
    >
      <span>
        서버 화자:{" "}
        <strong>
          {primary}
          {otherCount > 0 ? ` (+${otherCount}명)` : ""}
        </strong>
      </span>
      <span>
        자동 역할: <strong>{autoSpeakerLabel}</strong>
      </span>
      {autoSpeakerReason && (
        <span style={{ flex: 1, minWidth: 0 }}>판단 근거: {autoSpeakerReason}</span>
      )}
    </div>
  );
}

// 서버 화자분리 STT(실험)가 반환한 segment들을 표시.
// 헤더에 "chunk #N · 서버 화자 SPK_0, SPK_1, ..." 으로 chunk 번호와 segment 라벨을 함께 보여
// 라벨 동일성/지속성을 검증할 수 있게 한다.
//
// diarization mode 서버 응답은 segment 별로 role / source_language / target_language /
// translated 등이 채워져 들어온다. 이 enriched 정보가 하나라도 있으면 segment 들을
// caller=좌측 / operator=우측 으로 정렬된 미니 버블로 렌더해 화자 흐름을 그대로 보여준다.
// (구버전 응답·normal mode segment 처럼 enrichment 가 전혀 없으면 기존 모노스페이스
// 리스트로 폴백해 normal mode UI 를 깨지 않는다.)
function DiarizationSegmentsBlock({
  seqId,
  segments,
}: {
  seqId: number;
  segments: DiarizationSegment[];
}) {
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const hasEnrichment = segments.some(
    (s) =>
      s.role !== undefined ||
      s.translated !== undefined ||
      s.source_language !== undefined ||
      s.target_language !== undefined ||
      s.error !== undefined ||
      s.reason !== undefined
  );
  const translatedCount = segments.filter(
    (s) => s.translated && s.translated.length > 0
  ).length;
  const errorCount = segments.filter((s) => s.error).length;

  return (
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px",
        backgroundColor: "#fff7ed",
        border: "1px solid #fdba74",
        borderRadius: 8,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          color: "#9a3412",
          fontWeight: 700,
          flexWrap: "wrap",
        }}
      >
        🧪 서버 화자분리 segments
        <span style={{ fontWeight: 600, color: COLORS.inkMuted }}>
          chunk #{seqId} · {segments.length}개 segment · 서버 화자:{" "}
          {speakers.join(", ")}
          {translatedCount > 0 && ` · 번역 완료 ${translatedCount}건`}
          {errorCount > 0 && (
            <span style={{ color: COLORS.red, fontWeight: 700 }}>
              {" "}
              · 실패 {errorCount}건
            </span>
          )}
        </span>
      </div>

      {hasEnrichment ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {segments.map((s, i) => (
            <DiarizationSegmentRow key={i} seg={s} />
          ))}
        </div>
      ) : (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {segments.map((s, i) => (
            <li
              key={i}
              style={{
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 12,
                color: COLORS.inkSoft,
                display: "flex",
                gap: 8,
                alignItems: "baseline",
              }}
            >
              <span
                style={{
                  minWidth: 64,
                  color: COLORS.inkMuted,
                }}
              >
                {s.start.toFixed(2)}–{s.end.toFixed(2)}s
              </span>
              <span
                style={{
                  padding: "1px 7px",
                  borderRadius: 999,
                  backgroundColor: "#ea580c",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 11,
                }}
              >
                {s.speaker || "SPK_?"}
              </span>
              <span style={{ flex: 1, color: COLORS.ink }}>{s.text}</span>
            </li>
          ))}
        </ul>
      )}

      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: "#9a3412",
          fontStyle: "italic",
        }}
      >
        chunk 단위 STT라 SPK_x 라벨이 다음 chunk에서도 같은 인물을 가리킨다는
        보장은 없습니다. 자동 역할 판단은 segment 별 role 배지를 우선 따릅니다.
      </div>
    </div>
  );
}

// diarization segment 하나를 caller(좌측) / operator(우측) 로 정렬해 작은 버블로 렌더한다.
// 헤더에 시각 / 서버 화자 라벨 / role / 신뢰도 / source→target 언어가 칩으로 들어가고
// 본문은 원문 + (있으면) 강조된 통역 + (있으면) 빨간 오류 안내로 구성된다.
function DiarizationSegmentRow({ seg }: { seg: DiarizationSegment }) {
  const role = normalizeRole(seg.role);
  const isCaller = role === "caller";
  const isOperator = role === "operator";
  const isInterpreter = role === "interpreter";
  const sideColor = isCaller
    ? COLORS.caller
    : isOperator
    ? COLORS.operator
    : isInterpreter
    ? COLORS.violet
    : COLORS.slate;
  const softBg = isCaller
    ? COLORS.callerSoft
    : isOperator
    ? COLORS.operatorSoft
    : isInterpreter
    ? "#f5f0ff"
    : "#f1f5f9";
  const justify = isCaller
    ? "flex-start"
    : isOperator
    ? "flex-end"
    : "center";
  const roleIcon = isCaller
    ? "🆘"
    : isOperator
    ? "🚑"
    : isInterpreter
    ? "🗣️"
    : "❓";
  const roleLabel = SPEAKER_LABEL[role];

  const src = seg.source_language;
  const tgt = seg.target_language;
  const showLangPair =
    (src && src !== "unknown") || (tgt && tgt !== "unknown");

  return (
    <div
      style={{
        display: "flex",
        justifyContent: justify,
      }}
    >
      <div
        style={{
          maxWidth: "92%",
          minWidth: 240,
          backgroundColor: softBg,
          border: `1px solid ${COLORS.cardBorder}`,
          borderLeft: isCaller
            ? `4px solid ${sideColor}`
            : `1px solid ${COLORS.cardBorder}`,
          borderRight: isOperator
            ? `4px solid ${sideColor}`
            : `1px solid ${COLORS.cardBorder}`,
          borderTop:
            !isCaller && !isOperator
              ? `3px solid ${sideColor}`
              : undefined,
          borderRadius: 10,
          padding: "8px 10px",
          fontSize: 12,
        }}
      >
        {/* 헤더: 시각 + 서버 화자 라벨 + role + 신뢰도 + src→tgt 칩 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              color: COLORS.inkMuted,
              fontSize: 11,
            }}
          >
            {seg.start.toFixed(2)}–{seg.end.toFixed(2)}s
          </span>
          <span
            style={{
              padding: "1px 7px",
              borderRadius: 999,
              backgroundColor: "#ea580c",
              color: "#fff",
              fontWeight: 700,
              fontSize: 10.5,
            }}
            title="서버 STT 가 부여한 화자 라벨 (chunk 간 동일성 보장 없음)"
          >
            {seg.speaker || "SPK_?"}
          </span>
          <span
            style={{
              padding: "1px 7px",
              borderRadius: 999,
              backgroundColor: sideColor,
              color: "#fff",
              fontWeight: 700,
              fontSize: 10.5,
            }}
          >
            {roleIcon} {roleLabel}
          </span>
          {seg.role_confidence !== undefined && (
            <span
              style={{
                padding: "1px 7px",
                borderRadius: 999,
                backgroundColor: confidenceColor(seg.role_confidence),
                color: "#fff",
                fontWeight: 700,
                fontSize: 10.5,
              }}
              title={
                seg.role_reason
                  ? `근거: ${seg.role_reason}`
                  : "역할 판단 신뢰도"
              }
            >
              신뢰도 {confidenceLabel(seg.role_confidence)} (
              {Math.round(seg.role_confidence * 100)}%)
            </span>
          )}
          {showLangPair && (
            <span
              style={{
                padding: "1px 7px",
                borderRadius: 999,
                backgroundColor: "#ffffff",
                border: `1px solid ${COLORS.cardBorder}`,
                color: COLORS.inkSoft,
                fontSize: 10.5,
                fontWeight: 600,
              }}
            >
              {langLabel(src || "unknown")} →{" "}
              {langLabel(tgt || "unknown")}
            </span>
          )}
        </div>

        {/* 원문 */}
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "baseline",
            color: COLORS.ink,
            lineHeight: 1.55,
            fontSize: 13,
          }}
        >
          <span
            style={{
              ...bubbleTagStyle,
              backgroundColor: COLORS.slate,
              fontSize: 10,
            }}
          >
            원문
          </span>
          <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>
            {seg.text}
          </span>
        </div>

        {/* 통역 — 있을 때만 강조 박스로 */}
        {seg.translated && (
          <div
            style={{
              marginTop: 6,
              padding: "6px 8px",
              backgroundColor: "#ffffff",
              borderLeft: `3px solid ${sideColor}`,
              borderRadius: 6,
              display: "flex",
              gap: 6,
              alignItems: "baseline",
              fontSize: 13,
              lineHeight: 1.55,
              fontWeight: 600,
              color: COLORS.ink,
            }}
          >
            <span
              style={{
                ...bubbleTagStyle,
                backgroundColor: sideColor,
                fontSize: 10,
              }}
            >
              통역
            </span>
            <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>
              {seg.translated}
            </span>
          </div>
        )}

        {/* 역할 판단 근거 — 신뢰도 칩 title 외에도 한 줄로 노출 (verbosity 옵션) */}
        {seg.role_reason && !seg.error && (
          <div
            style={{
              marginTop: 5,
              fontSize: 11,
              color: COLORS.inkMuted,
              fontStyle: "italic",
            }}
          >
            근거: {seg.role_reason}
          </div>
        )}

        {/* segment 단위 오류 — 빨간 경고 박스 */}
        {seg.error && (
          <div
            style={{
              marginTop: 6,
              fontSize: 11.5,
              color: COLORS.redDark,
              backgroundColor: COLORS.redSoft,
              border: `1px solid ${COLORS.red}55`,
              padding: "5px 8px",
              borderRadius: 6,
              wordBreak: "break-word",
            }}
          >
            ⚠ 오류: {seg.error}
            {seg.reason && (
              <span style={{ marginLeft: 6, color: COLORS.inkMuted }}>
                ({seg.reason})
              </span>
            )}
          </div>
        )}
        {/* 오류는 아니지만 reason 만 있는 경우 (no-translation-target 등) */}
        {!seg.error && seg.reason && (
          <div
            style={{
              marginTop: 5,
              fontSize: 11,
              color: COLORS.inkMuted,
              fontStyle: "italic",
            }}
          >
            사유: {seg.reason}
          </div>
        )}
      </div>
    </div>
  );
}

function ConvBubble({ chunk }: { chunk: ChunkRecord }) {
  const isCaller = chunk.speaker === "caller";
  const isOperator = chunk.speaker === "operator";
  const isInterpreter = chunk.speaker === "interpreter";
  // 화자 판단 전(녹음 중)/판단 불가/통역사 — 중앙 정렬 + 중립/보조 색.
  const sideColor = isCaller
    ? COLORS.caller
    : isOperator
    ? COLORS.operator
    : isInterpreter
    ? COLORS.violet
    : COLORS.slate;
  const soft = isCaller
    ? COLORS.callerSoft
    : isOperator
    ? COLORS.operatorSoft
    : isInterpreter
    ? "#f5f0ff"
    : "#f1f5f9";
  const justify = isCaller
    ? "flex-start"
    : isOperator
    ? "flex-end"
    : "center";
  const speakerIcon =
    chunk.speaker === "caller"
      ? "🆘"
      : chunk.speaker === "operator"
      ? "🚑"
      : chunk.speaker === "interpreter"
      ? "🗣️"
      : "❓";
  const autoLabel = SPEAKER_AUTO_LABEL[chunk.speaker];
  const isLive = !TERMINAL_STATUSES.has(chunk.status);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: justify,
        marginBottom: 14,
      }}
    >
      <div
        style={{
          maxWidth: "82%",
          minWidth: 340,
          backgroundColor: soft,
          border: `1px solid ${COLORS.cardBorder}`,
          borderLeft: isCaller
            ? `6px solid ${sideColor}`
            : `1px solid ${COLORS.cardBorder}`,
          borderRight: isOperator
            ? `6px solid ${sideColor}`
            : `1px solid ${COLORS.cardBorder}`,
          borderTop: !isCaller && !isOperator
            ? `3px solid ${sideColor}`
            : undefined,
          borderRadius: 12,
          padding: 16,
          boxShadow: isLive
            ? `0 0 0 2px ${STATUS_COLOR[chunk.status]}44`
            : "0 2px 8px rgba(15, 31, 58, 0.1)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          <strong style={{ color: sideColor, fontSize: 16 }}>
            {speakerIcon} {SPEAKER_LABEL[chunk.speaker]}
            <span
              style={{
                marginLeft: 8,
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
                backgroundColor: sideColor,
                verticalAlign: "middle",
              }}
            >
              {autoLabel}
            </span>
            <span
              style={{
                color: COLORS.inkMuted,
                fontWeight: 600,
                fontSize: 12.5,
                marginLeft: 8,
              }}
            >
              #{chunk.seqId} · {formatClock(chunk.startedAt)}
            </span>
            {chunk.diarizationMode && (
              <span
                style={{
                  marginLeft: 8,
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#9a3412",
                  backgroundColor: "#fff7ed",
                  border: "1px solid #fdba74",
                  verticalAlign: "middle",
                }}
                title="서버 화자분리 STT(실험) — chunk 간 화자 라벨 동일성은 보장되지 않습니다."
              >
                🧪 화자분리 실험
              </span>
            )}
          </strong>
          <span
            style={{
              fontSize: 11.5,
              padding: "3px 9px",
              borderRadius: 999,
              backgroundColor: STATUS_COLOR[chunk.status],
              color: "#fff",
              fontWeight: 700,
            }}
          >
            {STATUS_LABEL[chunk.status]}
            {chunk.piecesTotal !== undefined &&
              chunk.piecesTotal > 0 &&
              ` · ${chunk.piecesPlayed ?? 0}/${chunk.piecesTotal}`}
          </span>
        </div>

        <div
          style={{ fontSize: 12, color: COLORS.inkMuted, marginBottom: 8 }}
        >
          {langLabel(chunk.inputLang)} → {langLabel(chunk.targetLang)}
        </div>

        {chunk.speakerConfidence !== undefined && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              fontSize: 11.5,
              color: COLORS.inkSoft,
            }}
          >
            <span
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
                backgroundColor: confidenceColor(chunk.speakerConfidence),
              }}
            >
              신뢰도 {confidenceLabel(chunk.speakerConfidence)} (
              {Math.round(chunk.speakerConfidence * 100)}%)
            </span>
            {chunk.speakerReason && (
              <span style={{ flex: 1, minWidth: 0 }}>
                근거: {chunk.speakerReason}
              </span>
            )}
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 4,
            flexWrap: "wrap",
          }}
        >
          <span style={bubbleTagStyle}>원문</span>
          {chunk.transcriptConfirmed === true && (
            <span
              style={{
                ...bubbleTagStyle,
                backgroundColor: "#0f7b54",
                fontSize: 10.5,
              }}
            >
              확정
            </span>
          )}
          {chunk.transcriptConfirmed === false && (
            <span
              style={{
                ...bubbleTagStyle,
                backgroundColor: "#d97706",
                fontSize: 10.5,
              }}
              title={
                chunk.duplicateOfSeqId
                  ? `chunk #${chunk.duplicateOfSeqId} 와 중복 — 문서 제외`
                  : "임시 (문서 미포함)"
              }
            >
              {chunk.duplicateOfSeqId ? "중복 (문서 제외)" : "임시"}
            </span>
          )}
          {chunk.transcriptConfirmed === undefined &&
            !TERMINAL_STATUSES.has(chunk.status) && (
              <span
                style={{
                  ...bubbleTagStyle,
                  backgroundColor: COLORS.slate,
                  fontSize: 10.5,
                }}
              >
                임시
              </span>
            )}
          {chunk.overlapRemoved && (
            <span
              style={{
                fontSize: 10.5,
                color: COLORS.inkMuted,
                fontStyle: "italic",
              }}
              title={`이전 chunk 끝부분과 겹치는 "${chunk.overlapRemoved}" 자동 제거`}
            >
              · overlap 자동 제거
            </span>
          )}
        </div>
        {/* 원문 — 통역 결과를 강조하기 위해 보조 텍스트로 약간 작게/연하게 표시. */}
        <div
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: COLORS.inkSoft,
            minHeight: 22,
            fontStyle:
              chunk.transcriptConfirmed === false ? "italic" : "normal",
            opacity: chunk.transcriptConfirmed === false ? 0.75 : 1,
          }}
        >
          {chunk.original ||
            (chunk.status === "recording"
              ? "🎤 녹음 중... (자동 화자 판단 중)"
              : chunk.status === "stt_verifying"
              ? "🔎 VAD 불확실 — STT 결과로 발화 여부 검증 중..."
              : chunk.status === "stt"
              ? "음성 인식 + 화자 자동 판단 중..."
              : chunk.status === "empty"
              ? "(무음 — 인식된 음성 없음)"
              : "")}
        </div>

        {(() => {
          const segs = chunk.diarizationSegments;
          // diarization mode 에서 segment 별 번역이 하나라도 존재하면 chunk.translated
          // 는 "segment translated 줄단위 join" 한 요약이다. 사용자가 권위 있는 번역을
          // 어디서 봐야 하는지 헷갈리지 않도록 명시적 "전체 요약" 배지를 단다.
          const segmentTranslatedCount =
            segs?.filter((s) => s.translated && s.translated.length > 0)
              .length ?? 0;
          const isMixedSummary =
            (chunk.diarizationMode ?? false) && segmentTranslatedCount > 0;
          // 청자 관점 — caller 의 발화는 구급대원에게 한국어로,
          // operator 의 발화는 신고자에게 자동 감지된 외국어로 전달된다.
          const listenerHint = isCaller
            ? "→ 구급대원에게 표시되는 한국어 번역"
            : isOperator
            ? "→ 신고자에게 전달되는 외국어 번역"
            : null;
          // 번역 본문이 비어 있는 동안 어떤 안내가 보일지 결정.
          const translationPlaceholder =
            chunk.status === "translating"
              ? "번역 생성 중..."
              : chunk.status === "tts" || chunk.status === "playing"
              ? "음성 합성 중..."
              : chunk.status === "done" || chunk.status === "error"
              ? "(통역 결과 없음 — 원문만 표시)"
              : "";
          const hasTranslation = !!chunk.translated;
          return (
            <div
              style={{
                marginTop: 12,
                padding: hasTranslation ? "12px 14px" : "10px 0 0",
                borderTop: `1px dashed ${sideColor}66`,
                // 번역 결과가 있을 때만 강조 박스로. 비었을 때는 카드 배경 그대로 두어
                // 빈 placeholder 가 도드라지지 않게 한다.
                backgroundColor: hasTranslation
                  ? "rgba(255,255,255,0.85)"
                  : "transparent",
                borderRadius: hasTranslation ? 10 : 0,
                boxShadow: hasTranslation
                  ? `inset 0 0 0 1px ${sideColor}33`
                  : undefined,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    ...bubbleTagStyle,
                    backgroundColor: sideColor,
                    fontSize: 11.5,
                    padding: "3px 10px",
                  }}
                >
                  📢 통역
                </span>
                {listenerHint && (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: sideColor,
                    }}
                  >
                    {listenerHint}
                  </span>
                )}
                {isMixedSummary && (
                  <span
                    style={{
                      ...bubbleTagStyle,
                      backgroundColor: "#fff7ed",
                      color: "#9a3412",
                      border: "1px solid #fdba74",
                      fontSize: 10.5,
                    }}
                    title="diarization mode — 아래 segment 별 번역의 줄단위 요약입니다. segment 별 번역이 권위 있는 결과."
                  >
                    전체 요약 (segment별 번역 우선)
                  </span>
                )}
              </div>
              <div
                style={{
                  // 통역 결과는 원문(15px) 보다 훨씬 크고 진하게 — 실시간 통역 카드의
                  // 핵심 정보이므로 시선이 가장 먼저 닿도록 한다.
                  fontSize: hasTranslation ? 22 : 15,
                  lineHeight: 1.55,
                  color: hasTranslation ? COLORS.ink : COLORS.inkMuted,
                  fontWeight: hasTranslation ? 700 : 500,
                  minHeight: 28,
                  fontStyle: hasTranslation ? "normal" : "italic",
                  // 백엔드가 줄단위로 join 한 mixed translated 가 그대로 보이도록 줄바꿈 보존.
                  whiteSpace: "pre-wrap",
                }}
              >
                {chunk.translated || translationPlaceholder}
              </div>
            </div>
          );
        })()}

        {chunk.diarizationSegments && chunk.diarizationSegments.length > 0 && (
          <>
            <DiarizationVsAutoBlock
              diarizationSegments={chunk.diarizationSegments}
              autoSpeakerLabel={SPEAKER_LABEL[chunk.speaker]}
              autoSpeakerReason={chunk.speakerReason}
            />
            <DiarizationSegmentsBlock
              seqId={chunk.seqId}
              segments={chunk.diarizationSegments}
            />
          </>
        )}

        {chunk.error && (
          <div
            style={{
              marginTop: 8,
              fontSize: 12.5,
              color: COLORS.redDark,
              backgroundColor: COLORS.redSoft,
              border: `1px solid ${COLORS.red}55`,
              padding: "6px 9px",
              borderRadius: 8,
              wordBreak: "break-word",
            }}
          >
            오류: {chunk.error}
          </div>
        )}

        <div
          style={{
            marginTop: 9,
            fontSize: 11.5,
            color: COLORS.inkMuted,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span>STT {formatMs(chunk.sttMs)}</span>
          <span>번역 {formatMs(chunk.translateMs)}</span>
          <span>TTS {formatMs(chunk.ttsMs)}</span>
          <span>E2E {formatMs(chunk.ttfaMs)}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- 스타일 ----------

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 700,
  color: COLORS.inkSoft,
  marginBottom: 2,
};

const lightSelectStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  marginTop: 7,
  borderRadius: 9,
  border: `1px solid ${COLORS.cardBorder}`,
  backgroundColor: "#ffffff",
  color: COLORS.ink,
  fontSize: 15,
  fontWeight: 600,
};

const bubbleTagStyle: React.CSSProperties = {
  display: "inline-block",
  fontSize: 11,
  fontWeight: 700,
  color: "#fff",
  backgroundColor: COLORS.slate,
  padding: "2px 8px",
  borderRadius: 5,
};

const inlineCodeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  padding: "1px 6px",
  borderRadius: 4,
  backgroundColor: "#e2e8f0",
  color: COLORS.ink,
  fontWeight: 600,
};

function actionButtonStyle(
  color: string,
  disabled: boolean
): React.CSSProperties {
  return {
    padding: "14px 22px",
    borderRadius: 10,
    border: "none",
    backgroundColor: color,
    color: "#ffffff",
    fontWeight: 800,
    fontSize: 16,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

function outlineButtonStyle(
  color: string,
  disabled: boolean
): React.CSSProperties {
  return {
    padding: "14px 22px",
    borderRadius: 10,
    border: `2px solid ${color}`,
    backgroundColor: "#ffffff",
    color,
    fontWeight: 800,
    fontSize: 16,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
  };
}

export default RealtimePage;
