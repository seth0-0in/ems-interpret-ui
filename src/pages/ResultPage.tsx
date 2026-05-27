import { useEffect, useMemo, useState } from "react";
import { useAppData } from "../context/AppDataContext";
import type {
  DiarizationSegment,
  RealtimeMessage,
  RealtimeMeta,
  RealtimeRecord,
  UploadRecord,
} from "../context/AppDataContext";
import AppHeader from "../components/AppHeader";
import { COLORS, sectionHeading, whiteCard } from "../theme";

// ---------- 규칙 기반 자동 추출 ----------

type Extraction = {
  locations: string[];
  patientStateSentences: string[];
  requestSentences: string[];
  emergencyKeywords: string[];
};

const LOCATION_PATTERNS: RegExp[] = [
  /[가-힣]{2,}(?:시|군|구|동|읍|면|리)(?:\s?[가-힣0-9\-]+)?/g,
  /[가-힣0-9]+(?:로|길)\s?\d+(?:[\-]\d+)?/g,
  /\d+\s?(?:층|번지|호|동)\b/g,
  /(?:아파트|병원|학교|건물|편의점|상가|마트|공원|역|터미널|교차로|사거리|육교|주유소|약국|교회|성당|놀이터|주차장)/g,
];

const PATIENT_REGEX =
  /(의식|호흡|맥박|출혈|통증|고통|쓰러|넘어|다쳤|다친|부상|상처|심정지|호흡곤란|어지러|심장|두통|복통|구토|마비|경련|발작|화상|혈압|당뇨|임산부|소아|노약자|혼수|숨\s?을?\s?안|숨\s?쉬)/;

const REQUEST_REGEX =
  /(구급차|응급차|구조|구조대|도와\s?주세요|보내\s?주세요|와\s?주세요|요청|빨리|급해)/;

const EMERGENCY_REGEX =
  /(응급|긴급|위급|사망|위독|심정지|화재|폭발|사고|중상|크게\s?다)/g;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function extractLocations(text: string): string[] {
  const set = new Set<string>();
  for (const pat of LOCATION_PATTERNS) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      const v = m[0].trim();
      if (v.length >= 2) set.add(v);
    }
  }
  return Array.from(set);
}

function extractEmergencyKeywords(text: string): string[] {
  const set = new Set<string>();
  EMERGENCY_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMERGENCY_REGEX.exec(text)) !== null) {
    set.add(m[0].replace(/\s+/g, " ").trim());
  }
  return Array.from(set);
}

function buildExtraction(text: string): Extraction {
  const sentences = splitSentences(text);
  return {
    locations: extractLocations(text),
    patientStateSentences: sentences.filter((s) => PATIENT_REGEX.test(s)),
    requestSentences: sentences.filter((s) => REQUEST_REGEX.test(s)),
    emergencyKeywords: extractEmergencyKeywords(text),
  };
}

// ---------- 포맷 유틸 ----------

const LANG_LABEL: Record<string, string> = {
  ko: "한국어",
  en: "영어",
  zh: "중국어",
  ja: "일본어",
  vi: "베트남어",
  th: "태국어",
  km: "캄보디아어",
  ne: "네팔어",
};

function langName(code?: string): string {
  if (!code) return "-";
  if (code === "unknown") return "감지 필요";
  if (code === "auto") return "자동 감지 중";
  return LANG_LABEL[code] ?? code;
}

function confidenceText(c: number): string {
  if (c >= 0.7) return "높음";
  if (c >= 0.4) return "보통";
  return "낮음";
}

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds)) return "-";
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function msText(v?: number): string {
  if (v === undefined || Number.isNaN(v) || v === 0) return "-";
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${Math.round(v)}ms`;
}

function safeFileSlug(s: string): string {
  const base = s.replace(/\.[^.]+$/, "");
  return base.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_") || "case";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
      ? "&lt;"
      : c === ">"
      ? "&gt;"
      : c === '"'
      ? "&quot;"
      : "&#39;"
  );
}

// 실시간 통역 기록 평균 지연 계산
type RealtimeLatency = {
  sttAvg: number;
  trAvg: number;
  ttsAvg: number;
  e2eAvg: number;
};

function computeRealtimeLatency(messages: RealtimeMessage[]): RealtimeLatency {
  let sttSum = 0,
    sttN = 0,
    trSum = 0,
    trN = 0,
    ttsSum = 0,
    ttsN = 0,
    e2eSum = 0,
    e2eN = 0;
  for (const m of messages) {
    if (m.status === "error") continue;
    if (m.sttMs !== undefined) {
      sttSum += m.sttMs;
      sttN++;
    }
    if (m.translateMs !== undefined) {
      trSum += m.translateMs;
      trN++;
    }
    if (m.ttsMs !== undefined) {
      ttsSum += m.ttsMs;
      ttsN++;
    }
    const e2e = m.ttfaMs ?? m.totalMs;
    if (e2e !== undefined) {
      e2eSum += e2e;
      e2eN++;
    }
  }
  return {
    sttAvg: sttN ? sttSum / sttN : 0,
    trAvg: trN ? trSum / trN : 0,
    ttsAvg: ttsN ? ttsSum / ttsN : 0,
    e2eAvg: e2eN ? e2eSum / e2eN : 0,
  };
}

// 발화자별 언어 추정. 119 현장형 자동 감지 구조:
//   신고자 — 메시지에 detectedCallerLanguage가 있으면 그것을 최우선으로 사용.
//            없으면 "auto" 같은 placeholder를 피하기 위해 실제 감지된 코드만 채택.
//   구급대원 — 항상 한국어 (ko) 고정.
const PLACEHOLDER_LANGS: ReadonlySet<string> = new Set(["", "auto", "unknown"]);

function deriveSpeakerLang(
  messages: RealtimeMessage[],
  speaker: "caller" | "operator"
): string {
  if (speaker === "operator") return "ko";
  // 1) 메시지에 기록된 detectedCallerLanguage 중 valid한 것.
  const detected = messages.find(
    (m) => m.detectedCallerLanguage && !PLACEHOLDER_LANGS.has(m.detectedCallerLanguage)
  )?.detectedCallerLanguage;
  if (detected) return detected;
  // 2) 신고자 메시지의 sourceLanguage 중 valid한 것 (legacy 호환).
  const own = messages.find(
    (m) =>
      m.speaker === "caller" &&
      m.sourceLanguage &&
      !PLACEHOLDER_LANGS.has(m.sourceLanguage)
  )?.sourceLanguage;
  if (own) return own;
  // 3) 구급대원 메시지의 targetLanguage (역방향 추정).
  const other = messages.find(
    (m) =>
      m.speaker === "operator" &&
      m.targetLanguage &&
      !PLACEHOLDER_LANGS.has(m.targetLanguage)
  )?.targetLanguage;
  return other ?? "unknown";
}

type DocSource = "upload" | "realtime";

// 카드 목록에서 사용하는 통합 표현 — 업로드/실시간 record 를 동일한 정렬축
// (createdAt ms) 으로 다루기 위해 한 union 으로 묶는다.
type SourceItem =
  | {
      kind: "upload";
      id: string;
      createdAt: number;
      record: UploadRecord;
    }
  | {
      kind: "realtime";
      id: string;
      createdAt: number;
      record: RealtimeRecord;
    };

// ---------- 컴포넌트 ----------

function ResultPage() {
  const {
    uploadHistory,
    realtimeHistory,
    removeUploadRecord,
    removeRealtimeRecord,
  } = useAppData();

  // 현재 화면에서 문서 본문/다운로드의 기준이 되는 source id.
  // 최신 추가/삭제 시 자동으로 가장 최신 카드를 선택한다 (useEffect 참조).
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [documentGenerated, setDocumentGenerated] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");

  // 업로드 + 실시간 record 를 createdAt 내림차순으로 정렬한 단일 리스트.
  // 사용자는 이 리스트에서 어떤 기록으로 문서를 만들지 카드로 선택한다.
  const allSources: SourceItem[] = useMemo(() => {
    const items: SourceItem[] = [
      ...uploadHistory.map(
        (r): SourceItem => ({
          kind: "upload",
          id: r.id,
          createdAt: r.createdAt,
          record: r,
        })
      ),
      ...realtimeHistory.map(
        (r): SourceItem => ({
          kind: "realtime",
          id: r.id,
          createdAt: r.createdAt,
          record: r,
        })
      ),
    ];
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items;
  }, [uploadHistory, realtimeHistory]);

  // 첫 진입 / 선택된 source 가 사라졌을 때 가장 최신 카드를 자동 선택.
  useEffect(() => {
    if (allSources.length === 0) {
      if (selectedSourceId !== null) setSelectedSourceId(null);
      return;
    }
    const stillExists =
      selectedSourceId !== null &&
      allSources.some((s) => s.id === selectedSourceId);
    if (!stillExists) {
      setSelectedSourceId(allSources[0].id);
    }
  }, [allSources, selectedSourceId]);

  const activeSource = useMemo(
    () => allSources.find((s) => s.id === selectedSourceId) ?? null,
    [allSources, selectedSourceId]
  );

  // 아래에서 사용하는 transcriptionResult / realtimeMessages 등은 모두 선택된
  // record 의 데이터로 시작한다. (active record 가 없으면 안전한 기본값.)
  const transcriptionResult =
    activeSource?.kind === "upload" ? activeSource.record.result : null;
  const selectedFileName =
    activeSource?.kind === "upload" ? activeSource.record.fileName : "";
  const translations =
    activeSource?.kind === "upload" ? activeSource.record.translations : {};
  const realtimeMessages: RealtimeMessage[] =
    activeSource?.kind === "realtime" ? activeSource.record.messages : [];
  const realtimeSessionStart =
    activeSource?.kind === "realtime" ? activeSource.record.createdAt : null;
  const realtimeSessionEnd =
    activeSource?.kind === "realtime" ? activeSource.record.endedAt : null;
  const realtimeMeta: RealtimeMeta =
    activeSource?.kind === "realtime" ? activeSource.record.meta : {};

  // 현재 active source 의 타입 — 기존 docSource 와 동일한 의미.
  const docSource: DocSource =
    activeSource?.kind === "realtime" ? "realtime" : "upload";

  // source 가 바뀌면 이전 문서 생성/메모는 무효화한다.
  useEffect(() => {
    setDocumentGenerated(false);
    setGeneratedAt(null);
    setNotes("");
  }, [selectedSourceId]);

  // ----- 업로드 전사 기반 파생 데이터 -----
  // 자동 처리(diarization) 결과에는 segment 별 한국어 번역도 포함되므로
  // 추출은 원문 + 한국어 번역을 합쳐서 돌린다 — 외국어 발화에서도 한국어 키워드가 잡힌다.
  const uploadExtraction = useMemo(() => {
    if (!transcriptionResult) return null;
    const original = transcriptionResult.text ?? "";
    const top = transcriptionResult.translated ?? "";
    const segs = transcriptionResult.segments ?? [];
    const segTranslated = segs
      .map((s) => s.translated || translations[(segs.indexOf(s) as number)] || "")
      .filter(Boolean)
      .join("\n");
    const combined = [original, top, segTranslated].filter(Boolean).join("\n");
    return buildExtraction(combined);
  }, [transcriptionResult, translations]);

  // 업로드 결과의 통합 한국어/통역 번역문.
  //   1) envelope.translated 가 있으면 그것을 우선 사용.
  //   2) 없으면 segment.translated 를 줄단위로 결합.
  const uploadTranslatedText = useMemo(() => {
    if (!transcriptionResult) return "";
    if (transcriptionResult.translated && transcriptionResult.translated.trim()) {
      return transcriptionResult.translated;
    }
    return (transcriptionResult.segments ?? [])
      .map((s) => s.translated || "")
      .filter(Boolean)
      .join("\n");
  }, [transcriptionResult]);

  // 업로드 화자별 발화 정렬용 데이터.
  //   서버가 segment.role 을 채워주지 못한 경우, 같은 speaker 라벨 + source_language 로
  //   caller(외국어)/operator(한국어) 를 추정.
  const uploadSpeakerRoleMap = useMemo(() => {
    const map = new Map<string, "caller" | "operator" | "unknown">();
    const segs = transcriptionResult?.segments ?? [];
    for (const s of segs) {
      if (!s.speaker || map.has(s.speaker)) continue;
      if (s.source_language === "ko") map.set(s.speaker, "operator");
      else if (s.source_language && s.source_language !== "unknown")
        map.set(s.speaker, "caller");
    }
    if (map.size === 0) {
      const labels = [...new Set(segs.map((s) => s.speaker).filter(Boolean))];
      labels.forEach((label, idx) =>
        map.set(label, idx === 0 ? "caller" : "operator")
      );
    }
    return map;
  }, [transcriptionResult]);

  // ----- 실시간 통역 기반 파생 데이터 -----
  // 문서에 포함되는 실제 인식 발화:
  //   - 원문이 비어있지 않고
  //   - local-agreement에서 중복으로 폐기되지 않은 (transcriptConfirmed !== false) chunk
  const realtimeRows = useMemo(
    () =>
      realtimeMessages.filter(
        (m) =>
          m.original.trim().length > 0 && m.transcriptConfirmed !== false
      ),
    [realtimeMessages]
  );

  const realtimeExtraction = useMemo(() => {
    if (realtimeRows.length === 0) return null;
    const text = realtimeRows
      .map((m) => `${m.original}\n${m.translated}`)
      .join("\n");
    return buildExtraction(text);
  }, [realtimeRows]);

  const realtimeLatency = useMemo(
    () => computeRealtimeLatency(realtimeMessages),
    [realtimeMessages]
  );

  const callerLang = useMemo(
    () => deriveSpeakerLang(realtimeMessages, "caller"),
    [realtimeMessages]
  );
  const operatorLang = useMemo(
    () => deriveSpeakerLang(realtimeMessages, "operator"),
    [realtimeMessages]
  );

  // 추가 감지 외국어 — caller 메시지의 sourceLanguage 중 primary 외의 valid 코드.
  const secondaryCallerLangs = useMemo(() => {
    const set = new Set<string>();
    for (const m of realtimeMessages) {
      if (
        m.speaker === "caller" &&
        m.sourceLanguage &&
        !PLACEHOLDER_LANGS.has(m.sourceLanguage) &&
        m.sourceLanguage !== callerLang
      ) {
        set.add(m.sourceLanguage);
      }
    }
    return [...set];
  }, [realtimeMessages, callerLang]);

  // 판단 불가 발화 — speaker === "unknown" 인 메시지.
  const unclassifiedRows = useMemo(
    () => realtimeMessages.filter((m) => m.speaker === "unknown"),
    [realtimeMessages]
  );

  // 자동 역할 판단 카운트.
  const speakerCounts = useMemo(() => {
    const c = { caller: 0, operator: 0, interpreter: 0, unknown: 0 };
    for (const m of realtimeMessages) {
      if (m.speaker in c) c[m.speaker as keyof typeof c] += 1;
    }
    return c;
  }, [realtimeMessages]);

  // 처리 결과 카운트 — 성공(done)/오류(error)/기타.
  const statusCounts = useMemo(() => {
    let success = 0;
    let error = 0;
    let other = 0;
    for (const m of realtimeMessages) {
      if (m.status === "done") success++;
      else if (m.status === "error") error++;
      else other++;
    }
    return { success, error, other };
  }, [realtimeMessages]);

  // 서버 화자분리 segment 요약 — 화자분리 정보가 있는 chunk만.
  // diarization mode 응답은 segment 별 role / translated 까지 enrichment 되어 들어오므로
  // translatedSegments / erroredSegments / chunksWithRole 등 보조 카운터도 함께 노출한다.
  // chunksWithSegmentData: 화면 Section 7 에서 chunk 별로 segment 를 그대로 그릴 때 사용.
  const diarizationSummary = useMemo(() => {
    const speakerTotals = new Map<string, number>();
    let chunksWithSegments = 0;
    let totalSegments = 0;
    let translatedSegments = 0;
    let erroredSegments = 0;
    const chunksWithSegmentData: Array<{
      id: number;
      timestamp: number;
      speakerLabel: string;
      segments: DiarizationSegment[];
    }> = [];
    for (const m of realtimeMessages) {
      const segs = m.diarizationSegments;
      if (!segs || segs.length === 0) continue;
      chunksWithSegments++;
      totalSegments += segs.length;
      for (const s of segs) {
        const dur = Math.max(0, s.end - s.start);
        speakerTotals.set(
          s.speaker,
          (speakerTotals.get(s.speaker) ?? 0) + dur
        );
        if (s.translated && s.translated.length > 0) translatedSegments++;
        if (s.error) erroredSegments++;
      }
      chunksWithSegmentData.push({
        id: m.id,
        timestamp: m.timestamp,
        speakerLabel: m.speakerLabel,
        segments: segs,
      });
    }
    const ranked = [...speakerTotals.entries()].sort((a, b) => b[1] - a[1]);
    return {
      chunksWithSegments,
      totalSegments,
      translatedSegments,
      erroredSegments,
      ranked,
      chunksWithSegmentData,
    };
  }, [realtimeMessages]);

  // 세션 시각 계산
  const rtStart =
    realtimeSessionStart ?? realtimeMessages[0]?.timestamp ?? null;
  const rtEndEffective =
    realtimeSessionEnd ??
    (generatedAt ? generatedAt.getTime() : Date.now());
  const rtElapsedSec =
    rtStart != null
      ? Math.max(0, (rtEndEffective - rtStart) / 1000)
      : undefined;

  const handleGenerate = () => {
    setDocumentGenerated(true);
    setGeneratedAt(new Date());
  };

  const handleSelectSource = (id: string) => {
    if (id === selectedSourceId) return;
    setSelectedSourceId(id);
    // setDocumentGenerated/notes 는 selectedSourceId 변화에 반응하는 effect 가 비운다.
  };

  const handleRemoveSource = (item: SourceItem) => {
    const label =
      item.kind === "upload"
        ? item.record.fileName || "(미상 파일)"
        : `${formatTimestamp(new Date(item.createdAt))} 실시간 통역`;
    const ok = window.confirm(
      `이 기록을 삭제할까요?\n· ${label}\n삭제한 기록은 복구할 수 없습니다.`
    );
    if (!ok) return;
    if (item.kind === "upload") removeUploadRecord(item.id);
    else removeRealtimeRecord(item.id);
  };

  // ---------- 업로드 기반 문서 빌더 ----------

  const buildUploadText = (): string => {
    if (!transcriptionResult || !uploadExtraction) return "";
    const ex = uploadExtraction;
    const lines: string[] = [];
    const sep = "=".repeat(50);
    const sub = "-".repeat(50);
    lines.push(sep);
    lines.push("119 긴급구조표준시스템 사건 기록 문서");
    lines.push("(업로드 녹취 자동 분석 기반)");
    lines.push(sep);
    lines.push("");
    lines.push("[1. 사건 개요]");
    lines.push(`문서 종류           : 업로드 음성파일 자동 분석 기록`);
    lines.push(`파일명              : ${selectedFileName || "(미상)"}`);
    lines.push(
      `처리 일시           : ${generatedAt ? formatTimestamp(generatedAt) : "-"}`
    );
    lines.push(
      `통화 시간           : ${formatDuration(transcriptionResult.duration)}`
    );
    if (transcriptionResult.processing_time !== undefined) {
      lines.push(
        `처리 시간           : ${transcriptionResult.processing_time.toFixed(2)}s`
      );
    }
    lines.push(
      `처리 모드           : ${
        transcriptionResult.mode === "diarization"
          ? "화자분리 자동 분석"
          : "일반"
      }`
    );
    lines.push(
      `감지된 신고자 언어  : ${langName(transcriptionResult.caller_language)}`
    );
    lines.push(`구급대원 언어       : 한국어 (고정)`);
    lines.push(`총 발화 segment 수  : ${transcriptionResult.segments.length}건`);
    lines.push("");
    lines.push(sub);
    lines.push("[2. 전체 대화 원문]");
    lines.push(transcriptionResult.text || "(원문 없음)");
    lines.push("");
    lines.push(sub);
    lines.push("[3. 한국어/통역 번역문]");
    lines.push(uploadTranslatedText || "(번역 결과 없음)");
    lines.push("");
    lines.push(sub);
    lines.push("[4. 화자별 발화 기록]");
    transcriptionResult.segments.forEach((seg, i) => {
      const role =
        seg.role ?? uploadSpeakerRoleMap.get(seg.speaker) ?? "unknown";
      const roleLabel =
        role === "caller"
          ? "신고자"
          : role === "operator"
          ? "구급대원"
          : role === "interpreter"
          ? "통역사"
          : "판단 불가";
      const langPair =
        seg.source_language || seg.target_language
          ? ` (${langName(seg.source_language)} → ${langName(seg.target_language)})`
          : "";
      lines.push(
        `[${formatDuration(seg.start)} ~ ${formatDuration(seg.end)}] ${seg.speaker || "화자 ?"} · ${roleLabel}${langPair}`
      );
      lines.push(`  원문 : ${seg.text}`);
      const tr = seg.translated || translations[i] || "";
      lines.push(`  통역 : ${tr || "(통역 결과 없음)"}`);
      if (seg.role_reason) {
        lines.push(`  근거 : ${seg.role_reason}`);
      }
      if (seg.error) {
        lines.push(
          `  ⚠ 오류: ${seg.error}${seg.reason ? ` (${seg.reason})` : ""}`
        );
      }
    });
    lines.push("");
    lines.push(sub);
    lines.push("[5. 주요 위치 / 증상 / 요청사항 자동 추출]");
    lines.push("- 위치 관련:");
    if (ex.locations.length === 0) lines.push("    (감지된 위치 표현 없음)");
    else ex.locations.forEach((v) => lines.push(`    · ${v}`));
    lines.push("- 환자 상태 / 증상:");
    if (ex.patientStateSentences.length === 0)
      lines.push("    (감지된 표현 없음)");
    else ex.patientStateSentences.forEach((v) => lines.push(`    · ${v}`));
    lines.push("- 요청 내용:");
    if (ex.requestSentences.length === 0)
      lines.push("    (감지된 요청 표현 없음)");
    else ex.requestSentences.forEach((v) => lines.push(`    · ${v}`));
    lines.push("- 긴급 키워드:");
    if (ex.emergencyKeywords.length === 0)
      lines.push("    (감지된 키워드 없음)");
    else lines.push(`    ${ex.emergencyKeywords.join(", ")}`);
    lines.push("");
    lines.push(sub);
    lines.push("[6. 처리 지연 / 품질 정보]");
    const lat = transcriptionResult.latency ?? {};
    lines.push(`STT (음성인식)       : ${msText(lat.stt_ms)}`);
    lines.push(`번역                 : ${msText(lat.translate_ms)}`);
    lines.push(`TTS (음성합성)       : ${msText(lat.tts_ms)}`);
    lines.push(`총 처리 시간         : ${msText(lat.total_ms)}`);
    lines.push("");
    lines.push(sub);
    lines.push("[7. 오류 로그]");
    const errs = transcriptionResult.errors ?? [];
    if (errs.length === 0) lines.push("(오류 없음)");
    else errs.forEach((e) => lines.push(`  · ${e}`));
    lines.push("");
    lines.push(sub);
    lines.push("[8. 특이사항 / 비고]");
    lines.push(notes.trim().length === 0 ? "(없음)" : notes);
    lines.push("");
    lines.push(sep);
    lines.push(
      "본 문서는 119 긴급구조표준시스템 자동 분석 결과를 기반으로 자동 생성되었습니다."
    );
    return lines.join("\n");
  };

  const buildUploadHtml = (): string => {
    if (!transcriptionResult || !uploadExtraction) return "";
    const ex = uploadExtraction;
    const filename = escapeHtml(selectedFileName || "(미상)");
    const dateStr = generatedAt
      ? escapeHtml(formatTimestamp(generatedAt))
      : "-";
    const duration = escapeHtml(formatDuration(transcriptionResult.duration));
    const procTime =
      transcriptionResult.processing_time !== undefined
        ? `${transcriptionResult.processing_time.toFixed(2)}s`
        : "-";

    const ul = (arr: string[]) =>
      arr.length === 0
        ? `<div class="empty">감지된 항목 없음</div>`
        : `<ul>${arr.map((v) => `<li>${escapeHtml(v)}</li>`).join("")}</ul>`;

    const segmentsHtml = transcriptionResult.segments
      .map((seg, i) => {
        const role =
          seg.role ?? uploadSpeakerRoleMap.get(seg.speaker) ?? "unknown";
        const roleLabel =
          role === "caller"
            ? "신고자"
            : role === "operator"
            ? "구급대원"
            : role === "interpreter"
            ? "통역사"
            : "판단 불가";
        const langPair =
          seg.source_language || seg.target_language
            ? ` · ${escapeHtml(langName(seg.source_language))} → ${escapeHtml(
                langName(seg.target_language)
              )}`
            : "";
        const tr = seg.translated || translations[i] || "";
        const trHtml = tr
          ? `<div class="translation"><span class="tag">통역</span> ${escapeHtml(tr)}</div>`
          : "";
        const reasonHtml = seg.role_reason
          ? `<div class="meta" style="font-style:italic;color:#64748b;">근거: ${escapeHtml(seg.role_reason)}</div>`
          : "";
        const errHtml = seg.error
          ? `<div class="meta" style="color:#b21e13;">⚠ 오류: ${escapeHtml(seg.error)}${
              seg.reason ? ` (${escapeHtml(seg.reason)})` : ""
            }</div>`
          : "";
        return `<div class="segment">
          <div class="meta">[${escapeHtml(formatDuration(seg.start))} ~ ${escapeHtml(formatDuration(seg.end))}] <strong>${escapeHtml(seg.speaker || "화자 ?")}</strong> · ${escapeHtml(roleLabel)}${langPair}</div>
          <div class="text"><span class="tag">원문</span> ${escapeHtml(seg.text)}</div>
          ${trHtml}
          ${reasonHtml}
          ${errHtml}
        </div>`;
      })
      .join("");

    const emergencyHtml =
      ex.emergencyKeywords.length === 0
        ? `<div class="empty">감지된 키워드 없음</div>`
        : `<div class="kw-list">${ex.emergencyKeywords
            .map((k) => `<span class="kw">${escapeHtml(k)}</span>`)
            .join(" ")}</div>`;

    const lat = transcriptionResult.latency ?? {};
    const errs = transcriptionResult.errors ?? [];
    const errorsHtml =
      errs.length === 0
        ? `<div class="empty">(오류 없음)</div>`
        : `<ul>${errs.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;
    const callerLang = escapeHtml(langName(transcriptionResult.caller_language));
    const modeLabel =
      transcriptionResult.mode === "diarization"
        ? "화자분리 자동 분석"
        : "일반";

    return wrapHtmlDocument(
      `119 사건 기록 문서 - ${filename}`,
      "업로드 녹취 자동 분석 기반",
      `
  <h2>1. 사건 개요</h2>
  <table class="meta-table">
    <tr><td class="k">문서 종류</td><td>업로드 음성파일 자동 분석 기록</td></tr>
    <tr><td class="k">파일명</td><td>${filename}</td></tr>
    <tr><td class="k">처리 일시</td><td>${dateStr}</td></tr>
    <tr><td class="k">전체 통화 시간</td><td>${duration}</td></tr>
    <tr><td class="k">처리 소요 시간</td><td>${escapeHtml(procTime)}</td></tr>
    <tr><td class="k">처리 모드</td><td>${escapeHtml(modeLabel)}</td></tr>
    <tr><td class="k">감지된 신고자 언어</td><td>${callerLang}</td></tr>
    <tr><td class="k">구급대원 언어</td><td>한국어 (고정)</td></tr>
    <tr><td class="k">총 발화 segment 수</td><td>${transcriptionResult.segments.length}건</td></tr>
  </table>

  <h2>2. 전체 대화 원문</h2>
  <div class="full-text">${escapeHtml(transcriptionResult.text || "(원문 없음)")}</div>

  <h2>3. 한국어/통역 번역문</h2>
  <div class="full-text">${escapeHtml(uploadTranslatedText || "(번역 결과 없음)")}</div>

  <h2>4. 화자별 발화 기록</h2>
  <div class="section">${segmentsHtml || `<div class="empty">화자별 구간이 없습니다.</div>`}</div>

  <h2>5. 주요 위치 / 증상 / 요청사항 자동 추출</h2>
  <div class="section"><strong>· 위치 관련</strong>${ul(ex.locations)}</div>
  <div class="section"><strong>· 환자 상태 / 증상</strong>${ul(ex.patientStateSentences)}</div>
  <div class="section"><strong>· 요청 내용</strong>${ul(ex.requestSentences)}</div>
  <div class="section"><strong>· 긴급 키워드</strong>${emergencyHtml}</div>

  <h2>6. 처리 지연 / 품질 정보</h2>
  <table class="meta-table">
    <tr><td class="k">STT (음성인식)</td><td>${escapeHtml(msText(lat.stt_ms))}</td></tr>
    <tr><td class="k">번역</td><td>${escapeHtml(msText(lat.translate_ms))}</td></tr>
    <tr><td class="k">TTS (음성합성)</td><td>${escapeHtml(msText(lat.tts_ms))}</td></tr>
    <tr><td class="k">총 처리 시간</td><td>${escapeHtml(msText(lat.total_ms))}</td></tr>
  </table>

  <h2>7. 오류 로그</h2>
  <div class="section">${errorsHtml}</div>

  <h2>8. 특이사항 / 비고</h2>
  ${notesHtmlBlock(notes)}
`
    );
  };

  // ---------- 실시간 통역 기반 문서 빌더 ----------

  const buildRealtimeText = (): string => {
    const ex = realtimeExtraction;
    const lines: string[] = [];
    const sep = "=".repeat(50);
    const sub = "-".repeat(50);
    lines.push(sep);
    lines.push("119 긴급구조표준시스템 사건 기록 문서");
    lines.push("(실시간 통역 기반)");
    lines.push(sep);
    lines.push("");
    lines.push("[기본 정보]");
    lines.push(`문서 종류  : 실시간 통역 세션 기록`);
    lines.push(`처리 일시  : ${generatedAt ? formatTimestamp(generatedAt) : "-"}`);
    lines.push(
      `세션 시작  : ${rtStart != null ? formatTimestamp(new Date(rtStart)) : "-"}`
    );
    lines.push(
      `세션 종료  : ${
        realtimeSessionEnd != null
          ? formatTimestamp(new Date(realtimeSessionEnd))
          : "(미종료 / 진행 중)"
      }`
    );
    lines.push(`진행 시간  : ${formatDuration(rtElapsedSec)}`);
    lines.push(`대화 건수  : ${realtimeRows.length}건`);
    lines.push("");
    lines.push("[참여자 및 사용 언어]");
    lines.push(`신고자             : ${langName(callerLang)}`);
    lines.push(`구급대원           : ${langName(operatorLang)}`);
    lines.push(`감지된 신고자 언어 : ${langName(callerLang)} (1차)`);
    lines.push(
      `추가 감지 외국어   : ${
        secondaryCallerLangs.length === 0
          ? "(없음)"
          : secondaryCallerLangs.map((l) => langName(l)).join(", ")
      }`
    );
    lines.push(
      `자동 역할 판단     : 신고자 ${speakerCounts.caller} · 구급대원 ${speakerCounts.operator} · 통역사 ${speakerCounts.interpreter} · 판단 불가 ${speakerCounts.unknown}`
    );
    lines.push("");
    lines.push("[주요 내용 자동 정리]");
    lines.push("- 위치 관련:");
    if (!ex || ex.locations.length === 0)
      lines.push("    (감지된 위치 표현 없음)");
    else ex.locations.forEach((v) => lines.push(`    · ${v}`));
    lines.push("- 환자 상태 관련:");
    if (!ex || ex.patientStateSentences.length === 0)
      lines.push("    (감지된 표현 없음)");
    else ex.patientStateSentences.forEach((v) => lines.push(`    · ${v}`));
    lines.push("- 요청 내용:");
    if (!ex || ex.requestSentences.length === 0)
      lines.push("    (감지된 요청 표현 없음)");
    else ex.requestSentences.forEach((v) => lines.push(`    · ${v}`));
    lines.push("- 긴급 키워드:");
    if (!ex || ex.emergencyKeywords.length === 0)
      lines.push("    (감지된 키워드 없음)");
    else lines.push(`    ${ex.emergencyKeywords.join(", ")}`);
    lines.push("");
    lines.push("[처리 지연 요약]");
    lines.push(`평균 음성인식(STT) : ${msText(realtimeLatency.sttAvg)}`);
    lines.push(`평균 번역          : ${msText(realtimeLatency.trAvg)}`);
    lines.push(`평균 음성합성(TTS) : ${msText(realtimeLatency.ttsAvg)}`);
    lines.push(`평균 응답지연(E2E) : ${msText(realtimeLatency.e2eAvg)}`);
    lines.push("");
    lines.push(sub);
    lines.push("[전체 대화 기록]");
    if (realtimeRows.length === 0) {
      lines.push("(기록된 대화가 없습니다.)");
    } else {
      realtimeRows.forEach((m) => {
        lines.push(
          `[${formatClock(m.timestamp)}] ${m.speakerLabel} (${langName(m.sourceLanguage)} → ${langName(m.targetLanguage)})`
        );
        if (m.speakerConfidence !== undefined || m.speakerReason) {
          const confStr =
            m.speakerConfidence !== undefined
              ? ` 신뢰도 ${confidenceText(m.speakerConfidence)} (${Math.round(
                  m.speakerConfidence * 100
                )}%)`
              : "";
          const reasonStr = m.speakerReason ? ` · 근거: ${m.speakerReason}` : "";
          lines.push(`  자동 판단:${confStr}${reasonStr}`);
        }
        lines.push(`  원문 : ${m.original}`);
        lines.push(`  통역 : ${m.translated || "(통역 결과 없음)"}`);
        // diarization mode 응답이 들어온 chunk 는 segment 별 role/번역도 같이 보존.
        const segs = m.diarizationSegments ?? [];
        const enrichedSegs = segs.filter(
          (s) => s.role || s.translated || s.source_language || s.error
        );
        if (enrichedSegs.length > 0) {
          lines.push(`  [segment 별 결과 — ${enrichedSegs.length}건]`);
          enrichedSegs.forEach((s, idx) => {
            const role = s.role ?? "unknown";
            const roleLabel =
              role === "caller"
                ? "신고자"
                : role === "operator"
                ? "구급대원"
                : role === "interpreter"
                ? "통역사"
                : "판단 불가";
            const lang =
              s.source_language || s.target_language
                ? ` (${langName(s.source_language)} → ${langName(
                    s.target_language
                  )})`
                : "";
            lines.push(
              `   ${idx + 1}. [${s.start.toFixed(2)}–${s.end.toFixed(
                2
              )}s] ${s.speaker || "SPK_?"} · ${roleLabel}${lang}`
            );
            lines.push(`      원문 : ${s.text}`);
            if (s.translated) lines.push(`      통역 : ${s.translated}`);
            if (s.error) {
              lines.push(
                `      ⚠ 오류: ${s.error}${
                  s.reason ? ` (${s.reason})` : ""
                }`
              );
            } else if (s.reason) {
              lines.push(`      사유: ${s.reason}`);
            }
          });
        }
        lines.push("");
      });
    }
    lines.push(sub);
    lines.push("[판단 불가 발화 목록]");
    if (unclassifiedRows.length === 0) {
      lines.push("(판단 불가 발화가 없습니다.)");
    } else {
      unclassifiedRows.forEach((m) => {
        lines.push(
          `[${formatClock(m.timestamp)}] (${langName(m.sourceLanguage)})${
            m.speakerReason ? ` · ${m.speakerReason}` : ""
          }`
        );
        lines.push(`  원문 : ${m.original}`);
      });
    }
    lines.push("");
    lines.push(sub);
    lines.push("[특이사항 / 비고]");
    lines.push(notes.trim().length === 0 ? "(없음)" : notes);
    lines.push("");
    lines.push(sep);
    lines.push(
      "본 문서는 119 긴급구조표준시스템 실시간 통역 대화 기록을 기반으로 자동 생성되었습니다."
    );
    return lines.join("\n");
  };

  const buildRealtimeHtml = (): string => {
    const ex = realtimeExtraction;
    const dateStr = generatedAt
      ? escapeHtml(formatTimestamp(generatedAt))
      : "-";
    const startStr =
      rtStart != null
        ? escapeHtml(formatTimestamp(new Date(rtStart)))
        : "-";
    const endStr =
      realtimeSessionEnd != null
        ? escapeHtml(formatTimestamp(new Date(realtimeSessionEnd)))
        : "(미종료 / 진행 중)";

    const ul = (arr: string[] | undefined) =>
      !arr || arr.length === 0
        ? `<div class="empty">감지된 항목 없음</div>`
        : `<ul>${arr.map((v) => `<li>${escapeHtml(v)}</li>`).join("")}</ul>`;

    const emergencyHtml =
      !ex || ex.emergencyKeywords.length === 0
        ? `<div class="empty">감지된 키워드 없음</div>`
        : `<div class="kw-list">${ex.emergencyKeywords
            .map((k) => `<span class="kw">${escapeHtml(k)}</span>`)
            .join(" ")}</div>`;

    const renderClassification = (m: RealtimeMessage): string => {
      if (m.speakerConfidence === undefined && !m.speakerReason) return "";
      const confStr =
        m.speakerConfidence !== undefined
          ? `신뢰도 ${escapeHtml(confidenceText(m.speakerConfidence))} (${Math.round(
              m.speakerConfidence * 100
            )}%)`
          : "";
      const reasonStr = m.speakerReason
        ? `근거: ${escapeHtml(m.speakerReason)}`
        : "";
      return `<div class="meta" style="font-style:italic;color:#64748b;">자동 판단${
        confStr ? ` · ${confStr}` : ""
      }${reasonStr ? ` · ${reasonStr}` : ""}</div>`;
    };

    const renderSegmentsHtml = (m: RealtimeMessage): string => {
      const segs = m.diarizationSegments ?? [];
      const enriched = segs.filter(
        (s) => s.role || s.translated || s.source_language || s.error
      );
      if (enriched.length === 0) return "";
      const items = enriched
        .map((s) => {
          const role = s.role ?? "unknown";
          const roleLabel =
            role === "caller"
              ? "신고자"
              : role === "operator"
              ? "구급대원"
              : role === "interpreter"
              ? "통역사"
              : "판단 불가";
          const langPair =
            s.source_language || s.target_language
              ? ` · ${escapeHtml(langName(s.source_language))} → ${escapeHtml(
                  langName(s.target_language)
                )}`
              : "";
          const translatedHtml = s.translated
            ? `<div class="translation"><span class="tag">통역</span> ${escapeHtml(
                s.translated
              )}</div>`
            : "";
          const errorHtml = s.error
            ? `<div class="meta" style="color:#b21e13;">⚠ 오류: ${escapeHtml(
                s.error
              )}${s.reason ? ` (${escapeHtml(s.reason)})` : ""}</div>`
            : s.reason
            ? `<div class="meta" style="font-style:italic;">사유: ${escapeHtml(
                s.reason
              )}</div>`
            : "";
          return `<li style="margin-top:4px;padding:4px 6px;border-left:3px solid #cbd5e1;">
            <div class="meta">[${s.start.toFixed(2)}–${s.end.toFixed(
            2
          )}s] ${escapeHtml(s.speaker || "SPK_?")} · ${escapeHtml(
            roleLabel
          )}${langPair}</div>
            <div class="text"><span class="tag">원문</span> ${escapeHtml(s.text)}</div>
            ${translatedHtml}
            ${errorHtml}
          </li>`;
        })
        .join("");
      return `<ul style="margin:6px 0 0 12px;padding:0;list-style:none;">${items}</ul>`;
    };

    const convHtml =
      realtimeRows.length === 0
        ? `<div class="empty">기록된 대화가 없습니다.</div>`
        : realtimeRows
            .map(
              (m) => `<div class="segment">
          <div class="meta">[${escapeHtml(formatClock(m.timestamp))}] <strong>${escapeHtml(m.speakerLabel)}</strong> · ${escapeHtml(langName(m.sourceLanguage))} → ${escapeHtml(langName(m.targetLanguage))}</div>
          ${renderClassification(m)}
          <div class="text"><span class="tag">원문</span> ${escapeHtml(m.original)}</div>
          <div class="translation"><span class="tag">통역</span> ${escapeHtml(m.translated || "(통역 결과 없음)")}</div>
          ${renderSegmentsHtml(m)}
        </div>`
            )
            .join("");

    const unclassifiedHtml =
      unclassifiedRows.length === 0
        ? `<div class="empty">판단 불가 발화가 없습니다.</div>`
        : unclassifiedRows
            .map(
              (m) => `<div class="segment">
          <div class="meta">[${escapeHtml(formatClock(m.timestamp))}] (${escapeHtml(langName(m.sourceLanguage))})${
            m.speakerReason ? ` · ${escapeHtml(m.speakerReason)}` : ""
          }</div>
          <div class="text">${escapeHtml(m.original)}</div>
        </div>`
            )
            .join("");

    return wrapHtmlDocument(
      "119 실시간 통역 기록 문서",
      "실시간 통역 기반",
      `
  <h2>1. 기본 정보</h2>
  <table class="meta-table">
    <tr><td class="k">문서 종류</td><td>실시간 통역 세션 기록</td></tr>
    <tr><td class="k">처리 일시</td><td>${dateStr}</td></tr>
    <tr><td class="k">세션 시작</td><td>${startStr}</td></tr>
    <tr><td class="k">세션 종료</td><td>${endStr}</td></tr>
    <tr><td class="k">전체 진행 시간</td><td>${escapeHtml(formatDuration(rtElapsedSec))}</td></tr>
    <tr><td class="k">대화 건수</td><td>${realtimeRows.length}건</td></tr>
  </table>

  <h2>2. 참여자 및 사용 언어</h2>
  <table class="meta-table">
    <tr><td class="k">신고자</td><td>${escapeHtml(langName(callerLang))}</td></tr>
    <tr><td class="k">구급대원</td><td>${escapeHtml(langName(operatorLang))}</td></tr>
    <tr><td class="k">감지된 신고자 언어 (1차)</td><td>${escapeHtml(langName(callerLang))}</td></tr>
    <tr><td class="k">추가 감지 외국어</td><td>${
      secondaryCallerLangs.length === 0
        ? "(없음)"
        : escapeHtml(secondaryCallerLangs.map((l) => langName(l)).join(", "))
    }</td></tr>
    <tr><td class="k">자동 역할 판단</td><td>신고자 ${speakerCounts.caller} · 구급대원 ${speakerCounts.operator} · 통역사 ${speakerCounts.interpreter} · 판단 불가 ${speakerCounts.unknown}</td></tr>
  </table>

  <h2>3. 주요 내용 자동 정리</h2>
  <div class="section"><strong>· 위치 관련</strong>${ul(ex?.locations)}</div>
  <div class="section"><strong>· 환자 상태 관련</strong>${ul(ex?.patientStateSentences)}</div>
  <div class="section"><strong>· 요청 내용</strong>${ul(ex?.requestSentences)}</div>
  <div class="section"><strong>· 긴급 키워드</strong>${emergencyHtml}</div>

  <h2>4. 처리 지연 요약</h2>
  <table class="meta-table">
    <tr><td class="k">평균 음성인식(STT)</td><td>${escapeHtml(msText(realtimeLatency.sttAvg))}</td></tr>
    <tr><td class="k">평균 번역</td><td>${escapeHtml(msText(realtimeLatency.trAvg))}</td></tr>
    <tr><td class="k">평균 음성합성(TTS)</td><td>${escapeHtml(msText(realtimeLatency.ttsAvg))}</td></tr>
    <tr><td class="k">평균 응답지연(E2E)</td><td>${escapeHtml(msText(realtimeLatency.e2eAvg))}</td></tr>
  </table>

  <h2>5. 전체 대화 기록</h2>
  <div class="section">${convHtml}</div>

  <h2>6. 판단 불가 발화 목록</h2>
  <div class="section">${unclassifiedHtml}</div>

  <h2>7. 특이사항 / 비고</h2>
  ${notesHtmlBlock(notes)}
`
    );
  };

  // ---------- 문서 소스에 따른 디스패치 ----------

  const buildActiveText = () =>
    docSource === "upload" ? buildUploadText() : buildRealtimeText();
  const buildActiveHtml = () =>
    docSource === "upload" ? buildUploadHtml() : buildRealtimeHtml();

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const fileSlug = () =>
    docSource === "upload"
      ? safeFileSlug(selectedFileName || "case")
      : "realtime_session";

  const handleDownloadTxt = () => {
    if (!documentGenerated) return;
    downloadFile(
      buildActiveText(),
      `119_사건기록_${fileSlug()}.txt`,
      "text/plain;charset=utf-8"
    );
  };

  const handleDownloadHtml = () => {
    if (!documentGenerated) return;
    downloadFile(
      buildActiveHtml(),
      `119_사건기록_${fileSlug()}.html`,
      "text/html;charset=utf-8"
    );
  };

  const handlePrint = () => {
    if (!documentGenerated) return;
    const html = buildActiveHtml();
    const win = window.open("", "_blank", "width=900,height=720");
    if (!win) {
      alert("팝업이 차단되었습니다. 인쇄용 창을 열 수 없습니다.");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => {
      try {
        win.print();
      } catch (e) {
        console.error("print 호출 실패", e);
      }
    }, 250);
  };

  // ---------- 렌더 ----------

  const canGenerate = activeSource !== null;

  return (
    <div style={{ minHeight: "100vh", backgroundColor: COLORS.pageBg }}>
      <AppHeader subtitle="음성 인식·통역 결과를 행정 사건 기록 문서로 정리" />

      <main
        style={{
          maxWidth: 1000,
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
            사건 기록 문서
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              color: COLORS.onDarkMuted,
              fontSize: 14,
            }}
          >
            업로드 녹취 또는 실시간 통역 기록을 최신순으로 정리합니다. 카드를
            클릭해 그 기록의 사건 기록 문서를 생성하세요.
          </p>
        </div>

        {allSources.length === 0 ? (
          <section style={whiteCard}>
            <div
              style={{
                padding: "44px 16px",
                textAlign: "center",
                color: COLORS.inkMuted,
                lineHeight: 1.9,
              }}
            >
              아직 사용할 수 있는 기록이 없습니다.
              <br />
              <strong style={{ color: COLORS.ink }}>
                업로드 전사
              </strong>{" "}
              화면에서 음성파일을 처리하거나,{" "}
              <strong style={{ color: COLORS.ink }}>실시간 통역</strong>{" "}
              화면에서 통역을 진행한 뒤 다시 들어와 주세요.
            </div>
          </section>
        ) : (
          <>
            {/* 문서 소스 선택 — 모든 기록을 최신순 카드로 표시 */}
            <section style={{ ...whiteCard, marginBottom: 18 }}>
              <div style={sectionHeading}>
                문서 생성 소스 선택
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: COLORS.inkMuted,
                  }}
                >
                  총 {allSources.length}건 · 최신 통화/녹취가 위에 표시됩니다
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {allSources.map((item) => (
                  <SourceCard
                    key={item.id}
                    item={item}
                    active={item.id === selectedSourceId}
                    onSelect={() => handleSelectSource(item.id)}
                    onRemove={() => handleRemoveSource(item)}
                  />
                ))}
              </div>
            </section>

            {/* 문서 액션 */}
            <section style={{ ...whiteCard, marginBottom: 18 }}>
              <div
                style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
              >
                <button
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  style={docButtonStyle(COLORS.navy, !canGenerate)}
                >
                  📄 문서 생성
                </button>
                <button
                  onClick={handleDownloadTxt}
                  disabled={!documentGenerated}
                  style={docButtonStyle(COLORS.slate, !documentGenerated)}
                >
                  TXT 다운로드
                </button>
                <button
                  onClick={handleDownloadHtml}
                  disabled={!documentGenerated}
                  style={docButtonStyle(COLORS.slate, !documentGenerated)}
                >
                  HTML 다운로드
                </button>
                <button
                  onClick={handlePrint}
                  disabled={!documentGenerated}
                  style={docButtonStyle(COLORS.amber, !documentGenerated)}
                >
                  🖨 인쇄하기
                </button>
              </div>
              {activeSource && (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 12.5,
                    color: COLORS.inkMuted,
                  }}
                >
                  선택된 기록:{" "}
                  <strong style={{ color: COLORS.ink }}>
                    {activeSource.kind === "upload"
                      ? `📁 업로드 · ${
                          activeSource.record.fileName || "(미상 파일)"
                        }`
                      : `🎙 실시간 통화 · ${formatTimestamp(
                          new Date(activeSource.createdAt)
                        )}`}
                  </strong>
                </div>
              )}
            </section>

            {/* 문서 본문 */}
            {!documentGenerated ? (
              <section
                style={{
                  ...whiteCard,
                  borderStyle: "dashed",
                  textAlign: "center",
                  color: COLORS.inkMuted,
                  lineHeight: 1.9,
                  padding: 36,
                }}
              >
                {docSource === "upload"
                  ? "업로드 녹취 기반"
                  : "실시간 통역 기반"}{" "}
                문서를 생성할 준비가 되었습니다.
                <br />
                상단의{" "}
                <strong style={{ color: COLORS.ink }}>📄 문서 생성</strong>{" "}
                버튼을 눌러 사건 기록 문서를 생성하세요.
              </section>
            ) : docSource === "upload" ? (
              <UploadDocument
                transcriptionResult={transcriptionResult!}
                extraction={uploadExtraction!}
                selectedFileName={selectedFileName}
                translations={translations}
                translatedText={uploadTranslatedText}
                speakerRoleMap={uploadSpeakerRoleMap}
                generatedAt={generatedAt}
                notes={notes}
                setNotes={setNotes}
              />
            ) : (
              <RealtimeDocument
                rows={realtimeRows}
                extraction={realtimeExtraction}
                latency={realtimeLatency}
                generatedAt={generatedAt}
                rtStart={rtStart}
                rtEnd={realtimeSessionEnd}
                elapsedSec={rtElapsedSec}
                callerLang={callerLang}
                operatorLang={operatorLang}
                secondaryCallerLangs={secondaryCallerLangs}
                unclassifiedRows={unclassifiedRows}
                speakerCounts={speakerCounts}
                statusCounts={statusCounts}
                meta={realtimeMeta}
                diarizationSummary={diarizationSummary}
                notes={notes}
                setNotes={setNotes}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ---------- HTML 문서 공통 래퍼 ----------

function wrapHtmlDocument(
  title: string,
  badge: string,
  body: string
): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", Arial, sans-serif; color: #1f2a37; background: #fff; padding: 28px; max-width: 880px; margin: 0 auto; }
  h1 { text-align: center; font-size: 22px; margin: 0 0 4px; letter-spacing: -0.3px; }
  .subtitle { text-align: center; color: #555; font-size: 13px; margin-bottom: 6px; }
  .badge { display: block; text-align: center; margin: 0 auto 22px; width: fit-content; background: #d92d20; color: #fff; font-size: 12px; font-weight: 700; padding: 3px 12px; border-radius: 999px; }
  h2 { font-size: 15px; border-bottom: 2px solid #d92d20; padding: 6px 0; margin-top: 26px; }
  table.meta-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.meta-table td { border: 1px solid #999; padding: 6px 10px; font-size: 14px; }
  table.meta-table td.k { background: #f3f4f6; width: 160px; font-weight: 700; }
  .section { margin-top: 8px; font-size: 14px; line-height: 1.6; }
  ul { margin: 6px 0 12px 18px; padding: 0; }
  li { margin: 2px 0; }
  .empty { color: #888; font-style: italic; padding: 4px 0; font-size: 13px; }
  .segment { padding: 9px 0; border-bottom: 1px dashed #ccc; }
  .segment .meta { font-size: 12px; color: #555; }
  .segment .text { margin-top: 4px; }
  .segment .translation { margin-top: 4px; color: #143a6b; }
  .tag { display: inline-block; background: #516175; color: #fff; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-right: 4px; }
  .full-text { white-space: pre-wrap; line-height: 1.7; font-size: 14px; border: 1px solid #ccc; padding: 12px; border-radius: 4px; background: #fafafa; }
  .notes { white-space: pre-wrap; line-height: 1.7; padding: 8px; border: 1px solid #ccc; border-radius: 4px; background: #fafafa; }
  .kw-list { padding: 6px 0; }
  .kw { display: inline-block; padding: 2px 8px; margin: 2px; background: #fee2e2; color: #991b1b; border-radius: 4px; font-size: 13px; font-weight: 700; }
  .footer { margin-top: 30px; text-align: right; font-size: 11px; color: #888; }
  @media print {
    body { padding: 12mm; }
    .kw { background: transparent; border: 1px solid #991b1b; }
  }
</style>
</head>
<body>
  <h1>119 긴급구조표준시스템 사건 기록 문서</h1>
  <div class="subtitle">긴급구조 현장 통역 결과 정리 보고서</div>
  <span class="badge">${escapeHtml(badge)}</span>
${body}
  <div class="footer">본 문서는 119 긴급구조표준시스템에서 자동 생성되었습니다.</div>
</body>
</html>`;
}

function notesHtmlBlock(notes: string): string {
  return notes.trim().length === 0
    ? `<div class="empty">(없음)</div>`
    : `<div class="notes">${escapeHtml(notes).replace(/\n/g, "<br>")}</div>`;
}

// ---------- 업로드 기반 화면 문서 ----------

function UploadDocument({
  transcriptionResult,
  extraction,
  selectedFileName,
  translations,
  translatedText,
  speakerRoleMap,
  generatedAt,
  notes,
  setNotes,
}: {
  transcriptionResult: NonNullable<
    ReturnType<typeof useAppData>["transcriptionResult"]
  >;
  extraction: Extraction;
  selectedFileName: string;
  translations: Record<number, string>;
  translatedText: string;
  speakerRoleMap: Map<string, "caller" | "operator" | "unknown">;
  generatedAt: Date | null;
  notes: string;
  setNotes: (v: string) => void;
}) {
  const lat = transcriptionResult.latency ?? {};
  const errs = transcriptionResult.errors ?? [];
  const modeLabel =
    transcriptionResult.mode === "diarization"
      ? "화자분리 자동 분석"
      : "일반";

  return (
    <DocumentPaper badge="업로드 녹취 자동 분석 기반">
      <SectionTitle>1. 사건 개요</SectionTitle>
      <table style={metaTableStyle}>
        <tbody>
          <MetaRow k="문서 종류" v="업로드 음성파일 자동 분석 기록" />
          <MetaRow k="파일명" v={selectedFileName || "(미상)"} />
          <MetaRow
            k="처리 일시"
            v={generatedAt ? formatTimestamp(generatedAt) : "-"}
          />
          <MetaRow
            k="전체 통화 시간"
            v={formatDuration(transcriptionResult.duration)}
          />
          <MetaRow
            k="처리 소요 시간"
            v={
              transcriptionResult.processing_time !== undefined
                ? `${transcriptionResult.processing_time.toFixed(2)}s`
                : "-"
            }
          />
          <MetaRow k="처리 모드" v={modeLabel} />
          <MetaRow
            k="감지된 신고자 언어"
            v={langName(transcriptionResult.caller_language)}
          />
          <MetaRow k="구급대원 언어" v="한국어 (고정)" />
          <MetaRow
            k="총 발화 segment 수"
            v={`${transcriptionResult.segments.length}건`}
          />
        </tbody>
      </table>

      <SectionTitle>2. 전체 대화 원문</SectionTitle>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          fontFamily: "inherit",
          lineHeight: 1.7,
          border: "1px solid #cbd5e1",
          background: "#fafafa",
          padding: 12,
          borderRadius: 4,
          fontSize: 14,
          color: COLORS.ink,
        }}
      >
        {transcriptionResult.text || "(원문 없음)"}
      </pre>

      <SectionTitle>3. 한국어/통역 번역문</SectionTitle>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          fontFamily: "inherit",
          lineHeight: 1.7,
          border: "1px solid #fde68a",
          background: "#fffbeb",
          padding: 12,
          borderRadius: 4,
          fontSize: 15,
          color: COLORS.ink,
          fontWeight: 500,
        }}
      >
        {translatedText || "(번역 결과 없음)"}
      </pre>

      <SectionTitle>4. 화자별 발화 기록</SectionTitle>
      {transcriptionResult.segments.length === 0 ? (
        <div style={emptyTextStyle}>화자별 구간이 없습니다.</div>
      ) : (
        <div>
          {transcriptionResult.segments.map((seg, i) => {
            const role =
              seg.role ?? speakerRoleMap.get(seg.speaker) ?? "unknown";
            const accent =
              role === "caller"
                ? COLORS.caller
                : role === "operator"
                ? COLORS.operator
                : role === "interpreter"
                ? COLORS.violet
                : COLORS.slate;
            const roleLabel =
              role === "caller"
                ? "신고자"
                : role === "operator"
                ? "구급대원"
                : role === "interpreter"
                ? "통역사"
                : "판단 불가";
            const tr = seg.translated || translations[i] || "";
            return (
              <div
                key={i}
                style={{
                  padding: "10px 0",
                  borderBottom: "1px dashed #cbd5e1",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "#475569",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span>
                    [{formatDuration(seg.start)} ~ {formatDuration(seg.end)}]
                  </span>
                  <strong style={{ color: accent }}>
                    {seg.speaker || "화자 ?"}
                  </strong>
                  <span
                    style={{
                      padding: "1px 7px",
                      borderRadius: 999,
                      backgroundColor: accent,
                      color: "#fff",
                      fontWeight: 700,
                      fontSize: 11,
                    }}
                  >
                    {roleLabel}
                  </span>
                  {(seg.source_language || seg.target_language) && (
                    <span style={{ color: "#475569" }}>
                      {langName(seg.source_language)} →{" "}
                      {langName(seg.target_language)}
                    </span>
                  )}
                </div>
                <div style={{ marginTop: 5, lineHeight: 1.6 }}>
                  <span style={docTagStyle(COLORS.slate)}>원문</span> {seg.text}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    lineHeight: 1.6,
                    color: COLORS.navyDark,
                    fontWeight: 600,
                  }}
                >
                  <span style={docTagStyle(accent)}>통역</span>{" "}
                  {tr || "(통역 결과 없음)"}
                </div>
                {seg.role_reason && !seg.error && (
                  <div
                    style={{
                      marginTop: 3,
                      fontSize: 11.5,
                      color: "#64748b",
                      fontStyle: "italic",
                    }}
                  >
                    근거: {seg.role_reason}
                  </div>
                )}
                {seg.error && (
                  <div
                    style={{
                      marginTop: 4,
                      padding: "4px 8px",
                      backgroundColor: "#fdeceb",
                      border: "1px solid #fca5a5",
                      borderRadius: 4,
                      fontSize: 12,
                      color: "#b21e13",
                    }}
                  >
                    ⚠ 오류: {seg.error}
                    {seg.reason && (
                      <span style={{ marginLeft: 6, color: "#64748b" }}>
                        ({seg.reason})
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <SectionTitle>5. 주요 위치 / 증상 / 요청사항 자동 추출</SectionTitle>
      <ExtractionBlock extraction={extraction} />

      <SectionTitle>6. 처리 지연 / 품질 정보</SectionTitle>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 10,
        }}
      >
        <LatencyCell label="STT (음성인식)" value={msText(lat.stt_ms)} />
        <LatencyCell label="번역" value={msText(lat.translate_ms)} />
        <LatencyCell label="TTS (음성합성)" value={msText(lat.tts_ms)} />
        <LatencyCell label="총 처리 시간" value={msText(lat.total_ms)} />
      </div>

      <SectionTitle>7. 오류 로그</SectionTitle>
      {errs.length === 0 ? (
        <div style={emptyTextStyle}>(오류 없음)</div>
      ) : (
        <ul style={{ margin: "4px 0 10px 18px", padding: 0 }}>
          {errs.map((e, i) => (
            <li
              key={i}
              style={{
                margin: "2px 0",
                lineHeight: 1.6,
                color: COLORS.redDark,
              }}
            >
              {e}
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>8. 특이사항 / 비고</SectionTitle>
      <NotesArea notes={notes} setNotes={setNotes} />

      <DocumentFooter />
    </DocumentPaper>
  );
}

// ---------- 실시간 통역 기반 화면 문서 ----------

function RealtimeDocument({
  rows,
  extraction,
  latency,
  generatedAt,
  rtStart,
  rtEnd,
  elapsedSec,
  callerLang,
  operatorLang,
  secondaryCallerLangs,
  unclassifiedRows,
  speakerCounts,
  statusCounts,
  meta,
  diarizationSummary,
  notes,
  setNotes,
}: {
  rows: RealtimeMessage[];
  extraction: Extraction | null;
  latency: RealtimeLatency;
  generatedAt: Date | null;
  rtStart: number | null;
  rtEnd: number | null;
  elapsedSec: number | undefined;
  callerLang: string;
  operatorLang: string;
  secondaryCallerLangs: string[];
  unclassifiedRows: RealtimeMessage[];
  speakerCounts: {
    caller: number;
    operator: number;
    interpreter: number;
    unknown: number;
  };
  statusCounts: { success: number; error: number; other: number };
  meta: RealtimeMeta;
  diarizationSummary: {
    chunksWithSegments: number;
    totalSegments: number;
    translatedSegments: number;
    erroredSegments: number;
    ranked: [string, number][];
    chunksWithSegmentData: Array<{
      id: number;
      timestamp: number;
      speakerLabel: string;
      segments: DiarizationSegment[];
    }>;
  };
  notes: string;
  setNotes: (v: string) => void;
}) {
  return (
    <DocumentPaper badge="실시간 통역 기반">
      <SectionTitle>1. 기본 정보</SectionTitle>
      <table style={metaTableStyle}>
        <tbody>
          <MetaRow k="문서 종류" v="실시간 통역 세션 기록" />
          <MetaRow
            k="처리 일시"
            v={generatedAt ? formatTimestamp(generatedAt) : "-"}
          />
          <MetaRow
            k="세션 시작"
            v={rtStart != null ? formatTimestamp(new Date(rtStart)) : "-"}
          />
          <MetaRow
            k="세션 종료"
            v={
              rtEnd != null
                ? formatTimestamp(new Date(rtEnd))
                : "(미종료 / 진행 중)"
            }
          />
          <MetaRow k="전체 진행 시간" v={formatDuration(elapsedSec)} />
          <MetaRow k="대화 건수" v={`${rows.length}건`} />
          <MetaRow
            k="VAD 프리셋"
            v={meta.vadPresetLabel ?? "(기록 없음)"}
          />
          <MetaRow
            k="처리 결과"
            v={`성공 ${statusCounts.success} · 오류 ${statusCounts.error} · 폐기 ${
              meta.discardedCount ?? 0
            } · 중복 제거 ${meta.duplicateCount ?? 0}`}
          />
        </tbody>
      </table>

      <SectionTitle>2. 참여자 및 사용 언어</SectionTitle>
      <table style={metaTableStyle}>
        <tbody>
          <MetaRow k="신고자" v={langName(callerLang)} />
          <MetaRow k="구급대원" v={langName(operatorLang)} />
          <MetaRow k="감지된 신고자 언어 (1차)" v={langName(callerLang)} />
          <MetaRow
            k="추가 감지 외국어"
            v={
              secondaryCallerLangs.length === 0
                ? "(없음)"
                : secondaryCallerLangs.map((l) => langName(l)).join(", ")
            }
          />
          <MetaRow
            k="자동 역할 판단"
            v={`신고자 ${speakerCounts.caller} · 구급대원 ${speakerCounts.operator} · 통역사 ${speakerCounts.interpreter} · 판단 불가 ${speakerCounts.unknown}`}
          />
        </tbody>
      </table>

      <SectionTitle>3. 주요 내용 자동 정리</SectionTitle>
      {extraction ? (
        <ExtractionBlock extraction={extraction} />
      ) : (
        <div style={emptyTextStyle}>분석할 대화 내용이 없습니다.</div>
      )}

      <SectionTitle>4. 처리 지연 요약</SectionTitle>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 10,
        }}
      >
        <LatencyCell label="평균 음성인식 (STT)" value={msText(latency.sttAvg)} />
        <LatencyCell label="평균 번역" value={msText(latency.trAvg)} />
        <LatencyCell label="평균 음성합성 (TTS)" value={msText(latency.ttsAvg)} />
        <LatencyCell label="평균 응답지연 (E2E)" value={msText(latency.e2eAvg)} />
      </div>

      <SectionTitle>5. 전체 대화 기록</SectionTitle>
      {rows.length === 0 ? (
        <div style={emptyTextStyle}>기록된 대화가 없습니다.</div>
      ) : (
        <div>
          {rows.map((m) => {
            const accent =
              m.speaker === "caller"
                ? COLORS.caller
                : m.speaker === "operator"
                ? COLORS.operator
                : m.speaker === "interpreter"
                ? COLORS.violet
                : COLORS.slate;
            return (
              <div
                key={m.id}
                style={{
                  padding: "10px 0",
                  borderBottom: "1px dashed #cbd5e1",
                }}
              >
                <div style={{ fontSize: 12, color: "#475569" }}>
                  [{formatClock(m.timestamp)}]{" "}
                  <strong style={{ color: accent }}>{m.speakerLabel}</strong>{" "}
                  · {langName(m.sourceLanguage)} → {langName(m.targetLanguage)}
                </div>
                {(m.speakerConfidence !== undefined || m.speakerReason) && (
                  <div style={{ marginTop: 3, fontSize: 11.5, color: "#64748b" }}>
                    자동 판단: <strong>{m.speakerLabel}</strong>
                    {m.speakerConfidence !== undefined && (
                      <>
                        {" "}· 신뢰도 {confidenceText(m.speakerConfidence)} (
                        {Math.round(m.speakerConfidence * 100)}%)
                      </>
                    )}
                    {m.speakerReason && <> · 근거: {m.speakerReason}</>}
                  </div>
                )}
                <div style={{ marginTop: 5, lineHeight: 1.6 }}>
                  <span style={docTagStyle(COLORS.slate)}>원문</span>{" "}
                  {m.original}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    lineHeight: 1.6,
                    color: COLORS.navyDark,
                    fontWeight: 600,
                  }}
                >
                  <span style={docTagStyle(accent)}>통역</span>{" "}
                  {m.translated || "(통역 결과 없음)"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <SectionTitle>6. 판단 불가 발화 목록</SectionTitle>
      {unclassifiedRows.length === 0 ? (
        <div style={emptyTextStyle}>판단 불가 발화가 없습니다.</div>
      ) : (
        <div>
          {unclassifiedRows.map((m) => (
            <div
              key={m.id}
              style={{
                padding: "8px 0",
                borderBottom: "1px dashed #cbd5e1",
                fontSize: 13,
                color: COLORS.ink,
              }}
            >
              <div style={{ fontSize: 12, color: "#475569" }}>
                [{formatClock(m.timestamp)}] · {langName(m.sourceLanguage)}
                {m.speakerReason ? ` · ${m.speakerReason}` : ""}
              </div>
              <div style={{ marginTop: 3 }}>{m.original}</div>
            </div>
          ))}
        </div>
      )}

      <SectionTitle>7. 서버 화자분리 (실험) 결과</SectionTitle>
      {!meta.diarizationEnabled &&
      diarizationSummary.chunksWithSegments === 0 ? (
        <div style={emptyTextStyle}>
          이 세션에서는 서버 화자분리 실험 모드를 사용하지 않았습니다.
        </div>
      ) : diarizationSummary.chunksWithSegments === 0 ? (
        <div style={emptyTextStyle}>
          화자분리 실험 모드가 켜져 있었으나 segment가 수신되지 않았습니다.
        </div>
      ) : (
        <>
          <table style={metaTableStyle}>
            <tbody>
              <MetaRow
                k="실험 모드"
                v={meta.diarizationEnabled ? "활성" : "비활성"}
              />
              <MetaRow
                k="segment 보유 chunk"
                v={`${diarizationSummary.chunksWithSegments}건`}
              />
              <MetaRow
                k="총 segment 수"
                v={`${diarizationSummary.totalSegments}건`}
              />
              <MetaRow
                k="번역 완료 segment"
                v={`${diarizationSummary.translatedSegments}건`}
              />
              <MetaRow
                k="번역 실패 segment"
                v={`${diarizationSummary.erroredSegments}건`}
              />
              <MetaRow
                k="서버 화자별 누적 시간"
                v={
                  diarizationSummary.ranked.length === 0
                    ? "(없음)"
                    : diarizationSummary.ranked
                        .map(
                          ([sp, dur]) =>
                            `${sp}: ${dur.toFixed(2)}s`
                        )
                        .join(" · ")
                }
              />
              <tr>
                <td
                  colSpan={2}
                  style={{
                    fontSize: 11.5,
                    color: "#9a3412",
                    fontStyle: "italic",
                    paddingTop: 6,
                  }}
                >
                  ⚠ chunk 단위 STT 응답이므로 화자 라벨(SPK_x)이 chunk 간 같은
                  인물을 가리킨다는 보장은 없습니다. 자동 역할 판단(섹션 5)을
                  기준으로 해석하세요.
                </td>
              </tr>
            </tbody>
          </table>

          {/* chunk 별 segment 상세 — diarization mode 응답에 role / translated 등
              enrichment 가 들어 있으면 segment 별로 원문 + 번역을 함께 보여준다. */}
          <div style={{ marginTop: 12 }}>
            {diarizationSummary.chunksWithSegmentData.map((c) => (
              <div
                key={c.id}
                style={{
                  marginBottom: 14,
                  padding: "10px 12px",
                  backgroundColor: "#fff7ed",
                  border: "1px solid #fde68a",
                  borderRadius: 8,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "#9a3412",
                    fontWeight: 700,
                    marginBottom: 8,
                  }}
                >
                  chunk #{c.id} · [{formatClock(c.timestamp)}] ·{" "}
                  {c.speakerLabel} · {c.segments.length}개 segment
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {c.segments.map((s, i) => (
                    <DocSegmentRow key={i} seg={s} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <SectionTitle>8. 특이사항 / 비고</SectionTitle>
      <NotesArea notes={notes} setNotes={setNotes} />

      <DocumentFooter />
    </DocumentPaper>
  );
}

// ---------- 공통 보조 컴포넌트 ----------

function DocumentPaper({
  badge,
  children,
}: {
  badge: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        backgroundColor: "#ffffff",
        color: COLORS.ink,
        borderRadius: 6,
        border: "1px solid #cbd5e1",
        boxShadow: "0 10px 32px rgba(5, 18, 40, 0.4)",
        maxWidth: 840,
        margin: "0 auto",
        padding: "32px 36px",
      }}
    >
      <h2
        style={{ textAlign: "center", fontSize: 22, margin: "0 0 4px" }}
      >
        119 긴급구조표준시스템 사건 기록 문서
      </h2>
      <p
        style={{
          textAlign: "center",
          color: "#475569",
          fontSize: 13,
          margin: "0 0 8px",
        }}
      >
        긴급구조 현장 통역 결과 정리 보고서
      </p>
      <div style={{ textAlign: "center", marginBottom: 18 }}>
        <span
          style={{
            display: "inline-block",
            backgroundColor: COLORS.red,
            color: "#fff",
            fontSize: 12,
            fontWeight: 700,
            padding: "3px 12px",
            borderRadius: 999,
          }}
        >
          {badge}
        </span>
      </div>
      {children}
    </section>
  );
}

function DocumentFooter() {
  return (
    <div
      style={{
        marginTop: 24,
        textAlign: "right",
        fontSize: 11,
        color: "#64748b",
      }}
    >
      본 문서는 119 긴급구조표준시스템에서 자동 생성되었습니다.
    </div>
  );
}

function ExtractionBlock({ extraction }: { extraction: Extraction }) {
  return (
    <div style={{ fontSize: 14 }}>
      <ExtractionGroup
        label="위치 관련"
        items={extraction.locations}
        emptyText="감지된 위치 표현 없음"
      />
      <ExtractionGroup
        label="환자 상태 관련"
        items={extraction.patientStateSentences}
        emptyText="감지된 표현 없음"
      />
      <ExtractionGroup
        label="요청 내용"
        items={extraction.requestSentences}
        emptyText="감지된 요청 표현 없음"
      />
      <div style={{ marginTop: 10 }}>
        <strong>· 긴급 키워드</strong>
        {extraction.emergencyKeywords.length === 0 ? (
          <div style={emptyTextStyle}>감지된 키워드 없음</div>
        ) : (
          <div style={{ marginTop: 6 }}>
            {extraction.emergencyKeywords.map((k) => (
              <span key={k} style={kwBadgeStyle}>
                {k}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NotesArea({
  notes,
  setNotes,
}: {
  notes: string;
  setNotes: (v: string) => void;
}) {
  return (
    <textarea
      value={notes}
      onChange={(e) => setNotes(e.target.value)}
      placeholder="현장 추가 메모, 신고자 인적사항, 후속 조치 등을 기록하세요."
      style={{
        width: "100%",
        minHeight: 100,
        border: "1px solid #cbd5e1",
        borderRadius: 4,
        padding: 10,
        fontSize: 14,
        fontFamily: "inherit",
        background: "#fff",
        color: COLORS.ink,
        resize: "vertical",
      }}
    />
  );
}

function LatencyCell({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        border: "1px solid #cbd5e1",
        borderTop: `3px solid ${COLORS.navy}`,
        borderRadius: 6,
        padding: "10px 12px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 12, color: "#475569" }}>{label}</div>
      <div
        style={{
          marginTop: 5,
          fontSize: 18,
          fontWeight: 800,
          color: COLORS.navyDark,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// 사람이 읽기 쉬운 한국어 일시 (예: "2026년 5월 27일 오후 2시 38분").
function formatHumanDateKo(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const h24 = d.getHours();
  const min = d.getMinutes();
  const ampm = h24 < 12 ? "오전" : "오후";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${y}년 ${mo}월 ${day}일 ${ampm} ${h12}시 ${String(min).padStart(2, "0")}분`;
}

// 업로드/실시간 record 를 동일한 카드 형태로 표시. 클릭 시 active 가 된다.
// active 일 때는 두꺼운 navy 테두리 + 좌측 색대로 강조.
function SourceCard({
  item,
  active,
  onSelect,
  onRemove,
}: {
  item: SourceItem;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const isUpload = item.kind === "upload";
  const accent = isUpload ? COLORS.navy : COLORS.operator;
  const typeLabel = isUpload ? "📁 업로드 녹취록" : "🎙 실시간 통화";
  const typeBadge = isUpload ? COLORS.navy : COLORS.operator;

  // 카드별 메타 — 일시 / 제목 / 발화 수 / 감지된 신고자 언어 / 처리 상태
  let title: string;
  let segCountLabel: string;
  let callerLang: string;
  let statusLabel: string;
  let statusColor: string;

  if (item.kind === "upload") {
    const r = item.record;
    title = r.fileName || "(미상 파일)";
    segCountLabel = `${r.result.segments.length}개 segment`;
    callerLang = langName(r.result.caller_language) || "감지 정보 없음";
    const errCount = r.result.errors?.length ?? 0;
    if (errCount > 0) {
      statusLabel = `⚠ 오류 ${errCount}건`;
      statusColor = COLORS.red;
    } else if (r.result.status === "ok" || r.result.status === undefined) {
      statusLabel = "✅ 자동 분석 완료";
      statusColor = COLORS.green;
    } else {
      statusLabel = `상태: ${r.result.status}`;
      statusColor = COLORS.amber;
    }
  } else {
    const r = item.record;
    title = `실시간 통화 세션`;
    const msgs = r.messages.filter((m) => m.original.trim().length > 0);
    segCountLabel = `${msgs.length}개 발화 · 전체 chunk ${r.messages.length}`;
    // 발화 메시지에서 신고자 언어 1차를 추출.
    const detected =
      r.messages.find(
        (m) =>
          m.detectedCallerLanguage &&
          m.detectedCallerLanguage !== "auto" &&
          m.detectedCallerLanguage !== "unknown"
      )?.detectedCallerLanguage ??
      r.messages.find(
        (m) =>
          m.speaker === "caller" &&
          m.sourceLanguage &&
          m.sourceLanguage !== "auto" &&
          m.sourceLanguage !== "unknown"
      )?.sourceLanguage;
    callerLang = detected ? langName(detected) : "감지 정보 없음";
    const errors = r.messages.filter((m) => m.status === "error").length;
    if (r.endedAt == null) {
      statusLabel = "🟠 진행 중 / 미종료";
      statusColor = COLORS.amber;
    } else if (errors > 0) {
      statusLabel = `⚠ 오류 ${errors}건`;
      statusColor = COLORS.red;
    } else if (msgs.length === 0) {
      statusLabel = "(인식된 발화 없음)";
      statusColor = COLORS.slate;
    } else {
      statusLabel = "✅ 통역 완료";
      statusColor = COLORS.green;
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        textAlign: "left",
        padding: "14px 16px",
        borderRadius: 10,
        border: `2px solid ${active ? accent : COLORS.cardBorder}`,
        borderLeft: `8px solid ${accent}`,
        backgroundColor: active ? "#f0f5fc" : "#ffffff",
        cursor: "pointer",
        boxShadow: active ? `0 0 0 3px ${accent}33` : undefined,
        transition: "background-color 80ms",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            padding: "3px 9px",
            borderRadius: 999,
            backgroundColor: typeBadge,
            color: "#fff",
            fontSize: 11.5,
            fontWeight: 800,
          }}
        >
          {typeLabel}
        </span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: COLORS.inkSoft,
          }}
        >
          {formatHumanDateKo(item.createdAt)}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11.5,
            fontWeight: 700,
            color: statusColor,
            padding: "2px 8px",
            borderRadius: 999,
            backgroundColor: `${statusColor}1a`,
          }}
        >
          {statusLabel}
        </span>
      </div>

      <div
        style={{
          fontSize: 16,
          fontWeight: 800,
          color: active ? COLORS.navyDark : COLORS.ink,
          wordBreak: "break-word",
        }}
      >
        {title}
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          fontSize: 12.5,
          color: COLORS.inkMuted,
        }}
      >
        <span>
          신고자 언어:{" "}
          <strong style={{ color: COLORS.ink }}>{callerLang}</strong>
        </span>
        <span>
          <strong style={{ color: COLORS.ink }}>{segCountLabel}</strong>
        </span>
        <span style={{ marginLeft: "auto" }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: `1px solid ${COLORS.red}55`,
              backgroundColor: "transparent",
              color: COLORS.red,
              fontSize: 11.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
            title="이 기록을 삭제"
          >
            🗑 삭제
          </button>
        </span>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: 15,
        borderBottom: `2px solid ${COLORS.red}`,
        padding: "6px 0",
        marginTop: 22,
        marginBottom: 8,
        color: COLORS.ink,
      }}
    >
      {children}
    </h3>
  );
}

function MetaRow({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td
        style={{
          border: "1px solid #94a3b8",
          padding: "6px 10px",
          backgroundColor: "#e2e8f0",
          fontWeight: 700,
          width: 170,
        }}
      >
        {k}
      </td>
      <td style={{ border: "1px solid #94a3b8", padding: "6px 10px" }}>{v}</td>
    </tr>
  );
}

// 결과 문서에서 segment 한 건을 카드로 표시. 역할별 색상 + src→tgt + 원문/통역/오류.
function DocSegmentRow({ seg }: { seg: DiarizationSegment }) {
  const role = seg.role ?? "unknown";
  const accent =
    role === "caller"
      ? COLORS.caller
      : role === "operator"
      ? COLORS.operator
      : role === "interpreter"
      ? COLORS.violet
      : COLORS.slate;
  const roleLabel =
    role === "caller"
      ? "신고자"
      : role === "operator"
      ? "구급대원"
      : role === "interpreter"
      ? "통역사"
      : "판단 불가";
  const src = seg.source_language;
  const tgt = seg.target_language;
  return (
    <div
      style={{
        padding: "8px 10px",
        backgroundColor: "#ffffff",
        borderLeft: `4px solid ${accent}`,
        border: "1px solid #fde68a",
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
          fontSize: 11.5,
          marginBottom: 5,
        }}
      >
        <span
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            color: "#64748b",
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
          }}
        >
          {seg.speaker || "SPK_?"}
        </span>
        <span
          style={{
            padding: "1px 7px",
            borderRadius: 999,
            backgroundColor: accent,
            color: "#fff",
            fontWeight: 700,
          }}
        >
          {roleLabel}
        </span>
        {seg.role_confidence !== undefined && (
          <span style={{ color: "#64748b" }}>
            신뢰도 {Math.round(seg.role_confidence * 100)}%
          </span>
        )}
        {(src || tgt) && (
          <span
            style={{
              padding: "1px 7px",
              borderRadius: 999,
              border: "1px solid #cbd5e1",
              color: "#475569",
              fontWeight: 600,
            }}
          >
            {langName(src)} → {langName(tgt)}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.55,
          color: COLORS.ink,
          wordBreak: "break-word",
        }}
      >
        <span style={docTagStyle(COLORS.slate)}>원문</span> {seg.text}
      </div>
      {seg.translated && (
        <div
          style={{
            marginTop: 4,
            padding: "4px 8px",
            backgroundColor: "#fffbeb",
            borderLeft: `3px solid ${accent}`,
            fontSize: 13,
            lineHeight: 1.55,
            fontWeight: 600,
            color: COLORS.ink,
            wordBreak: "break-word",
          }}
        >
          <span style={docTagStyle(accent)}>통역</span> {seg.translated}
        </div>
      )}
      {seg.role_reason && !seg.error && (
        <div
          style={{
            marginTop: 3,
            fontSize: 11,
            color: "#64748b",
            fontStyle: "italic",
          }}
        >
          근거: {seg.role_reason}
        </div>
      )}
      {seg.error && (
        <div
          style={{
            marginTop: 4,
            padding: "4px 8px",
            backgroundColor: "#fdeceb",
            border: "1px solid #fca5a5",
            borderRadius: 4,
            fontSize: 12,
            color: "#b21e13",
            wordBreak: "break-word",
          }}
        >
          ⚠ 오류: {seg.error}
          {seg.reason && (
            <span style={{ marginLeft: 6, color: "#64748b" }}>
              ({seg.reason})
            </span>
          )}
        </div>
      )}
      {!seg.error && seg.reason && (
        <div
          style={{
            marginTop: 3,
            fontSize: 11,
            color: "#64748b",
            fontStyle: "italic",
          }}
        >
          사유: {seg.reason}
        </div>
      )}
    </div>
  );
}

function ExtractionGroup({
  label,
  items,
  emptyText,
}: {
  label: string;
  items: string[];
  emptyText: string;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <strong>· {label}</strong>
      {items.length === 0 ? (
        <div style={emptyTextStyle}>{emptyText}</div>
      ) : (
        <ul style={{ margin: "4px 0 10px 18px", padding: 0 }}>
          {items.map((v, i) => (
            <li key={i} style={{ margin: "2px 0", lineHeight: 1.6 }}>
              {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- 스타일 ----------

function docButtonStyle(
  color: string,
  disabled: boolean
): React.CSSProperties {
  return {
    padding: "12px 20px",
    borderRadius: 10,
    border: "none",
    backgroundColor: color,
    color: "#ffffff",
    fontWeight: 800,
    fontSize: 15,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function docTagStyle(color: string): React.CSSProperties {
  return {
    display: "inline-block",
    backgroundColor: color,
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
    padding: "1px 7px",
    borderRadius: 4,
    marginRight: 4,
  };
}

const metaTableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  marginTop: 4,
  fontSize: 14,
  color: COLORS.ink,
};

const emptyTextStyle: React.CSSProperties = {
  color: "#64748b",
  fontStyle: "italic",
  padding: "4px 0",
  fontSize: 13,
};

const kwBadgeStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  margin: 3,
  backgroundColor: "#fee2e2",
  color: "#991b1b",
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 700,
};

export default ResultPage;
