"""
119 실시간 통번역 전용 라우터 (서버 중심 구조).

마운트 위치: /app/backend/open_webui/routers/ems_realtime.py
prefix     : /api/119/realtime

설계 원칙
---------
- OpenWebUI 핵심 API(audio.py 등)를 절대 건드리지 않는다.
- 외부 STT/LLM/TTS 호출은 모두 try/except로 감싸 OWI 프로세스가 죽지 않게 한다.
- 컨텐츠 레벨 실패(짧은 오디오/무음/환각/번역 실패)는 HTTP 4xx/5xx로 올리지 않고
  JSON envelope의 status="skipped"|"error" 로 돌려준다.
- 세션 상태(primary/latest caller 언어, 최근 텍스트)는 프로세스 메모리에 보관한다.
  컨테이너 재시작 시 휘발되지만 현 단계 요구사항으로 충분.
- 외부 호출 URL/모델은 모두 환경변수로 override 가능.

엔드포인트
----------
POST /api/119/realtime/process          (multipart/form-data)
GET  /api/119/realtime/health
POST /api/119/realtime/session/{sid}/reset
"""

from __future__ import annotations

import base64
import logging
import os
import re
import tempfile
import time
from collections import deque
from typing import Optional

import httpx
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

log = logging.getLogger("ems_realtime")
log.setLevel(logging.INFO)

router = APIRouter(prefix="/api/119/realtime", tags=["ems-realtime"])


# ============================================================================
# Configuration (env-overridable)
# ============================================================================
# 기본값은 프론트 vite proxy가 사용 중인 게이트웨이와 동일.
# OWI 내부 라우터(/api/v1/audio/*)를 호출하지 않는다 — 자기 자신을 재귀 호출하는
# 위험을 피하기 위해 외부 게이트웨이로 직접 나간다.

STT_URL = os.getenv(
    "EMS_STT_URL",
    "https://ai.jb.go.kr/stt/v1/audio/transcriptions",
)
STT_MODEL = os.getenv("EMS_STT_MODEL", "cohere-transcribe")

DIARIZE_URL = os.getenv(
    "EMS_DIARIZE_URL",
    # 운영팀(주무관) 안내 — nginx 경유. direct IP (예: 192.168.0.8:30203) 는 사용 금지.
    # m4a 도 그대로 전송 가능하며 file 만 필수, language/model/response_format 은 선택.
    "https://ai.jb.go.kr/diarize/v1/audio/transcriptions",
)

LLM_URL = os.getenv(
    "EMS_LLM_URL",
    # 운영팀(주무관) 안내 — 공용 LLM 게이트웨이(OpenAI-compatible).
    # 인증 불필요. Authorization 헤더는 이 경로에서 의도적으로 미부착 (call_translate 참조).
    "https://ai2.jb.go.kr/llm/v1/chat/completions",
)
# 운영팀 권장 기본 모델은 Qwen3.6-27B. 다른 모델은 env override(EMS_LLM_MODEL=...) 로만 사용.
LLM_MODEL = os.getenv("EMS_LLM_MODEL", "Qwen3.6-27B")

# LLM API key 조회 우선순위:
#   1) EMS_LLM_API_KEY (env)
#   2) JB_LLM_API_KEY  (env)
#   3) OPENAI_API_KEY  (env)
#   4) /tmp/ems_llm_api_key (파일 내용 — 컨테이너 자동 실행 스크립트가 shell env를
#      덮어쓰는 환경 대비 폴백. echo "KEY" > /tmp/ems_llm_api_key 로 주입.)
#
# 절대 코드에 하드코딩하지 않으며, 키 값 자체는 어떤 경우에도 로그에 출력하지 않는다.
# 파일 경로는 EMS_LLM_API_KEY_FILE 환경변수로도 override 가능.

LLM_API_KEY_FILE = os.getenv("EMS_LLM_API_KEY_FILE", "/tmp/ems_llm_api_key")


def _read_key_file(path: str) -> Optional[str]:
    """파일에서 API key를 읽어 strip. 실패 시 조용히 None 반환 (예외 전파 금지)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = f.read().strip()
        return v or None
    except Exception:
        # 파일 없음/권한 없음 등은 정상 fallback 경로 — 의도적으로 무음 처리.
        return None


def _resolve_llm_api_key() -> tuple[Optional[str], Optional[str]]:
    for name in ("EMS_LLM_API_KEY", "JB_LLM_API_KEY", "OPENAI_API_KEY"):
        v = os.getenv(name)
        if v and v.strip():
            return v.strip(), name
    file_key = _read_key_file(LLM_API_KEY_FILE)
    if file_key:
        return file_key, f"file:{LLM_API_KEY_FILE}"
    return None, None


LLM_API_KEY, LLM_API_KEY_SOURCE = _resolve_llm_api_key()

# OWI 본체 chat API는 same-origin/cookie 인증 환경에서도 동작한다.
# 컨테이너 안에서 cookie/세션이 이미 붙는 환경이라면 Bearer 없이도 호출 가능 — 기본값 false.
# 명시적으로 Bearer 토큰을 강제하고 싶으면 EMS_LLM_AUTH_REQUIRED=true 로 켠다.

TTS_URL = os.getenv(
    "EMS_TTS_URL",
    "https://ai.jb.go.kr/tts/v1/audio/speech",
)
TTS_MODEL = os.getenv("EMS_TTS_MODEL", "qwen3-tts")

HTTP_TIMEOUT = float(os.getenv("EMS_HTTP_TIMEOUT", "60"))
# STT는 30~60초 길이의 실전 통화 m4a를 처리할 수 있어야 하므로 일반 timeout보다 넉넉히.
# (게이트웨이 처리 + 큐 대기 합산) — 필요 시 EMS_STT_TIMEOUT으로 override.
STT_TIMEOUT = float(os.getenv("EMS_STT_TIMEOUT", "180"))

# ai2 개발 컨테이너 내부에서 ai.jb.go.kr 호출이 사설 인증서를 거치는 경우가 있어
# SSL 검증을 끄고 호출할 수 있도록 환경변수로 제어한다. 기본값은 "false"(검증 끔).
# 운영 환경에서 정식 인증서가 붙으면 EMS_SSL_VERIFY=true 로 켜는 것을 권장.
def _parse_bool(v: str, default: bool) -> bool:
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on")


SSL_VERIFY: bool = _parse_bool(os.getenv("EMS_SSL_VERIFY", "false"), False)
LLM_AUTH_REQUIRED: bool = _parse_bool(os.getenv("EMS_LLM_AUTH_REQUIRED", "false"), False)

# 부팅 시 한 번 명확히 로그로 흘려 운영자가 보안 상태를 인지할 수 있게 한다.
if SSL_VERIFY:
    log.info("[ems_realtime] SSL_VERIFY=true — 외부 HTTPS 호출 인증서 검증 활성화")
else:
    log.warning(
        "[ems_realtime] SSL_VERIFY=false — 외부 HTTPS 호출 인증서 검증 비활성화 "
        "(개발/사설 인증서 환경 가정). 운영 전환 시 EMS_SSL_VERIFY=true 로 재설정 필요."
    )

# LLM 인증 상태를 부팅 시 1회 노출. key 자체는 로그에 절대 출력하지 않는다.
# 기본 경로(/llm/v1/ 공용 게이트웨이) 는 인증 불필요 — key 가 있어도 헤더는 미부착.
_LLM_PUBLIC_GATEWAY = "/llm/v1/" in LLM_URL
if _LLM_PUBLIC_GATEWAY:
    log.info(
        "[ems_realtime] LLM_AUTH=disabled (public gateway %s — Authorization 미부착)",
        LLM_URL,
    )
elif LLM_API_KEY:
    log.info(
        "[ems_realtime] LLM_AUTH=configured (key source=%s, length=%d, required=%s)",
        LLM_API_KEY_SOURCE, len(LLM_API_KEY), LLM_AUTH_REQUIRED,
    )
elif LLM_AUTH_REQUIRED:
    log.warning(
        "[ems_realtime] LLM_AUTH=missing AND EMS_LLM_AUTH_REQUIRED=true — "
        "EMS_LLM_API_KEY / JB_LLM_API_KEY / OPENAI_API_KEY env 또는 키 파일(%s) "
        "어느 것도 설정되지 않아 번역 호출이 LLMAuthMissing으로 차단됩니다.",
        LLM_API_KEY_FILE,
    )
else:
    log.info(
        "[ems_realtime] LLM_AUTH=optional — Bearer 토큰 없이 호출합니다 "
        "(same-origin/cookie 환경 가정). 필요 시 EMS_LLM_API_KEY 설정 또는 "
        "EMS_LLM_AUTH_REQUIRED=true 로 강제."
    )

# 미리 STT 보내봐야 의미 없는 매우 작은 오디오 컷오프 (대략 64ms WAV PCM16 16kHz mono).
MIN_AUDIO_BYTES = int(os.getenv("EMS_MIN_AUDIO_BYTES", "1024"))

# ---------------- 실시간 normal-mode pending 버퍼 설정 ----------------
# 프론트 VAD 가 너무 빨리 chunk 를 자르면 STT 가 "said it", "out of" 같은 불완전한 영어
# 조각을 돌려준다. 그대로 번역 LLM 으로 보내면 오역이 나오므로, 짧고 불완전한 결과는
# session 단위 pending 버퍼에 텍스트로 누적해두고 다음 chunk 의 STT 결과와 합쳐서
# 다시 판단한다 (Pipecat/LiveKit Agents 스타일의 "context-buffered" 패턴).
#
# 동작 흐름 (normal mode 전용 — diarization 은 절대 사용하지 않는다):
#   1) call_stt 결과 stt_text 가 빈/환각이면 기존과 동일하게 skip (pending 은 보존).
#   2) pending_text 가 있으면 "pending_text + ' ' + stt_text" 를 새 작업 텍스트로 한다.
#   3) is_incomplete_fragment 로 fragment 인지 판정.
#      - fragment 이고 buffer age < EMS_REALTIME_PENDING_MAX_AGE_SEC: pending 유지, 응답은
#        status="skipped" reason="need-more-audio" 로 돌려준다. 프론트는 카드를 만들지
#        않거나 "더 듣는 중" 으로만 표시.
#      - fragment 이지만 buffer 가 너무 오래됨: 확정 처리로 넘어가 그대로 번역.
#      - 확정이면 pending 비우고 일반 흐름으로 진입.
EMS_REALTIME_PENDING_ENABLED: bool = _parse_bool(
    os.getenv("EMS_REALTIME_PENDING_ENABLED", "true"), True
)
# 영어 기준 최소 단어 수 (한국어는 char 단위로 환산). 이보다 적으면 fragment 후보.
EMS_REALTIME_PENDING_MIN_WORDS = int(
    os.getenv("EMS_REALTIME_PENDING_MIN_WORDS", "3")
)
# pending 을 강제 commit 하는 최대 보관 시간 (초). 이걸 넘기면 fragment 라도 그대로 처리.
EMS_REALTIME_PENDING_MAX_AGE_SEC = float(
    os.getenv("EMS_REALTIME_PENDING_MAX_AGE_SEC", "8.0")
)
# pending 으로 합쳐도 너무 길어지지 않게 하는 안전 한도 (문자수). 넘어가면 강제 commit.
EMS_REALTIME_PENDING_MAX_TEXT_CHARS = int(
    os.getenv("EMS_REALTIME_PENDING_MAX_TEXT_CHARS", "400")
)
# Phase B1 — pending 이 fragment 상태로 머물 수 있는 절대 상한 (ms).
# 이 시간을 넘으면 누적된 pending 텍스트를 그대로 commit 해 일반 흐름으로 흘려보낸다.
# (이미 병합되어 누적된 pending 을 flush 하는 것이며, 새 병합 로직은 만들지 않는다.)
# EMS_REALTIME_PENDING_MAX_AGE_SEC 와 두 knob 중 작은 값이 실제 임계로 사용된다 —
# backward-compat 을 위해 둘 다 인정한다. 기본 6000ms = 6s 로 보수적이면서도
# UI 가 "듣는 중" 에서 30s+ 마냥 멈춰 보이지 않게 한다.
EMS_REALTIME_PENDING_FORCE_COMMIT_MS = int(
    os.getenv("EMS_REALTIME_PENDING_FORCE_COMMIT_MS", "6000")
)


def _force_commit_threshold_sec() -> float:
    """Pending 이 머무를 수 있는 최대 시간(초). FORCE_COMMIT_MS / MAX_AGE_SEC 중 작은 값."""
    return min(
        EMS_REALTIME_PENDING_MAX_AGE_SEC,
        EMS_REALTIME_PENDING_FORCE_COMMIT_MS / 1000.0,
    )
# session 에 caller language 가 확정된 뒤 짧은 chunk 에 한해 STT 에 language hint 를
# 보낼지 여부. 기본 false — 게이트웨이가 auto-detect 하도록 둔다.
EMS_STT_USE_LANGUAGE_HINT: bool = _parse_bool(
    os.getenv("EMS_STT_USE_LANGUAGE_HINT", "false"), False
)

log.info(
    "[ems_realtime] realtime pending buffer enabled=%s min_words=%d max_age=%.1fs "
    "max_chars=%d force_commit=%dms effective_threshold=%.2fs stt_lang_hint=%s",
    EMS_REALTIME_PENDING_ENABLED, EMS_REALTIME_PENDING_MIN_WORDS,
    EMS_REALTIME_PENDING_MAX_AGE_SEC, EMS_REALTIME_PENDING_MAX_TEXT_CHARS,
    EMS_REALTIME_PENDING_FORCE_COMMIT_MS, _force_commit_threshold_sec(),
    EMS_STT_USE_LANGUAGE_HINT,
)


# ============================================================================
# Hallucination / language / role keyword tables
# ============================================================================

HALLUCINATIONS = {
    "thank you", "thanks for watching", "thank you for watching",
    "thanks for watching!", "thanks", "thank you so much",
    "thank you very much", "you", ".", "...", "음...", "어...", "아...",
    "고맙습니다", "감사합니다", "시청해주셔서 감사합니다",
}

LANG_CODES = {"ko", "en", "ja", "zh", "vi", "th", "km", "ne"}

LANGUAGE_LABEL_EN = {
    "ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese",
    "vi": "Vietnamese", "th": "Thai", "km": "Khmer", "ne": "Nepali",
}

OPERATOR_KO_PHRASES = [
    "주소를 말씀", "주소를 알려", "주소가 어디", "정확한 주소", "정확한 위치",
    "위치를 말씀", "의식이 있", "의식 있", "의식 없", "호흡이 있", "호흡 있",
    "호흡 없", "숨 쉬고 있", "맥박이 있", "맥박 있", "어디가 아프", "어디 아프",
    "어디서 아프", "침착하세요", "침착하시고", "당황하지 마", "구급차가 출동",
    "구급대가 출동", "구급차 출동", "구급대 출동", "출동했습니다", "출동하겠습니다",
    "지금 출동", "곧 도착", "현장에 도착", "응급실로 이송", "병원으로 이송",
    "문을 열어", "문 열어주세요", "환자 나이", "환자 성별", "몇 살", "몇살이",
    "출혈이 있", "출혈 있", "피가 얼마나", "가슴을 눌러", "가슴 압박", "흉부 압박",
    "심폐소생", "기도확보", "응급처치", "통화 끊지 마", "전화 끊지 마",
]

# 어눌한 한국어 신고자(외국인/노약자) 발화를 폭넓게 잡기 위해 짧은 토큰 위주.
CALLER_KO_PHRASES = [
    "도와주세요", "도와줘요", "도와줘", "살려주세요", "살려줘",
    "사람이 쓰러", "사람 쓰러", "쓰러졌", "숨을 안", "숨이 안", "숨 안돼",
    "숨 못쉬", "엄마 숨", "아빠 숨", "아이 숨", "피가 나", "피가 많이",
    "피 나요", "출혈", "아파요", "아파서", "아픕니다", "많이 아파",
    "너무 아파", "사고가 났", "사고 났", "교통사고", "빨리 와", "빨리 오세요",
    "빨리 와주", "119", "구급차", "구급대", "응급차",
    "엄마가", "아빠가", "엄마", "아빠", "어지러워", "정신을 잃", "정신 잃",
]

CALLER_EN_PHRASES = [
    "i need help", "please help", "help me", "send help", "send ambulance",
    "send an ambulance", "call ambulance", "my mother", "my father",
    "my mom", "my dad", "my friend", "my brother", "my sister",
    "my husband", "my wife", "my son", "my daughter",
    "cannot breathe", "can't breathe", "not breathing", "stopped breathing",
    "collapsed", "fell down", "passed out", "unconscious", "accident",
    "car accident", "bleeding", "bleeding a lot", "emergency", "hurry",
    "come quickly",
]

INTERPRETER_PHRASES = [
    "제가 통역하겠", "통역해드리겠", "통역하겠습니다", "통역해 드리",
    "통역사입니다", "이분이 말씀", "신고자가 말씀", "환자가 말씀",
    "he says", "she says", "they say", "the caller says", "the patient says",
    "patient says", "interpreter speaking", "i am the interpreter",
    "i'll interpret",
]


def pick_tts_voice(lang: str) -> str:
    return "sohee" if lang == "ko" else "vivian"


# ============================================================================
# In-memory session state
# ============================================================================

class SessionState:
    """세션별로 화자/언어 컨텍스트와 최근 텍스트를 메모리에 저장."""

    __slots__ = (
        "primary_caller_language",
        "latest_caller_language",
        "secondary_caller_languages",
        "has_korean_caller",
        "recent_texts",
        # ---- normal-mode pending 버퍼 ----
        # 직전 chunk(들)의 STT 결과가 너무 짧거나 불완전한 fragment 일 때, 다음 chunk 와
        # 합쳐서 한 번 더 판단하기 위해 임시로 보관한다. 확정 commit 시 모두 비운다.
        "pending_text",
        "pending_first_seq",
        "pending_started_at",
        "pending_lang",
    )

    def __init__(self) -> None:
        self.primary_caller_language: Optional[str] = None
        self.latest_caller_language: Optional[str] = None
        self.secondary_caller_languages: list[str] = []
        self.has_korean_caller: bool = False
        # (client_seq, raw_text, normalized_text)
        self.recent_texts: deque = deque(maxlen=8)
        # pending 버퍼 — 모두 None 이면 비활성.
        self.pending_text: Optional[str] = None
        self.pending_first_seq: Optional[int] = None
        self.pending_started_at: Optional[float] = None
        self.pending_lang: Optional[str] = None

    def register_caller_language(self, lang: str) -> None:
        if not lang or lang == "unknown":
            return
        if lang == "ko":
            self.has_korean_caller = True
        if self.primary_caller_language is None:
            self.primary_caller_language = lang
        elif self.primary_caller_language != lang:
            if lang not in self.secondary_caller_languages:
                self.secondary_caller_languages.append(lang)
        self.latest_caller_language = lang

    def clear_pending(self) -> None:
        self.pending_text = None
        self.pending_first_seq = None
        self.pending_started_at = None
        self.pending_lang = None

    def pending_age_sec(self) -> float:
        if self.pending_started_at is None:
            return 0.0
        return max(0.0, time.perf_counter() - self.pending_started_at)


SESSIONS: dict[str, SessionState] = {}


def get_session(session_id: str) -> SessionState:
    sess = SESSIONS.get(session_id)
    if sess is None:
        sess = SessionState()
        SESSIONS[session_id] = sess
    return sess


# ============================================================================
# Text helpers
# ============================================================================

def normalize_for_dedup(text: str) -> str:
    t = (text or "").strip().lower()
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"[.!?。！？]+$", "", t)
    return t.strip()


def is_hallucination(text: str) -> bool:
    n = normalize_for_dedup(text)
    if not n:
        return True
    if n in HALLUCINATIONS:
        return True
    if len(n) <= 2:
        return True
    return False


# ============================================================================
# Fragment / confidence heuristics (normal-mode pending buffer 진단용)
# ============================================================================
#
# STT 서비스가 confidence score 를 돌려주지 않으므로, 텍스트 자체로 "확정 가능한
# 발화" 인지 "context 가 더 필요한 fragment" 인지 판정한다.
#
# 확정으로 보는 조건 (OR):
#   - 응급 키워드(caller/operator 표현 테이블) 포함
#   - 문장 종결 부호로 끝남 + 충분한 길이
#   - 명령형/요청 어미 ("하세요", "해주세요", "please ...", "send ...")
#   - 단어 수가 EMS_REALTIME_PENDING_MIN_WORDS 이상 + 알려진 fragment 패턴이 아님
#
# fragment 로 보는 조건 (OR — 위 확정 조건 미충족 전제):
#   - 단어 수가 EMS_REALTIME_PENDING_MIN_WORDS 미만 (3 단어 미만)
#   - 알려진 영어 fragment 패턴으로 끝남: "said it", "out of", "and the", ...
#   - 문장 종결 부호 없이 5 단어 미만

# 한국어 char 수 + 비한국어 토큰 수 합산. STT가 한국어를 띄어쓰기 없이 한 덩어리로
# 반환하는 경우(예: "도와주세요빨리") 가 잦아 char 수도 같이 본다.
_KO_CHAR_RE = re.compile(r"[가-힣]")
_TERMINATOR_RE = re.compile(r"[.!?。！？…]\s*[\"\'\)\]]?\s*$")

INCOMPLETE_EN_FRAGMENTS = {
    "said it", "out of", "and the", "to the", "for the", "of the",
    "in the", "on the", "but the", "with the", "from the", "as the",
    "such as", "he said", "she said", "they said", "i said", "you said",
    "you know", "i mean", "kind of", "sort of", "you see", "i was",
    "i'm just", "i am just", "it was", "it is", "is the", "was the",
    "or something", "something like", "something else", "this is",
    "that is", "that was", "and i", "and he", "and she", "and they",
    "but i", "but he", "but she", "but they",
}

# 명령형 / 요청형 어미 — caller/operator 한 단어 발화에서도 강한 신호.
_KO_COMMAND_ENDINGS = (
    "하세요", "해주세요", "주세요", "하십시오", "하시오", "해줘",
    "주십시오", "도와", "보내", "오세요", "와주세요", "해야",
)
_EN_COMMAND_PREFIXES = (
    "please ", "send ", "call ", "get ", "give ", "tell ", "help ",
    "come ", "stop ", "wait ", "go ", "do ", "don't ", "do not ",
)


def _is_command_form(text: str, lang: str) -> bool:
    t = text.strip()
    if not t:
        return False
    if lang == "ko" or _KO_CHAR_RE.search(t):
        return any(t.endswith(end) or t.endswith(end + ".") for end in _KO_COMMAND_ENDINGS)
    tl = t.lower()
    return tl.startswith(_EN_COMMAND_PREFIXES)


def text_word_count(text: str) -> int:
    """한국어 char + 비한국어 공백 토큰 수 합산. 0이면 텍스트 없음."""
    if not text:
        return 0
    ko_chars = len(_KO_CHAR_RE.findall(text))
    tokens = [tok for tok in re.split(r"\s+", text.strip()) if tok]
    # 한국어 char 가 포함된 토큰은 한국어 char count 로 이미 셌으므로 비한국어 토큰만.
    non_ko_tokens = [tok for tok in tokens if not _KO_CHAR_RE.search(tok)]
    return ko_chars + len(non_ko_tokens)


def has_sentence_terminator(text: str) -> bool:
    return bool(_TERMINATOR_RE.search((text or "").strip()))


def has_emergency_signal(text: str, lang: str) -> bool:
    """119 응급 키워드(테이블)가 한 개라도 포함되어 있는지."""
    if not text:
        return False
    text_lower = text.lower()
    # 한국어 — caller/operator 표현 모두 응급 컨텍스트의 강한 신호.
    if lang == "ko" or _KO_CHAR_RE.search(text):
        for k in CALLER_KO_PHRASES:
            if k in text:
                return True
        for k in OPERATOR_KO_PHRASES:
            if k in text:
                return True
    # 영어 — caller 표현. interpreter 표현도 강한 신호.
    for k in CALLER_EN_PHRASES:
        if k in text_lower:
            return True
    for k in INTERPRETER_PHRASES:
        if k in text_lower:
            return True
    return False


def is_incomplete_fragment(text: str, lang: str) -> bool:
    """텍스트가 추가 context 없이 그대로 번역하기에는 짧거나 불완전한지 판정.

    True 면 normal mode 의 pending 버퍼로 들어가야 한다. 응급 키워드/명령형/종결부호 같은
    "확정 신호" 가 있으면 단어 수가 적어도 즉시 처리해야 하므로 False.
    """
    t = (text or "").strip()
    if not t:
        return True

    # 1) 응급 키워드가 있으면 짧아도 확정 — "Help!" / "119!" / "도와주세요" 등.
    if has_emergency_signal(t, lang):
        return False

    # 2) 명령형/요청형 — 단어 수가 적어도 확정.
    if _is_command_form(t, lang):
        return False

    word_count = text_word_count(t)
    tl = t.lower()

    # 3) 알려진 영어 fragment 패턴으로 끝나거나 정확히 일치 — fragment 확정.
    #    "My father said it" 같은 케이스는 "said it" 으로 끝나므로 fragment.
    for frag in INCOMPLETE_EN_FRAGMENTS:
        if tl.endswith(frag) or tl == frag:
            return True

    # 4) 너무 짧음 (3 단어 미만 — 단 종결 부호가 있는 짧은 발화는 의문문/탄식으로 확정).
    if word_count < EMS_REALTIME_PENDING_MIN_WORDS:
        if has_sentence_terminator(t):
            return False
        return True

    # 5) 길이는 어느 정도지만 종결 부호 없이 5 단어 미만이면 끊긴 가능성이 높다.
    if not has_sentence_terminator(t) and word_count < 5:
        return True

    return False


def detect_language_from_text(text: str) -> str:
    """STT가 language를 안 줄 때를 위한 unicode-block heuristic."""
    t = (text or "").strip()
    if not t:
        return "unknown"
    if re.search(r"[가-힯ᄀ-ᇿ]", t):
        return "ko"
    if re.search(r"[぀-ヿ]", t):
        return "ja"
    if re.search(r"[฀-๿]", t):
        return "th"
    if re.search(r"[ក-៿]", t):
        return "km"
    if re.search(r"[ऀ-ॿ]", t):
        return "ne"
    if re.search(r"[一-鿿]", t):
        return "zh"
    if re.search(
        r"[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]",
        t,
    ):
        return "vi"
    letters = re.sub(r"[^A-Za-z]", "", t)
    if len(letters) >= 2 and len(letters) / len(t) > 0.4:
        return "en"
    return "unknown"


def strip_overlap_from_prev(prev_text: str, next_text: str) -> tuple[str, str]:
    """직전 chunk 끝과 새 chunk 앞이 겹치면 그 만큼 잘라낸다."""
    max_len = min(len(prev_text), len(next_text), 60)
    for length in range(max_len, 4, -1):
        tail = prev_text[-length:]
        if next_text.startswith(tail):
            return next_text[length:].strip(), tail
    return next_text, ""


def classify_speaker(text: str, lang: str, sess: SessionState) -> dict:
    text_lower = text.lower()

    # 통역사 메타 발화 — 가장 강한 신호.
    for kw in INTERPRETER_PHRASES:
        if kw in text_lower:
            return {
                "speaker": "interpreter",
                "confidence": 0.9,
                "reason": f'통역사 표현 감지: "{kw}"',
                "source_language": lang if lang != "unknown" else "ko",
                "target_language": "unknown",
            }

    if lang == "unknown":
        return {
            "speaker": "unknown",
            "confidence": 0.0,
            "reason": "발화 언어 식별 실패 — 역할 판단 보류",
            "source_language": "unknown",
            "target_language": "unknown",
        }

    operator_hits = [k for k in OPERATOR_KO_PHRASES if k in text]
    caller_hits = [k for k in CALLER_KO_PHRASES if k in text]
    caller_hits += [k for k in CALLER_EN_PHRASES if k in text_lower]
    op_score = len(operator_hits)
    cl_score = len(caller_hits)

    target_for_op = (
        sess.latest_caller_language
        or sess.primary_caller_language
        or "unknown"
    )

    # 한국어 발화 — operator vs caller (어눌한 한국어 신고자 가능성도 고려).
    if lang == "ko":
        if cl_score > op_score:
            return {
                "speaker": "caller",
                "confidence": min(0.92, 0.55 + 0.12 * (cl_score - op_score)),
                "reason": f'한국어 발화이지만 도움 요청 표현 감지: "{caller_hits[0]}"',
                "source_language": "ko",
                "target_language": target_for_op,
            }
        if op_score > cl_score:
            return {
                "speaker": "operator",
                "confidence": min(0.92, 0.65 + 0.10 * (op_score - cl_score)),
                "reason": f'구급대원 응급 질의/지시 표현 감지: "{operator_hits[0]}"',
                "source_language": "ko",
                "target_language": target_for_op,
            }
        if sess.has_korean_caller:
            return {
                "speaker": "unknown",
                "confidence": 0.3,
                "reason": "한국어 신고자가 이미 등장한 세션 — 단일 마이크로 화자 분리 불가",
                "source_language": "ko",
                "target_language": "unknown",
            }
        return {
            "speaker": "operator",
            "confidence": 0.55,
            "reason": "한국어 발화 — 기본 규칙으로 구급대원 추정",
            "source_language": "ko",
            "target_language": target_for_op,
        }

    # 외국어 발화 — 통상 신고자.
    if cl_score > 0:
        return {
            "speaker": "caller",
            "confidence": min(0.95, 0.78 + 0.07 * cl_score),
            "reason": f'외국어({lang}) + 도움 요청 표현 감지: "{caller_hits[0]}"',
            "source_language": lang,
            "target_language": "ko",
        }
    if op_score > 0:
        return {
            "speaker": "operator",
            "confidence": 0.5,
            "reason": f'외국어이지만 구급대원 표현 감지: "{operator_hits[0]}" (낮은 확신)',
            "source_language": lang,
            "target_language": target_for_op,
        }
    return {
        "speaker": "caller",
        "confidence": 0.72,
        "reason": f"외국어({lang}) 발화 — 신고자로 추정",
        "source_language": lang,
        "target_language": "ko",
    }


# ============================================================================
# External service calls (STT / LLM / TTS)
# ============================================================================

class STTCallError(RuntimeError):
    """STT 호출 실패. 호출부가 envelope 의 error 필드에 HTTP status / body head /
    timeout 여부를 명시적으로 담을 수 있도록 구조화된 metadata를 노출한다.

    body_head 에는 응답 본문 앞 500자만 보관 (긴 HTML 페이지/에러 페이지 안전).
    """

    def __init__(
        self,
        message: str,
        *,
        mode: str,
        http_status: Optional[int] = None,
        body_head: Optional[str] = None,
        timeout: bool = False,
        exc_class: Optional[str] = None,
    ):
        super().__init__(message)
        self.mode = mode
        self.http_status = http_status
        self.body_head = body_head
        self.timeout = timeout
        self.exc_class = exc_class

    def to_error_string(self) -> str:
        """envelope.error 필드에 들어갈 단일 문자열로 직렬화."""
        parts = [f"stt({self.mode})"]
        if self.http_status is not None:
            parts.append(f"http={self.http_status}")
        if self.timeout:
            parts.append("timeout=true")
        if self.exc_class:
            parts.append(f"exc={self.exc_class}")
        msg = super().__str__()
        if msg:
            parts.append(msg)
        if self.body_head:
            # repr로 감싸 줄바꿈/제어문자를 한 줄로 표현.
            parts.append(f"body={self.body_head!r}")
        return " | ".join(parts)


async def call_stt(
    client: httpx.AsyncClient,
    audio_bytes: bytes,
    filename: str,
    mime: str,
    mode: str,
    language_hint: Optional[str] = None,
) -> tuple[str, Optional[str], list[dict]]:
    """STT 호출. 반환: (text, detected_language_or_None, segments).

    성공한 curl 과 완전히 동일한 multipart 형태로 호출한다:
      curl -X POST {STT_URL} \\
        -F "file=@{filename};type={mime}" \\
        -F "model={STT_MODEL}"
    추가 필드(language / response_format) 는 기본적으로 보내지 않는다 — 게이트웨이가
    auto-detect 하도록 두고, 응답은 기본 json 으로 받는다.

    예외적으로 language_hint 가 전달되고 EMS_STT_USE_LANGUAGE_HINT=true 인 경우
    normal mode 에서만 `-F "language=<code>"` 를 추가해 짧은 chunk 의 오인식을 줄인다.
    diarization mode 는 게이트웨이가 화자별로 다른 언어를 다뤄야 하므로 절대 hint 를
    보내지 않는다.

    diarization 모드는 별도 endpoint(DIARIZE_URL)를 쓰고 model 필드를 보내지 않는다 —
    해당 서비스가 자체적으로 모델을 결정하기 때문.

    실패 시:
      - HTTP >= 400: STTCallError(http_status=..., body_head=resp.text[:500])
      - httpx.TimeoutException: STTCallError(timeout=True, exc_class=...)
      - 그 외 httpx.RequestError(connect 실패 등): STTCallError(exc_class=...)
      - JSON 파싱 실패: STTCallError(http_status=..., body_head=resp.text[:500])
    """
    url = DIARIZE_URL if mode == "diarization" else STT_URL
    # multipart 구성 — curl 의 `-F "file=@...;type=..."` 와 정확히 동일.
    files = {"file": (filename, audio_bytes, mime)}
    data: dict = {}
    if mode != "diarization":
        # 일반 STT(cohere-transcribe) — curl 의 `-F "model=cohere-transcribe"` 와 동일.
        data["model"] = STT_MODEL
        # 옵션: session memory 가 확정한 caller language 를 STT 힌트로 전달.
        # 잘못된 힌트가 더 큰 오인식을 부르지 않도록 LANG_CODES 안에 있을 때만 적용.
        if (
            EMS_STT_USE_LANGUAGE_HINT
            and language_hint
            and language_hint in LANG_CODES
        ):
            data["language"] = language_hint
    # 기본적으로 language / response_format 은 보내지 않는다 (auto-detect, default json).

    log.info(
        "[ems_realtime] STT call mode=%s url=%s model=%s lang_hint=%s bytes=%d "
        "filename=%s mime=%s timeout=%ss",
        mode, url, data.get("model", "<none>"), data.get("language", "<none>"),
        len(audio_bytes), filename, mime, STT_TIMEOUT,
    )

    try:
        resp = await client.post(url, files=files, data=data, timeout=STT_TIMEOUT)
    except httpx.TimeoutException as e:
        raise STTCallError(
            f"timeout after {STT_TIMEOUT}s",
            mode=mode, timeout=True, exc_class=type(e).__name__,
        ) from e
    except httpx.RequestError as e:
        # ConnectError / RemoteProtocolError / NetworkError 등 — HTTP 응답이 아예 없는 경우.
        raise STTCallError(
            f"network error: {e}",
            mode=mode, exc_class=type(e).__name__,
        ) from e

    if resp.status_code >= 400:
        body_head = (resp.text or "")[:500]
        raise STTCallError(
            "non-2xx response",
            mode=mode, http_status=resp.status_code, body_head=body_head,
        )

    try:
        body = resp.json()
    except Exception as e:
        body_head = (resp.text or "")[:500]
        raise STTCallError(
            f"non-JSON response: {e}",
            mode=mode, http_status=resp.status_code, body_head=body_head,
            exc_class=type(e).__name__,
        ) from e

    if not isinstance(body, dict):
        body_head = (resp.text or "")[:500]
        raise STTCallError(
            f"unexpected response type: {type(body).__name__}",
            mode=mode, http_status=resp.status_code, body_head=body_head,
        )

    # 성공 응답 — 운영팀 curl 결과와 동일하게 data["text"] 를 그대로 사용.
    text = (body.get("text") or "").strip()

    raw_lang = body.get("language") or body.get("detected_language") or ""
    detected = raw_lang.strip().lower()[:2] if isinstance(raw_lang, str) else ""
    # 다국어 STT 진단용 — LANG_CODES 필터 전후 값을 모두 로그에 남기기 위해
    # 필터 적용 직전의 normalized candidate 를 별도 캡처. logic 분기에는 사용하지 않는다.
    _diag_normalized_candidate = detected
    if detected not in LANG_CODES:
        detected = None

    # ⚠ 원문 / segment 원문은 절대 로그에 포함하지 않는다 — 길이 / 카운트 / 스크립트
    # 분포만 남겨 베트남어/태국어/캄보디아어/네팔어/중국어/일본어가 안 잡힐 때
    # (a) STT 응답 body 에 language/detected_language 키 자체가 있는지
    # (b) raw_lang 값이 무엇으로 오는지 (예: "" / "vi" / "vie" / "zh-cn" / "cmn")
    # (c) [:2] slice + LANG_CODES 필터로 None 으로 떨어졌는지
    # (d) STT 가 그래도 텍스트는 잡았는지 (text_len) — 잡았다면 어느 스크립트인지
    # 를 한 줄로 진단할 수 있게 한다.
    _raw_body_segments = body.get("segments")
    _diag(
        "stt_raw_response",
        mode=mode,
        http_status=resp.status_code,
        filename=filename,
        body_keys=sorted(body.keys()),
        has_language=("language" in body),
        has_detected_language=("detected_language" in body),
        raw_lang_repr=repr(raw_lang),
        normalized_detected_candidate=_diag_normalized_candidate,
        detected_after_lang_codes_filter=detected,
        text_len=len(text),
        segment_count=(
            len(_raw_body_segments) if isinstance(_raw_body_segments, list) else 0
        ),
        script_summary=_script_summary(text),
    )

    segments: list[dict] = []
    raw_segments = body.get("segments") or []
    if isinstance(raw_segments, list):
        for s in raw_segments:
            if not isinstance(s, dict):
                continue
            seg_text = (s.get("text") or "").strip()
            if not seg_text:
                continue
            segments.append({
                "speaker": str(s.get("speaker", "")),
                "start": float(s.get("start", 0)),
                "end": float(s.get("end", 0)),
                "text": seg_text,
            })
    return text, detected, segments


class LLMAuthMissing(RuntimeError):
    """LLM API 키가 설정되어 있지 않을 때 raise. 호출부에서 잡아 status='error' 응답으로 변환한다."""


class LLMEmptyResponse(ValueError):
    """LLM이 정상 응답(2xx)이지만 번역 텍스트를 추출할 수 없을 때 raise.

    .shape 속성에 디버깅용 구조 metadata를 담아 호출부가 envelope의
    debug_llm_shape 필드로 노출할 수 있게 한다. 실제 키/헤더/요청 body는 절대 담지 않는다.
    """

    def __init__(self, message: str, shape: dict):
        super().__init__(message)
        self.shape = shape


class LLMPostprocessEmpty(ValueError):
    """LLM 응답에 컨텐츠/리즈닝은 존재했지만 후처리(메타 제거 + 스크립트 필터)에서
    최종 번역 후보가 남지 않았을 때 raise. 호출부에서 status="error" /
    error="translate: no final translation extracted" /
    reason="translation-postprocess-empty" envelope로 변환한다.
    """

    def __init__(self, message: str, shape: dict):
        super().__init__(message)
        self.shape = shape


# 길거나 민감할 수 있는 값은 항상 잘라서 보관 — 운영 환경에서도 안전.
DEBUG_REPR_MAX_CHARS = 300


def _typename(v) -> str:
    return type(v).__name__


def _safe_repr_head(v, limit: int = DEBUG_REPR_MAX_CHARS) -> Optional[str]:
    """repr() 후 앞 limit자만 잘라서 반환. None이면 None."""
    if v is None:
        return None
    try:
        s = repr(v)
    except Exception:
        try:
            s = f"<unreprable {_typename(v)}>"
        except Exception:
            return None
    if len(s) > limit:
        return s[:limit] + f"...<+{len(s) - limit}chars>"
    return s


def _safe_keys(v) -> Optional[list]:
    """dict면 keys 리스트, 아니면 None. (값은 절대 포함하지 않음)"""
    if isinstance(v, dict):
        try:
            return [str(k) for k in v.keys()]
        except Exception:
            return None
    return None


def _describe_llm_response_shape(http_status: int, data) -> dict:
    """LLM 응답의 구조만 추출. 민감정보(키/헤더/원문 body)는 절대 포함하지 않는다.

    포함하는 정보:
      - http_status
      - root_type / root_keys
      - choices: type / length
      - choices[0]: keys
      - choices[0].message: type / keys
      - choices[0].message.content: type / repr 앞 300자
      - choices[0].text: type / repr 앞 300자
      - choices[0].delta: type / keys
    """
    shape: dict = {
        "http_status": http_status,
        "root_type": _typename(data),
        "root_keys": _safe_keys(data),
        "choices_type": None,
        "choices_len": None,
        "choice0_keys": None,
        "message_type": None,
        "message_keys": None,
        "content_type": None,
        "content_repr_head": None,
        "text_type": None,
        "text_repr_head": None,
        "delta_type": None,
        "delta_keys": None,
        # OpenAI-compat finish_reason / Anthropic-ish stop_reason — 응답이 잘렸는지(length),
        # 정상 종료인지(stop), tool 호출(tool_calls) 등 종료 원인 진단용.
        "finish_reason": None,
        "stop_reason": None,
        # reasoning fallback 진단용 — 세 위치 모두 metadata만 기록.
        "message_reasoning_type": None,
        "message_reasoning_repr_head": None,
        "choice_reasoning_type": None,
        "choice_reasoning_repr_head": None,
        "root_reasoning_type": None,
        "root_reasoning_repr_head": None,
    }

    choices = data.get("choices") if isinstance(data, dict) else None
    shape["choices_type"] = _typename(choices)
    if isinstance(choices, list):
        shape["choices_len"] = len(choices)
        if choices:
            first = choices[0]
            shape["choice0_keys"] = _safe_keys(first)
            if isinstance(first, dict):
                # finish_reason은 보통 choices[0]에, stop_reason은 root 또는 choices[0] 양쪽 가능.
                fr = first.get("finish_reason")
                if isinstance(fr, (str, int)):
                    shape["finish_reason"] = fr
                sr = first.get("stop_reason")
                if isinstance(sr, (str, int)):
                    shape["stop_reason"] = sr
                message = first.get("message")
                shape["message_type"] = _typename(message)
                shape["message_keys"] = _safe_keys(message)
                if isinstance(message, dict):
                    content = message.get("content")
                    shape["content_type"] = _typename(content)
                    shape["content_repr_head"] = _safe_repr_head(content)
                    message_reasoning = message.get("reasoning")
                    shape["message_reasoning_type"] = _typename(message_reasoning)
                    shape["message_reasoning_repr_head"] = _safe_repr_head(message_reasoning)
                text_val = first.get("text")
                shape["text_type"] = _typename(text_val)
                shape["text_repr_head"] = _safe_repr_head(text_val)
                delta = first.get("delta")
                shape["delta_type"] = _typename(delta)
                shape["delta_keys"] = _safe_keys(delta)
                choice_reasoning = first.get("reasoning")
                shape["choice_reasoning_type"] = _typename(choice_reasoning)
                shape["choice_reasoning_repr_head"] = _safe_repr_head(choice_reasoning)
    if isinstance(data, dict):
        root_reasoning = data.get("reasoning")
        shape["root_reasoning_type"] = _typename(root_reasoning)
        shape["root_reasoning_repr_head"] = _safe_repr_head(root_reasoning)
        # Anthropic-호환 게이트웨이는 stop_reason을 root에 둘 수 있다 — choices[0]에서
        # 못 잡았으면 root에서 한 번 더 시도.
        if shape["stop_reason"] is None:
            root_sr = data.get("stop_reason")
            if isinstance(root_sr, (str, int)):
                shape["stop_reason"] = root_sr
    return shape


def _log_llm_empty_shape(shape: dict) -> None:
    """warning 로그를 항목별로 한 줄씩 — 한 줄로 합치면 로그 라인이 잘리거나 grep이 힘들어진다."""
    log.warning("LLM empty content response")
    log.warning("LLM raw http_status=%s", shape.get("http_status"))
    log.warning("LLM raw root_keys=%s", shape.get("root_keys"))
    log.warning(
        "LLM raw choices type=%s len=%s",
        shape.get("choices_type"), shape.get("choices_len"),
    )
    log.warning("LLM raw choices[0] keys=%s", shape.get("choice0_keys"))
    log.warning(
        "LLM raw finish_reason=%s stop_reason=%s",
        shape.get("finish_reason"), shape.get("stop_reason"),
    )
    log.warning(
        "LLM raw choices[0].message type=%s keys=%s",
        shape.get("message_type"), shape.get("message_keys"),
    )
    log.warning(
        "LLM raw choices[0].message.content type=%s repr=%s",
        shape.get("content_type"), shape.get("content_repr_head"),
    )
    log.warning(
        "LLM raw choices[0].text type=%s repr=%s",
        shape.get("text_type"), shape.get("text_repr_head"),
    )
    log.warning(
        "LLM raw choices[0].delta type=%s keys=%s",
        shape.get("delta_type"), shape.get("delta_keys"),
    )
    log.warning(
        "LLM raw message.reasoning type=%s repr=%s",
        shape.get("message_reasoning_type"),
        shape.get("message_reasoning_repr_head"),
    )
    log.warning(
        "LLM raw choices[0].reasoning type=%s repr=%s",
        shape.get("choice_reasoning_type"),
        shape.get("choice_reasoning_repr_head"),
    )
    log.warning(
        "LLM raw root.reasoning type=%s repr=%s",
        shape.get("root_reasoning_type"),
        shape.get("root_reasoning_repr_head"),
    )


async def call_translate(
    client: httpx.AsyncClient,
    system_prompt: str,
    user_prompt: str,
    target_lang: str = "ko",
    source_lang=None,
) -> str:
    # 운영팀(주무관) 안내 호출 규약 — 공용 LLM 게이트웨이:
    #   POST https://ai2.jb.go.kr/llm/v1/chat/completions
    #   (인증 불필요 — Authorization 헤더 미부착)
    #   model: Qwen3.6-27B (default), 다른 모델은 env(EMS_LLM_MODEL) 로만 override.
    #
    # 인증 정책:
    #   - URL 이 /llm/v1/ 경유 (= 공용 게이트웨이) → 항상 Authorization 미부착.
    #     LLM_API_KEY 가 환경에 남아 있어도 무시한다. 401 자체가 발생하지 않는 경로.
    #   - 그 외 URL (예: OWI 본체 /api/chat/completions 등으로 override 시):
    #       · LLM_API_KEY 있음   → Bearer 헤더 부여
    #       · LLM_API_KEY 없음 + LLM_AUTH_REQUIRED=true  → LLMAuthMissing raise
    #       · LLM_API_KEY 없음 + LLM_AUTH_REQUIRED=false → 헤더 없이 호출 (cookie 가정)
    #   기존 키 파일/env override 로직(_resolve_llm_api_key) 자체는 유지 — 다른 경로로
    #   재구성될 때 그대로 재사용 가능.
    is_public_llm_gateway = "/llm/v1/" in LLM_URL
    if not is_public_llm_gateway and not LLM_API_KEY and LLM_AUTH_REQUIRED:
        log.warning("LLM API key missing (EMS_LLM_AUTH_REQUIRED=true)")
        raise LLMAuthMissing("LLM API key missing")

    headers: dict[str, str] = {"Content-Type": "application/json"}
    auth_attached = False
    if not is_public_llm_gateway and LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"
        auth_attached = True

    # 호출 시점 인증 상태 진단 — token 값은 절대 출력 금지, attached 여부/길이/경로만 노출.
    log.info(
        "[ems_realtime] LLM call auth_header_attached=%s token_length=%d "
        "auth_required=%s public_gateway=%s url=%s model=%s",
        auth_attached,
        len(LLM_API_KEY) if LLM_API_KEY else 0,
        LLM_AUTH_REQUIRED,
        is_public_llm_gateway,
        LLM_URL,
        LLM_MODEL,
    )

    # 운영팀이 제시한 단순화된 payload — enable_thinking / thinking / extra_body 등
    # 게이트웨이별 reasoning 토글은 모두 제거. content 응답을 1차 신뢰하고, reasoning만
    # 오는 경우는 후처리 단계에서 fallback으로 흡수한다.
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
        "max_tokens": 200,
        "temperature": 0.2,
    }
    resp = await client.post(
        LLM_URL, json=payload, headers=headers, timeout=HTTP_TIMEOUT
    )
    resp.raise_for_status()
    http_status = resp.status_code

    # ---- 응답 파싱 (방어적) ----
    # OpenAI 계열 API 호환이지만 게이트웨이/모델에 따라 message.content가:
    #   - None (모델이 빈 응답)
    #   - "" (빈 문자열)
    #   - list[ {type:"text", text:"..."} ] (vision/multipart 응답)
    #   - dict {"text": "..."} 또는 {"content": "..."}
    # 등 다양하게 올 수 있어 일괄 정규화한다. None.strip() AttributeError 방지.
    try:
        data = resp.json()
    except Exception as e:
        # body가 JSON이 아닌 경우도 shape으로 기록 — 단, 원문 body는 담지 않는다.
        shape = {
            "http_status": http_status,
            "root_type": "non-json",
            "json_error": str(e)[:200],
        }
        _log_llm_empty_shape(shape)
        raise LLMEmptyResponse(f"LLM response not JSON: {e}", shape)

    if not isinstance(data, dict):
        shape = _describe_llm_response_shape(http_status, data)
        _log_llm_empty_shape(shape)
        raise LLMEmptyResponse("LLM response root is not a dict", shape)

    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        shape = _describe_llm_response_shape(http_status, data)
        _log_llm_empty_shape(shape)
        raise LLMEmptyResponse("empty translation response", shape)

    # ---- 1) 원시 텍스트 수집 ----
    # 게이트웨이별로 다른 응답 위치를 차례로 시도. 어디서 가져왔든 raw_text는
    # "후처리 전 LLM이 토해낸 본문"이며, 곧이어 통일된 후처리 파이프라인을 거친다.
    first = choices[0] if isinstance(choices[0], dict) else {}
    message = first.get("message") if isinstance(first, dict) else None

    raw_text = ""
    raw_origin = None

    def _try(v, origin):
        nonlocal raw_text, raw_origin
        if raw_text:
            return
        extracted = _extract_text_from_content(v)
        if extracted:
            raw_text = extracted
            raw_origin = origin

    if isinstance(message, dict):
        _try(message.get("content"), "message.content")
    if isinstance(first, dict):
        _try(first.get("text"), "choice.text")
        _try(first.get("content"), "choice.content")
        delta = first.get("delta")
        if isinstance(delta, dict):
            _try(delta.get("content"), "choice.delta.content")
    # reasoning 경로 — Qwen 계열이 thinking-trace를 여기에 담는다.
    if isinstance(message, dict):
        _try(message.get("reasoning"), "message.reasoning")
    if isinstance(first, dict):
        _try(first.get("reasoning"), "choice.reasoning")
    _try(data.get("reasoning") if isinstance(data, dict) else None, "root.reasoning")

    # ---- 2) 응답 자체가 비어있던 경우 — LLMEmptyResponse ----
    if not raw_text:
        shape = _describe_llm_response_shape(http_status, data)
        _log_llm_empty_shape(shape)
        raise LLMEmptyResponse("empty translation response", shape)

    # ---- 3) 통일된 후처리 ----
    # 어떤 경로(content/text/delta/reasoning)에서 왔든 동일한 일반화 파이프라인.
    # _extract_translation_from_reasoning은 marker → 코드펜스 → bullet/번호/quote/화살표/괄호 →
    # 메타 라인 제거 → target/source 스크립트 필터 순으로 청소한 뒤 join한다.
    translated = _extract_translation_from_reasoning(
        raw_text, target_lang, source_lang
    )

    # ---- 4) 후처리 결과가 비었으면 LLMPostprocessEmpty ----
    if not translated:
        shape = _describe_llm_response_shape(http_status, data)
        _log_llm_empty_shape(shape)
        log.warning(
            "LLM postprocess yielded empty (origin=%s, source_lang=%s, target_lang=%s, raw_len=%d)",
            raw_origin, source_lang, target_lang, len(raw_text),
        )
        raise LLMPostprocessEmpty("no final translation extracted", shape)

    # 운영 가시화용 — origin이 reasoning류였을 때만 warning, 일반 content는 info.
    if raw_origin and "reasoning" in raw_origin:
        log.warning(
            "LLM reasoning fallback used (origin=%s, source_lang=%s, target_lang=%s, "
            "raw_len=%d, picked_len=%d)",
            raw_origin, source_lang, target_lang,
            len(raw_text), len(translated),
        )
    else:
        log.info(
            "LLM translate ok (origin=%s, source_lang=%s, target_lang=%s, "
            "raw_len=%d, picked_len=%d)",
            raw_origin, source_lang, target_lang,
            len(raw_text), len(translated),
        )

    return translated


# Qwen 계열 reasoning 응답에서 자주 보이는 "번역:" / "Translation:" 마커.
# 마지막 마커 이후 본문을 line 단위로 분해해 bullet/번호/quote/"->" 좌측을 제거한 뒤
# 모든 의미 라인을 공백으로 join — 여러 문장 번역을 빠짐없이 보존한다.
_REASONING_MARKERS = (
    "번역:", "번역 :", "번역결과:", "번역 결과:", "번역 결과 :",
    "한국어 번역:", "한국어번역:", "한국어:",
    "Translation:", "translation:", "Translated:", "translated:",
    "Korean translation:", "korean translation:",
    "Final translation:", "최종 번역:", "최종번역:",
    "Answer:", "answer:", "Output:", "output:",
)

# Qwen reasoning이 자주 새는 영어/한국어 메타 프롬프트 라인 — case-insensitive prefix match로 제거.
# 라인이 이들 중 하나로 "시작"하면 통째로 버린다. 마커(":" 끝)와 비-마커(":" 없음) 모두 포함.
_META_LINE_PREFIXES = (
    # 사고 흐름 / 분석
    "thinking process", "thinking:", "thinking ",
    "let me think", "let's think",
    "analyze", "analysis:", "analysis ",
    "explanation:", "explanation ",
    # 역할/제약/과제
    "role:", "role ",
    "constraint:", "constraints:", "constraint ",
    "task:", "tasks:",
    # 입출력 라벨
    "input:", "input ",
    "output:", "output ",
    "source text:", "source:",
    "result:", "results:",
    # 언어/키워드/번역 지시
    "detected language:", "language:",
    "translate to", "translation to",
    "keywords:", "keyword:",
    "markdown:", "markdown ",
    # 콘텐츠 보존/지시
    "content preservation:", "content:",
    "instruction:", "instructions:",
    "system:", "user:", "assistant:",
    "you are", "you must", "you should",
    "step ", "step:",
)


def _is_meta_line(s: str) -> bool:
    """줄이 영어 메타 프롬프트(설명/지시/역할 정의)로 시작하는지 판정."""
    if not isinstance(s, str):
        return False
    lower = s.strip().lower()
    if not lower:
        return False
    for prefix in _META_LINE_PREFIXES:
        if lower.startswith(prefix):
            return True
    return False


# ----------------------------------------------------------------------------
# 언어-독립적 스크립트 / 라인 판정 (Unicode block 기반)
#
# 코드 로직 안에 특정 언어 분기(if lang == "ko" / "zh" / "ja" ...)를 두지 않는다.
# 모든 언어 동작은 _LANG_PROFILE 데이터 테이블만 보고 결정된다 — 새 언어 추가는
# 테이블에 한 줄 더하는 것으로 충분하다.
# ----------------------------------------------------------------------------

_SCRIPT_BUCKETS = (
    "hangul", "kana", "han", "thai", "khmer", "devanagari",
    "arabic", "cyrillic", "latin",
)


def _script_counts(s: str) -> dict:
    """라인을 스크립트별로 글자수 분해. 의미 글자(letter)만 카운트, 공백/숫자/구두점 제외."""
    c = {k: 0 for k in _SCRIPT_BUCKETS}
    c["total"] = 0
    if not isinstance(s, str):
        return c
    for ch in s:
        cp = ord(ch)
        bucket = None
        # Hangul syllables + Jamo + compatibility
        if (
            0xAC00 <= cp <= 0xD7A3
            or 0x1100 <= cp <= 0x11FF
            or 0x3130 <= cp <= 0x318F
            or 0xA960 <= cp <= 0xA97F
            or 0xD7B0 <= cp <= 0xD7FF
        ):
            bucket = "hangul"
        # Hiragana + Katakana
        elif (
            0x3040 <= cp <= 0x309F
            or 0x30A0 <= cp <= 0x30FF
            or 0x31F0 <= cp <= 0x31FF
        ):
            bucket = "kana"
        # CJK Unified Ideographs (Han)
        elif (
            0x4E00 <= cp <= 0x9FFF
            or 0x3400 <= cp <= 0x4DBF
            or 0xF900 <= cp <= 0xFAFF
        ):
            bucket = "han"
        elif 0x0E00 <= cp <= 0x0E7F:
            bucket = "thai"
        elif 0x1780 <= cp <= 0x17FF:
            bucket = "khmer"
        elif 0x0900 <= cp <= 0x097F:
            bucket = "devanagari"
        # Arabic (+ supplement, extended A)
        elif (
            0x0600 <= cp <= 0x06FF
            or 0x0750 <= cp <= 0x077F
            or 0x08A0 <= cp <= 0x08FF
            or 0xFB50 <= cp <= 0xFDFF
            or 0xFE70 <= cp <= 0xFEFF
        ):
            bucket = "arabic"
        # Cyrillic (+ supplement, extended-B)
        elif (
            0x0400 <= cp <= 0x04FF
            or 0x0500 <= cp <= 0x052F
            or 0x2DE0 <= cp <= 0x2DFF
            or 0xA640 <= cp <= 0xA69F
        ):
            bucket = "cyrillic"
        # Latin — Basic + Latin Extended + Latin Extended Additional
        # (영어/베트남어/스페인어/프랑스어/독일어/포르투갈어 등 라틴 계열 모두 포함)
        elif (
            (0x41 <= cp <= 0x5A)
            or (0x61 <= cp <= 0x7A)
            or 0x00C0 <= cp <= 0x024F
            or 0x1E00 <= cp <= 0x1EFF
        ):
            bucket = "latin"
        if bucket:
            c[bucket] += 1
            c["total"] += 1
    return c


# 언어 → 스크립트 프로필. 키: ISO 639-1 코드. 새 언어는 여기만 추가.
#   primary       : 그 언어를 식별하는 주 스크립트 — 라인에 1자 이상 있어야 함
#   forbid_any    : 1자라도 있으면 그 언어로 보지 않음 (예: zh는 kana/hangul 있으면 ja/ko)
#   forbid_dom    : primary보다 더 많이 나타나면 그 언어로 보지 않음 (예: ko는 한글 < 한자면 zh로 본다)
#   presence_only : True면 primary 1자라도 있으면 통과 (다른 스크립트 dominance 무시) — ja에 적용
_LANG_PROFILE = {
    # CJK
    "ko": {"primary": "hangul", "forbid_dom": ("han", "kana")},
    "ja": {"primary": "kana", "presence_only": True},
    "zh": {"primary": "han", "forbid_any": ("kana", "hangul")},
    # 동남아/남아시아
    "th": {"primary": "thai", "forbid_dom": ("latin",)},
    "km": {"primary": "khmer", "forbid_dom": ("latin",)},
    "ne": {"primary": "devanagari", "forbid_dom": ("latin",)},
    "hi": {"primary": "devanagari", "forbid_dom": ("latin",)},
    # 아랍/키릴
    "ar": {"primary": "arabic", "forbid_dom": ("latin",)},
    "fa": {"primary": "arabic", "forbid_dom": ("latin",)},
    "ur": {"primary": "arabic", "forbid_dom": ("latin",)},
    "ru": {"primary": "cyrillic", "forbid_dom": ("latin",)},
    "uk": {"primary": "cyrillic", "forbid_dom": ("latin",)},
    "bg": {"primary": "cyrillic", "forbid_dom": ("latin",)},
    "sr": {"primary": "cyrillic", "forbid_dom": ("latin",)},
    # 라틴 계열 (스크립트로는 서로 구분 불가 — 같은 primary 공유)
    "en": {"primary": "latin"},
    "vi": {"primary": "latin"},
    "es": {"primary": "latin"},
    "fr": {"primary": "latin"},
    "de": {"primary": "latin"},
    "pt": {"primary": "latin"},
    "it": {"primary": "latin"},
    "id": {"primary": "latin"},
    "ms": {"primary": "latin"},
    "tl": {"primary": "latin"},
    "nl": {"primary": "latin"},
    "pl": {"primary": "latin"},
    "ro": {"primary": "latin"},
    "tr": {"primary": "latin"},
}


def _primary_script_of(lang) -> str:
    """언어 코드 → primary script. 모르는 언어는 None."""
    if not isinstance(lang, str):
        return None
    profile = _LANG_PROFILE.get(lang.lower())
    return profile["primary"] if profile else None


def _line_matches_lang(s: str, lang) -> bool:
    """라인이 lang의 스크립트 프로필에 맞는지 — 100% 데이터 테이블 기반.

    어떤 lang이든 동일한 알고리즘으로 판정한다. 특정 언어 분기 없음.
    모르는 lang에 대해서는 의미 글자가 1자라도 있으면 보수적으로 통과.
    """
    if not isinstance(s, str) or not s.strip():
        return False
    if not isinstance(lang, str):
        return False
    profile = _LANG_PROFILE.get(lang.lower())
    c = _script_counts(s)
    if c["total"] == 0:
        return False
    if profile is None:
        # 모르는 언어 — 보수적 통과 (다른 필터가 결정)
        return True

    primary = profile["primary"]
    if c.get(primary, 0) == 0:
        return False
    # forbid_any: 해당 스크립트가 1자라도 있으면 reject
    for b in profile.get("forbid_any", ()):
        if c.get(b, 0) > 0:
            return False
    # presence_only: primary가 있기만 하면 OK (다른 스크립트 분포 무시)
    if profile.get("presence_only"):
        return True
    # forbid_dom: primary 보다 더 많으면 reject
    for b in profile.get("forbid_dom", ()):
        if c.get(b, 0) > c.get(primary, 0):
            return False
    return True


def _is_translation_line(s: str, target_lang, source_lang) -> bool:
    """라인이 target_lang의 번역 결과로 보이는지 — source 원문/메타 라인은 제외.

    완전 일반화: 어떤 target/source 조합이든 동일 알고리즘으로 판정한다.

    규칙:
      1) target_lang의 프로필과 맞아야 한다.
      2) target과 source의 primary script가 다를 때만 source 매칭 reject 적용
         (둘 다 latin 등 같은 스크립트면 구분 불가 → reject 안 함).
    """
    if not isinstance(s, str) or not s.strip():
        return False
    if not _line_matches_lang(s, target_lang):
        return False
    if source_lang and source_lang != target_lang:
        ts = _primary_script_of(target_lang)
        ss = _primary_script_of(source_lang)
        # 같은 스크립트를 공유하는 언어쌍(en/vi/es/...)에서는 reject 룰을 적용하지 않는다.
        if ts != ss and _line_matches_lang(s, source_lang):
            return False
    return True

# bullet/번호 접두어 — "- ", "* ", "• ", "1. ", "1) ", "ii." 등을 제거.
# 단어 첫 글자에 마침표가 붙은 한국어 약어("주.민.번호" 같은)는 영향 없음 (공백 필수).
_BULLET_PREFIX_RE = re.compile(
    r"^\s*(?:[-*•·▪►‣◦●○■□▶▷]|\d+[.)]|[ivxIVX]+[.)])\s+"
)

# 화살표 — 마지막 화살표 우측만 번역 본문으로 본다.
_ARROW_PATTERNS = ("→", "->", "⇒", "=>", "►")

# 양쪽 quote/괄호 — 반복적으로 벗겨낸다.
_QUOTE_OPEN = "\"'`「『《(（[【〈〔“‘"
_QUOTE_CLOSE = "\"'`」』》)）]】〉〕”’"

# 라인 중간/끝에 붙은 괄호 보조 설명 — "살려주세요 (Help me)" / "환자 (patient)" 등.
# 짝이 맞고 내부에 닫는 괄호가 없는 경우만 제거. 매치 부분은 단일 공백으로 치환해
# 좌우 단어가 붙지 않도록 한다 (이후 multi-space collapse).
_PAREN_AUX_RE = re.compile(r"\s*[(（\[【][^)）\]】]{0,80}[)）\]】]\s*")
_MULTI_SPACE_RE = re.compile(r"\s+")


def _strip_outer_quotes(s: str) -> str:
    """양쪽에 둘러싸인 quote/괄호를 반복 제거. 한쪽만 있으면 그쪽만 떼어낸다."""
    s = s.strip()
    changed = True
    while changed and s:
        changed = False
        if s[0] in _QUOTE_OPEN:
            s = s[1:].lstrip()
            changed = True
        if s and s[-1] in _QUOTE_CLOSE:
            s = s[:-1].rstrip()
            changed = True
    return s


def _clean_translation_line(line: str) -> str:
    """단일 라인에서:
      1) bullet/번호 접두어 제거
      2) 마지막 화살표가 있으면 우측만 사용 (원문 -> 번역 형식 대응)
      3) 라인 중간/끝의 보조 설명 괄호 제거 (먼저 — outer quote가 trailing `)`를
         삼키기 전에 짝 매칭 기반으로 제거. 결과가 비면 원본 유지)
      4) 양쪽 quote/괄호 stripping
      5) 공백 압축
    """
    s = line.strip()
    if not s:
        return ""

    # bullet/번호 접두어 — 화살표 처리 전에 먼저 떼어내 "1. A → B" 같은 형식도 깨끗하게.
    s = _BULLET_PREFIX_RE.sub("", s).strip()
    if not s:
        return ""

    # 마지막 화살표 기준으로 우측만 — "원문 -> 번역" / "中文 → 한글" 모두 대응.
    last_arrow_idx = -1
    last_arrow_len = 0
    for arrow in _ARROW_PATTERNS:
        idx = s.rfind(arrow)
        if idx > last_arrow_idx:
            last_arrow_idx = idx
            last_arrow_len = len(arrow)
    if last_arrow_idx >= 0:
        s = s[last_arrow_idx + last_arrow_len:].strip()

    # 보조 설명 괄호 제거 — outer quote 처리 전에 먼저 (matching `)` 를 quote stripper가
    # 단독 quote로 오해해 삼키는 것을 방지). 비면 원본 유지.
    stripped = _PAREN_AUX_RE.sub(" ", s)
    stripped = _MULTI_SPACE_RE.sub(" ", stripped).strip()
    if stripped:
        s = stripped

    s = _strip_outer_quotes(s)
    s = _MULTI_SPACE_RE.sub(" ", s).strip()
    return s


def _split_into_lines(body: str) -> list:
    """splitlines로 1차 분할 후, 한 줄에 여러 bullet이 들어있는 경우도 분리.

    예: "- 도와주세요 - 빨리 와주세요" → ["도와주세요", "빨리 와주세요"]
    bullet은 줄 첫 위치 외에 ' - ' 형태로 중간에 등장할 때만 split (대시가 어법상
    포함된 한국어 문장은 영향 없음).
    """
    lines: list = []
    for raw in body.splitlines():
        chunk = raw.strip()
        if not chunk:
            continue
        # 중간 bullet split — " * ", " - " 같은 패턴이 2번 이상 등장할 때만 적용.
        if chunk.count(" - ") >= 2 or chunk.count(" * ") >= 2:
            for piece in re.split(r"\s+[-*]\s+", chunk):
                p = piece.strip()
                if p:
                    lines.append(p)
        else:
            lines.append(chunk)
    return lines


def _extract_translation_from_reasoning(
    text: str,
    target_lang: str = "ko",
    source_lang=None,
) -> str:
    """reasoning(chain-of-thought) 텍스트에서 실제 번역 부분만 추출.

    모든 source_language / 모든 target_language에 동일하게 적용된다.
    중국어/특정 언어 하드코딩 없음 — 스크립트 프로필로만 판정.

    동작:
      1) 마지막 마커("번역:" / "Translation:" 등) 위치 검색.
         있으면 마커 이후가 본문, 없으면 reasoning 전체가 본문.
      2) 본문에 ``` 코드펜스가 있으면 마지막 펜스 내부를 본문으로 교체.
      3) 본문을 라인 분해 → 각 라인 정리(bullet/번호/quote/화살표) →
         (a) ":" 끝 헤더 제거
         (b) 영어 메타 프롬프트 leak 라인 제거 (_is_meta_line)
         (c) target_lang 스크립트 라인만 유지 + source_lang 원문 라인 제거
             (_is_translation_line)
         → 공백 join.
      4) 정리 후 라인이 모두 비면 body 자체를 한 번 정리해 fallback.
    어떤 입력에도 예외 없이 str을 반환한다.
    """
    if not isinstance(text, str):
        return ""
    s = text.strip()
    if not s:
        return ""

    # 1) 마지막 마커 위치 찾기 (대소문자 무시).
    lowered = s.lower()
    last_pos = -1
    last_marker_len = 0
    for marker in _REASONING_MARKERS:
        m = marker.lower()
        idx = lowered.rfind(m)
        if idx > last_pos:
            last_pos = idx
            last_marker_len = len(marker)

    body = s[last_pos + last_marker_len:].strip() if last_pos >= 0 else s
    if not body:
        return ""

    # 2) 본문에 코드펜스 있으면 마지막 펜스 내부 사용.
    if "```" in body:
        parts = body.split("```")
        for chunk in reversed(parts):
            inner = chunk.strip()
            if not inner:
                continue
            # 첫 줄이 언어 라벨일 때만 떼어낸다. 언어 라벨은 순수 ASCII 알파벳/숫자만
            # (json/python/text/bash 등) — 한글/CJK 첫 줄(실제 번역)은 잘라내면 안 된다.
            first_nl = inner.find("\n")
            if first_nl != -1:
                head = inner[:first_nl].strip()
                if (
                    0 < len(head) <= 16
                    and head.isascii()
                    and head.replace("_", "").replace("-", "").isalnum()
                ):
                    inner = inner[first_nl + 1:].strip()
            if inner:
                body = inner
                break

    # 3) 라인 단위로 정리.
    raw_lines = _split_into_lines(body)
    cleaned = [_clean_translation_line(ln) for ln in raw_lines]
    # (a) 빈 라인 / ":" 로 끝나는 헤더성 라인 제외
    cleaned = [c for c in cleaned if c and not c.endswith(":")]
    # (b) 영어 메타 프롬프트 leak(Analyze/Role:/Constraint:/Detected Language:/Translate to/...) 제외
    cleaned = [c for c in cleaned if not _is_meta_line(c)]
    # (c) target_lang 스크립트 라인만 유지 + source_lang 원문 라인 제거 (모든 언어 일반화).
    cleaned = [c for c in cleaned if _is_translation_line(c, target_lang, source_lang)]

    if cleaned:
        # 여러 문장 번역을 모두 보존 — 공백 1개로 join.
        return " ".join(cleaned).strip()

    # 4) 정리 후 라인이 모두 비면 body 자체를 한 번 정리 — 마지막 안전망.
    single = _clean_translation_line(body)
    if (
        single
        and _is_translation_line(single, target_lang, source_lang)
        and not _is_meta_line(single)
    ):
        return single
    return ""


def _extract_text_from_content(content) -> str:
    """LLM message.content (str | list | dict | None | 기타)에서 안전하게 텍스트 추출.

    어떤 입력이 와도 예외를 던지지 않고 ""를 반환한다. strip()은 반드시
    isinstance(value, str) 가드 안에서만 호출한다.
    """
    if content is None:
        return ""

    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        # multipart/vision 형식: [{"type": "text", "text": "..."} , ...]
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict):
                # 우선순위: text → content → value
                for key in ("text", "content", "value"):
                    v = item.get(key)
                    if isinstance(v, str) and v:
                        parts.append(v)
                        break
        joined = "".join(parts).strip() if parts else ""
        return joined

    if isinstance(content, dict):
        # 단일 dict 응답 — text/content/value 순으로 탐색.
        for key in ("text", "content", "value"):
            v = content.get(key)
            if isinstance(v, str):
                return v.strip()
            if isinstance(v, list):
                nested = _extract_text_from_content(v)
                if nested:
                    return nested
        return ""

    # 기타 타입 — 안전하게 빈 문자열로.
    return ""


async def _process_diarization_segments(
    client: httpx.AsyncClient,
    segments: list[dict],
    sess: SessionState,
    latency: dict,
    stt_lang: Optional[str] = None,
) -> dict:
    """diarization 응답의 segment들을 segment 단위로 처리.

    각 segment마다 source_language 감지 / role 분류 / target 결정 / 번역을 수행하고
    세션의 caller language memory를 점진적으로 갱신한다 (영어 caller 등장 후의
    한국어 operator 발화는 영어로 번역되도록).

    stt_lang 은 call_stt() 가 반환한 STT 응답의 raw language (LANG_CODES 로 정규화된
    값) 다. segment 텍스트의 detect_language_from_text 결과만으로는 잡히지 않는 케이스
    (특히 일본어: 한자-only segment → zh 오인, 환각 한글 1자 끼어듦 → ko 오인) 를
    보조 신호로 보정한다. 기존 zh/vi/en 등이 성공하던 케이스는 detected==stt_lang 이라
    분기 자체가 발생하지 않아 회귀 없음.

    반환 dict:
        enriched_segments       — spec #3에서 정의된 확장 필드를 갖는 segment 리스트
        top_translated          — segment translated들을 줄 단위로 합친 문자열
        top_source_language     — 단일 언어이면 그 코드, 여러 개면 "mixed", 없으면 "unknown"
        top_target_language     — 동일 규칙
        top_speaker             — 단일 role이면 그 값, 여러 개면 "mixed", 없으면 "unknown"
        top_speaker_confidence  — segment confidence 평균
        translate_ms            — segment 번역에 소요된 총 시간(ms)
    """
    enriched: list[dict] = []
    translated_lines: list[str] = []
    source_langs: set[str] = set()
    target_langs: set[str] = set()
    roles: set[str] = set()
    confidences: list[float] = []
    translate_total_ms = 0

    for seg in segments:
        seg_text = (seg.get("text") or "").strip()
        seg_speaker_label = str(seg.get("speaker", ""))
        seg_start = float(seg.get("start", 0.0) or 0.0)
        seg_end = float(seg.get("end", 0.0) or 0.0)

        if not seg_text:
            continue

        # segment 단위 환각/빈응답 필터 — 원문/role은 유지하되 번역은 생략.
        if is_hallucination(seg_text):
            enriched.append({
                "speaker": seg_speaker_label,
                "start": seg_start,
                "end": seg_end,
                "text": seg_text,
                "source_language": "unknown",
                "target_language": "unknown",
                "role": "unknown",
                "role_reason": "환각/빈응답으로 추정 — 번역 생략",
                "role_confidence": 0.0,
                "translated": "",
                "error": None,
                "reason": "stt-empty-or-hallucinated",
            })
            continue

        detected = detect_language_from_text(seg_text)
        seg_lang = detected
        # ─── STT raw language 를 보조 신호로 보정 (일본어 ja 라우팅 실패 fix) ─────
        # detect_language_from_text 는 첫-매치 우선순위 + kana 없는 한자만 있으면 zh
        # 라는 두 한계로 일본어를 ko 또는 zh 로 오인할 수 있다. STT 응답이 "ja" 라고
        # 직접 알려주면 segment 단위에서도 그것을 보조로 받아 ja 로 보정한다.
        # 다른 언어(zh/vi/th/km/ne/en 등) 는 detected 가 unknown 일 때만 stt_lang 으로
        # 폴백해 회귀를 차단한다.
        if stt_lang in LANG_CODES:
            if stt_lang == "ja" and detected in ("unknown", "zh", "ko"):
                seg_lang = "ja"
            elif detected == "unknown":
                seg_lang = stt_lang
        # ⚠ 원문은 로그에 남기지 않는다 — 길이 / script 분포 / 결정 결과만.
        _diag(
            "diarize_lang_resolution",
            detected_by_text=detected,
            stt_lang=stt_lang,
            final_seg_lang=seg_lang,
            script_summary=_script_summary(seg_text),
            segment_text_len=len(seg_text),
            overridden=(seg_lang != detected),
        )
        classification = classify_speaker(seg_text, seg_lang, sess)
        role = classification["speaker"]
        src = classification["source_language"]
        tgt = classification["target_language"]

        # caller로 분류된 외국어/한국어 segment는 즉시 session caller-lang memory 갱신.
        # 이후 segment의 classify_speaker는 갱신된 latest_caller_language를 본다.
        if role == "caller" and src in LANG_CODES:
            sess.register_caller_language(src)

        seg_translated = ""
        seg_error: Optional[str] = None
        seg_reason: Optional[str] = None

        skip_translate = (
            role in ("unknown", "interpreter")
            or tgt == "unknown"
            or tgt not in LANG_CODES
        )

        if skip_translate:
            if tgt == "unknown" or tgt not in LANG_CODES:
                seg_reason = "no-translation-target"
        else:
            target_label = LANGUAGE_LABEL_EN.get(tgt, tgt)
            sys_prompt = (
                f"You are a real-time interpreter. "
                f"Translate the user's message into {target_label}. "
                f"Output only the translation."
            )
            t0 = time.perf_counter()
            try:
                seg_translated = await call_translate(
                    client, sys_prompt, seg_text,
                    target_lang=tgt, source_lang=src,
                )
            except LLMAuthMissing:
                seg_error = "LLM API key missing"
                seg_reason = "llm-auth-missing"
            except LLMPostprocessEmpty:
                seg_error = "translate: no final translation extracted"
                seg_reason = "translation-postprocess-empty"
            except LLMEmptyResponse as e:
                seg_error = f"translate: {e}"
                seg_reason = "llm-empty-response"
            except Exception as e:
                # 번역 실패 시에도 원문/role/language 정보는 살린다 (spec #7).
                seg_error = f"translate: {e}"
                seg_reason = None
            translate_total_ms += int((time.perf_counter() - t0) * 1000)

        enriched.append({
            "speaker": seg_speaker_label,
            "start": seg_start,
            "end": seg_end,
            "text": seg_text,
            "source_language": src,
            "target_language": tgt,
            "role": role,
            "role_reason": classification["reason"],
            "role_confidence": classification["confidence"],
            "translated": seg_translated,
            "error": seg_error,
            "reason": seg_reason,
        })

        if seg_translated:
            translated_lines.append(seg_translated)
        if src in LANG_CODES:
            source_langs.add(src)
        if tgt in LANG_CODES:
            target_langs.add(tgt)
        if role and role != "unknown":
            roles.add(role)
        try:
            confidences.append(float(classification.get("confidence") or 0.0))
        except Exception:
            pass

    def _agg(values: set[str]) -> str:
        if len(values) == 1:
            return next(iter(values))
        if len(values) > 1:
            return "mixed"
        return "unknown"

    top_conf = (sum(confidences) / len(confidences)) if confidences else 0.0

    latency["translate_ms"] = (latency.get("translate_ms") or 0) + translate_total_ms

    return {
        "enriched_segments": enriched,
        "top_translated": "\n".join(translated_lines),
        "top_source_language": _agg(source_langs),
        "top_target_language": _agg(target_langs),
        "top_speaker": _agg(roles),
        "top_speaker_confidence": top_conf,
        "translate_ms": translate_total_ms,
    }


async def call_tts(
    client: httpx.AsyncClient,
    text: str,
    lang: str,
) -> bytes:
    payload = {
        "model": TTS_MODEL,
        "voice": pick_tts_voice(lang),
        "input": text,
        "response_format": "mp3",
        "stream": False,
    }
    resp = await client.post(TTS_URL, json=payload, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.content


# ============================================================================
# Endpoints
# ============================================================================

# ---------------------------------------------------------------------------
# Phase A 진단 로깅 (코드 로직 변경 없음 — 관찰자 패턴)
#
# `_diag("event_name", key=value, ...)` 형식으로 한 줄에 grep 가능한 구조화
# 로그를 남긴다. 운영자가 첫 문장 후 안 듣는 문제를 재현·특정할 수 있도록
# process_chunk 전 단계에 호출된다. 어떤 결정도 바꾸지 않고 단지 관찰만 한다.
#
# 사용 예 (서버 로그 grep):
#   grep "\[ems-rt diag\]" server.log
#   grep "\[ems-rt diag\] chunk_in" server.log
#   grep "\[ems-rt diag\] fragment_decision" server.log
# ---------------------------------------------------------------------------

# 텍스트 본문은 길어질 수 있으므로 로그에는 앞 60자까지만 남긴다.
_DIAG_TEXT_HEAD = 60


def _text_head(text: Optional[str], limit: int = _DIAG_TEXT_HEAD) -> str:
    if not text:
        return ""
    t = text.replace("\n", "\\n")
    if len(t) <= limit:
        return t
    return t[:limit] + f"...<+{len(t) - limit}c>"


# 다국어 STT 진단용 — 응답 텍스트의 스크립트(유니코드 블록) 카운트만 집계.
# 절대 원문을 반환하지 않는다. raw_lang 가 비어 있을 때 텍스트가 어느 스크립트로
# 나왔는지(latin/zh/kana/hangul/deva/thai/khmer) 한 줄로 확인해 LID 가 STT 자체에서
# 안 나온 건지, 코드 normalize 단계에서 떨어진 건지, STT 가 영어로 hallucinate 한 건지
# 구분할 수 있게 한다.
#
# 그룹 정의:
#   latin   — ASCII A-Z/a-z + Latin Extended (베트남어 분음 포함; 0x00C0-0x024F)
#   zh      — CJK Unified Ideographs (0x4E00-0x9FFF) — 일본어 한자와 공유
#   kana    — Hiragana/Katakana (0x3040-0x30FF) — 일본어 고유 신호
#   hangul  — Hangul Syllables (0xAC00-0xD7A3) + Jamo (0x1100-0x11FF)
#   deva    — Devanagari (0x0900-0x097F) — 네팔/힌디
#   thai    — Thai (0x0E00-0x0E7F)
#   khmer   — Khmer (0x1780-0x17FF)
# 공백/구두점/숫자 같은 비-script ASCII 는 카운트 제외.
def _script_summary(text: str) -> str:
    counts = {
        "latin": 0, "zh": 0, "kana": 0, "hangul": 0,
        "deva": 0, "thai": 0, "khmer": 0,
    }
    if not text:
        return " ".join(f"{k}={v}" for k, v in counts.items())
    for ch in text:
        c = ord(ch)
        if c <= 0x7F:
            if 0x41 <= c <= 0x5A or 0x61 <= c <= 0x7A:
                counts["latin"] += 1
        elif 0x00C0 <= c <= 0x024F:
            counts["latin"] += 1
        elif 0xAC00 <= c <= 0xD7A3 or 0x1100 <= c <= 0x11FF:
            counts["hangul"] += 1
        elif 0x3040 <= c <= 0x30FF:
            counts["kana"] += 1
        elif 0x4E00 <= c <= 0x9FFF:
            counts["zh"] += 1
        elif 0x0900 <= c <= 0x097F:
            counts["deva"] += 1
        elif 0x0E00 <= c <= 0x0E7F:
            counts["thai"] += 1
        elif 0x1780 <= c <= 0x17FF:
            counts["khmer"] += 1
    return " ".join(f"{k}={v}" for k, v in counts.items())


def _diag(event: str, **fields) -> None:
    """Phase A 구조화 진단 로그. 결정 로직을 바꾸지 않는다 — 관찰 전용.

    필드 값은 가능한 한 원시 타입으로 받는다. 문자열은 항상 repr 로 감싸 공백/
    줄바꿈이 한 줄에 안전하게 들어가게 한다. None 은 'None' 으로 표기.
    """
    parts: list[str] = []
    for k, v in fields.items():
        if isinstance(v, str):
            parts.append(f"{k}={v!r}")
        elif v is None:
            parts.append(f"{k}=None")
        elif isinstance(v, bool):
            parts.append(f"{k}={'true' if v else 'false'}")
        else:
            parts.append(f"{k}={v}")
    log.info("[ems-rt diag] %s %s", event, " ".join(parts))


def _envelope(
    session_id: str,
    client_seq: int,
    status: str,
    *,
    text: str = "",
    translated: str = "",
    source_language: str = "unknown",
    target_language: str = "unknown",
    speaker: str = "unknown",
    speaker_reason: str = "",
    speaker_confidence: float = 0.0,
    segments: Optional[list] = None,
    latency: Optional[dict] = None,
    audio_base64: Optional[str] = None,
    error: Optional[str] = None,
    reason: Optional[str] = None,
    # LLM 응답 구조 진단용 임시 필드. None이면 응답에서 키 자체가 비어 있다.
    # 절대 API 키/요청 헤더/요청 body를 포함하지 않는다 — 응답 구조 metadata만.
    debug_llm_shape: Optional[dict] = None,
) -> dict:
    return {
        "session_id": session_id,
        "client_seq": client_seq,
        "status": status,
        "text": text,
        "translated": translated,
        "source_language": source_language,
        "target_language": target_language,
        "speaker": speaker,
        "speaker_reason": speaker_reason,
        "speaker_confidence": speaker_confidence,
        "segments": segments or [],
        "latency": latency or {
            "stt_ms": 0, "translate_ms": 0, "tts_ms": 0, "total_ms": 0,
        },
        "audio_base64": audio_base64,
        "error": error,
        "reason": reason,
        "debug_llm_shape": debug_llm_shape,
    }


@router.post("/process")
async def process_chunk(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    client_seq: int = Form(...),
    mode: str = Form("normal"),
    previous_caller_language: Optional[str] = Form(None),
):
    """발화 후보 오디오 chunk를 STT → 화자/언어 판단 → 번역 → TTS 까지 일괄 처리.

    컨텐츠 레벨 실패는 절대 raise하지 않는다 — JSON envelope의 status 필드로 통보.
    """
    t_start = time.perf_counter()
    sess = get_session(session_id)
    # Phase B1 — force-commit-timeout 표시 플래그.
    # pending 이 임계값을 넘어 강제 flush 된 경우 True. 최종 ok envelope 의 reason 에
    # "force-commit-timeout" 으로 노출되어 프론트가 듣는 중 placeholder 를 해소할 때
    # 진단용 배지를 표시할 수 있게 한다.
    force_commit_this_round = False

    # [Phase A diag] 요청 진입 — 세션 메모리 상태와 함께 한 줄로 남긴다.
    _diag(
        "chunk_in",
        session=session_id,
        seq=client_seq,
        mode=mode,
        content_type=file.content_type or "",
        prev_caller_lang=previous_caller_language,
        sess_primary=sess.primary_caller_language,
        sess_latest=sess.latest_caller_language,
        sess_recent_count=len(sess.recent_texts),
        sess_pending_text_len=(
            len(sess.pending_text) if sess.pending_text else 0
        ),
        sess_pending_first_seq=sess.pending_first_seq,
        sess_pending_age_ms=int(sess.pending_age_sec() * 1000),
    )

    # 프론트가 보낸 previous_caller_language로 세션 부트스트랩 (재시작 후 메모리 휘발 대비).
    if (
        previous_caller_language
        and previous_caller_language in LANG_CODES
        and sess.latest_caller_language is None
    ):
        sess.latest_caller_language = previous_caller_language
        sess.primary_caller_language = previous_caller_language
        if previous_caller_language == "ko":
            sess.has_korean_caller = True
        _diag(
            "session_bootstrap_from_hint",
            session=session_id,
            seq=client_seq,
            bootstrapped_lang=previous_caller_language,
        )

    # ---- 1. 업로드 읽기 ----
    try:
        audio_bytes = await file.read()
    except Exception as e:
        log.exception("[ems_realtime] upload read failed session=%s seq=%s",
                      session_id, client_seq)
        _diag(
            "chunk_out",
            session=session_id,
            seq=client_seq,
            status="error",
            reason="upload-read",
            total_ms=int((time.perf_counter() - t_start) * 1000),
        )
        return JSONResponse(
            _envelope(session_id, client_seq, "error", error=f"upload-read: {e}"),
            status_code=200,
        )

    if not audio_bytes or len(audio_bytes) < MIN_AUDIO_BYTES:
        log.info(
            "[ems_realtime] skipped tiny chunk session=%s seq=%s bytes=%s",
            session_id, client_seq, len(audio_bytes),
        )
        _diag(
            "chunk_out",
            session=session_id,
            seq=client_seq,
            status="skipped",
            reason="audio-too-short",
            audio_bytes=len(audio_bytes),
            total_ms=int((time.perf_counter() - t_start) * 1000),
        )
        return JSONResponse(
            _envelope(session_id, client_seq, "skipped", reason="audio-too-short"),
            status_code=200,
        )

    _diag(
        "audio_accepted",
        session=session_id,
        seq=client_seq,
        audio_bytes=len(audio_bytes),
    )

    suffix = ".wav" if (file.content_type or "").endswith("wav") else ".webm"
    tmp_path: Optional[str] = None
    latency = {"stt_ms": 0, "translate_ms": 0, "tts_ms": 0, "total_ms": 0}

    try:
        # 디버그/재처리용 임시 파일 (즉시 메모리에서 STT로 보내고 finally에서 정리).
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        # SSL_VERIFY는 AsyncClient 생성 시점에 한 번 적용되며,
        # 이 client를 통한 STT / 화자분리 / LLM / TTS 모든 호출에 동일하게 작용한다.
        async with httpx.AsyncClient(verify=SSL_VERIFY) as client:
            # ---- 2. STT ----
            # normal mode 에서 pending 버퍼(직전 fragment) 가 있거나 caller language 가
            # 세션 메모리에 있으면 STT 에 hint 를 보낼 수 있다 (env 로 옵션화).
            # diarization 은 어떤 경우에도 hint 를 쓰지 않는다 (분류 정확도 보호).
            stt_language_hint: Optional[str] = None
            if mode != "diarization" and EMS_STT_USE_LANGUAGE_HINT:
                # 우선순위: pending_lang(연속 발화 추정) > latest_caller_language.
                stt_language_hint = sess.pending_lang or sess.latest_caller_language

            _diag(
                "stt_call",
                session=session_id,
                seq=client_seq,
                mode=mode,
                audio_bytes=len(audio_bytes),
                lang_hint=stt_language_hint,
            )
            t0 = time.perf_counter()
            try:
                stt_text, stt_lang, segments = await call_stt(
                    client,
                    audio_bytes,
                    filename=f"chunk-{session_id}-{client_seq}{suffix}",
                    mime=file.content_type or ("audio/wav" if suffix == ".wav" else "audio/webm"),
                    mode=mode,
                    language_hint=stt_language_hint,
                )
            except STTCallError as e:
                # 구조화된 STT 실패 — envelope.error 에 http status / response body / timeout 명시.
                # normal / diarization 양쪽 동일 경로로 통과한다.
                log.warning(
                    "[ems_realtime] STT failed session=%s seq=%s mode=%s http=%s timeout=%s exc=%s msg=%s",
                    session_id, client_seq, e.mode, e.http_status, e.timeout, e.exc_class, str(e),
                )
                latency["stt_ms"] = int((time.perf_counter() - t0) * 1000)
                latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                _diag(
                    "chunk_out",
                    session=session_id,
                    seq=client_seq,
                    status="error",
                    reason="stt-failed",
                    http_status=e.http_status,
                    timeout=e.timeout,
                    total_ms=latency["total_ms"],
                    stt_ms=latency["stt_ms"],
                )
                return JSONResponse(
                    _envelope(session_id, client_seq, "error",
                              latency=latency, error=e.to_error_string()),
                    status_code=200,
                )
            except Exception as e:
                # 예기치 못한 예외 — str(e)가 비어도 클래스명만큼은 노출되도록 fallback.
                log.exception("[ems_realtime] STT failed session=%s seq=%s",
                              session_id, client_seq)
                latency["stt_ms"] = int((time.perf_counter() - t0) * 1000)
                latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                msg = str(e) or repr(e)
                _diag(
                    "chunk_out",
                    session=session_id,
                    seq=client_seq,
                    status="error",
                    reason="stt-exception",
                    exc=type(e).__name__,
                    total_ms=latency["total_ms"],
                )
                return JSONResponse(
                    _envelope(session_id, client_seq, "error",
                              latency=latency,
                              error=f"stt({mode}) | exc={type(e).__name__} | {msg}"),
                    status_code=200,
                )
            latency["stt_ms"] = int((time.perf_counter() - t0) * 1000)
            _diag(
                "stt_done",
                session=session_id,
                seq=client_seq,
                mode=mode,
                text_len=len(stt_text or ""),
                text_head=_text_head(stt_text),
                detected_lang=stt_lang,
                segments_count=len(segments or []),
                stt_ms=latency["stt_ms"],
            )

            # ---- 3a. diarization mode: segment 단위 처리 ----
            # mode=="diarization" 이고 segments가 있으면 전체 text 한 덩어리로 묶지 않고
            # segment별로 source_language / role / target_language / 번역을 결정한다.
            # 세션의 caller language memory는 segment 처리 중 점진적으로 갱신되어,
            # 영어 caller segment 직후의 한국어 operator segment는 영어로 번역된다.
            if mode == "diarization" and segments:
                _diag(
                    "diarize_branch_enter",
                    session=session_id,
                    seq=client_seq,
                    segments_count=len(segments),
                )
                diarize = await _process_diarization_segments(
                    client, segments, sess, latency, stt_lang=stt_lang,
                )
                enriched_segments = diarize["enriched_segments"]
                top_translated = diarize["top_translated"]
                top_source = diarize["top_source_language"]
                top_target = diarize["top_target_language"]
                top_speaker = diarize["top_speaker"]
                top_conf = diarize["top_speaker_confidence"]

                # 최상위 text — 기존처럼 STT가 돌려준 전체 diarized transcript 유지.
                # 만약 STT가 전체 text를 비웠다면 segment.text join으로 fallback.
                top_text = stt_text or "\n".join(
                    s["text"] for s in enriched_segments if s.get("text")
                )

                # TTS — top-level translated가 있을 때 한 번만 합성 (spec #8).
                # target이 "mixed"이면 단일 voice로는 정확한 모국어 발음을 보장할 수
                # 없으므로 audio 합성을 생략 (segment별 합성은 추후 고도화).
                audio_b64: Optional[str] = None
                if top_translated and top_target in LANG_CODES:
                    t0 = time.perf_counter()
                    try:
                        tts_bytes = await call_tts(client, top_translated, top_target)
                        audio_b64 = base64.b64encode(tts_bytes).decode("ascii")
                    except Exception as e:
                        log.exception(
                            "[ems_realtime] TTS failed (non-fatal, diarize) "
                            "session=%s seq=%s: %s",
                            session_id, client_seq, e,
                        )
                    latency["tts_ms"] = int((time.perf_counter() - t0) * 1000)

                latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                log.info(
                    "[ems_realtime] ok diarize session=%s seq=%s segments=%d "
                    "lang=%s→%s speaker=%s stt=%dms tr=%dms tts=%dms total=%dms",
                    session_id, client_seq, len(enriched_segments),
                    top_source, top_target, top_speaker,
                    latency["stt_ms"], latency["translate_ms"],
                    latency["tts_ms"], latency["total_ms"],
                )
                _diag(
                    "chunk_out",
                    session=session_id,
                    seq=client_seq,
                    mode="diarization",
                    status="ok",
                    reason=None,
                    speaker=top_speaker,
                    src=top_source,
                    tgt=top_target,
                    enriched_segments=len(enriched_segments),
                    has_audio=audio_b64 is not None,
                    stt_ms=latency["stt_ms"],
                    translate_ms=latency["translate_ms"],
                    tts_ms=latency["tts_ms"],
                    total_ms=latency["total_ms"],
                )
                return JSONResponse(
                    _envelope(
                        session_id, client_seq, "ok",
                        text=top_text,
                        translated=top_translated,
                        source_language=top_source,
                        target_language=top_target,
                        speaker=top_speaker,
                        speaker_reason="diarization mode — segment 단위 화자/언어 분류",
                        speaker_confidence=top_conf,
                        segments=enriched_segments,
                        latency=latency,
                        audio_base64=audio_b64,
                    ),
                    status_code=200,
                )

            # ---- 3. 환각/빈 응답 필터 ----
            # normal mode 의 pending 버퍼가 살아 있으면 빈/환각 chunk 는 그저 침묵 구간으로
            # 보고 pending 을 유지한다. 그렇지 않으면 기존과 동일 처리.
            if not stt_text or is_hallucination(stt_text):
                log.info(
                    "[ems_realtime] skipped empty/hallucinated session=%s seq=%s text=%r "
                    "pending_alive=%s",
                    session_id, client_seq, stt_text,
                    sess.pending_text is not None,
                )
                latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                # pending 이 너무 오래 보관되어 있으면 강제 commit 으로 넘긴다 (확정 처리).
                # 아니면 그냥 skipped 로 응답하고 pending 은 다음 chunk 때까지 보관.
                _threshold_sec = _force_commit_threshold_sec()
                if (
                    mode != "diarization"
                    and EMS_REALTIME_PENDING_ENABLED
                    and sess.pending_text
                    and sess.pending_age_sec() >= _threshold_sec
                ):
                    # 만료된 pending 을 강제 commit — 비어 있는 새 chunk 대신 pending 의
                    # 텍스트로 일반 흐름을 진행한다.
                    _pending_age_ms = int(sess.pending_age_sec() * 1000)
                    _pending_chars = len(sess.pending_text)
                    stt_text = sess.pending_text
                    stt_lang = stt_lang or sess.pending_lang
                    log.info(
                        "[ems_realtime] pending buffer aged out (%.2fs >= %.2fs) — "
                        "force commit session=%s first_seq=%s text=%r",
                        sess.pending_age_sec(), _threshold_sec, session_id,
                        sess.pending_first_seq, stt_text,
                    )
                    _diag(
                        "force_commit",
                        session=session_id,
                        seq=client_seq,
                        force_commit_reason="timeout",
                        branch="empty-or-hallucinated",
                        pending_age_ms=_pending_age_ms,
                        pending_text_chars=_pending_chars,
                        pending_first_seq=sess.pending_first_seq,
                        threshold_sec=_threshold_sec,
                    )
                    _diag(
                        "empty_hallucination_branch",
                        session=session_id,
                        seq=client_seq,
                        action="force-commit-aged-pending",
                        pending_age_ms=_pending_age_ms,
                        pending_text_head=_text_head(sess.pending_text),
                    )
                    sess.clear_pending()
                    force_commit_this_round = True
                    # fall through to dedup/overlap/classify.
                else:
                    _diag(
                        "empty_hallucination_branch",
                        session=session_id,
                        seq=client_seq,
                        action="skip",
                        pending_alive=sess.pending_text is not None,
                        pending_age_ms=int(sess.pending_age_sec() * 1000),
                        text_head=_text_head(stt_text),
                    )
                    _diag(
                        "chunk_out",
                        session=session_id,
                        seq=client_seq,
                        mode=mode,
                        status="skipped",
                        reason="stt-empty-or-hallucinated",
                        pending_alive=sess.pending_text is not None,
                        total_ms=latency["total_ms"],
                        stt_ms=latency["stt_ms"],
                    )
                    return JSONResponse(
                        _envelope(
                            session_id, client_seq, "skipped",
                            text=stt_text, reason="stt-empty-or-hallucinated",
                            latency=latency,
                        ),
                        status_code=200,
                    )

            # ---- 3.5. normal-mode pending 버퍼 머지 ----
            # 직전 chunk(들)에서 fragment 로 보관된 텍스트가 있으면 새 STT 결과 앞에 붙여
            # 통합 텍스트로 다시 판정한다. 합친 결과가 여전히 fragment 이고 버퍼 나이가
            # 만료 임계 이내면 status="skipped" reason="need-more-audio" 로 응답하고
            # pending 을 유지한다. 만료를 넘었거나 confident 가 되면 통합 텍스트로 일반
            # 흐름(dedup/overlap/classify/translate/TTS) 을 진행한다.
            pending_merged_this_round = False
            if mode != "diarization" and EMS_REALTIME_PENDING_ENABLED:
                _threshold_sec = _force_commit_threshold_sec()
                # [Phase A diag] pending 머지 단계 진입 — 머지 전 상태를 그대로 찍는다.
                _diag(
                    "pending_merge_enter",
                    session=session_id,
                    seq=client_seq,
                    pending_text_head=_text_head(sess.pending_text),
                    pending_age_ms=int(sess.pending_age_sec() * 1000),
                    pending_first_seq=sess.pending_first_seq,
                    pending_lang=sess.pending_lang,
                    new_text_head=_text_head(stt_text),
                    threshold_sec=_threshold_sec,
                )
                if sess.pending_text and sess.pending_age_sec() < _threshold_sec:
                    merged = (sess.pending_text + " " + stt_text).strip()
                    # 너무 길어지면 안전 한도에서 잘라 commit — 무한 누적 방지.
                    if len(merged) > EMS_REALTIME_PENDING_MAX_TEXT_CHARS:
                        _pending_age_ms = int(sess.pending_age_sec() * 1000)
                        log.info(
                            "[ems_realtime] pending buffer chars cap reached — force commit "
                            "session=%s chars=%d",
                            session_id, len(merged),
                        )
                        stt_text = merged
                        stt_lang = stt_lang or sess.pending_lang
                        _diag(
                            "force_commit",
                            session=session_id,
                            seq=client_seq,
                            force_commit_reason="length-cap",
                            branch="merge",
                            pending_age_ms=_pending_age_ms,
                            pending_text_chars=len(stt_text),
                            pending_first_seq=sess.pending_first_seq,
                        )
                        _diag(
                            "pending_merge",
                            session=session_id,
                            seq=client_seq,
                            action="force-commit-len-cap",
                            merged_len=len(stt_text),
                            merged_head=_text_head(stt_text),
                        )
                        sess.clear_pending()
                        force_commit_this_round = True
                    else:
                        stt_text = merged
                        stt_lang = stt_lang or sess.pending_lang
                        pending_merged_this_round = True
                        _diag(
                            "pending_merge",
                            session=session_id,
                            seq=client_seq,
                            action="merged",
                            merged_len=len(stt_text),
                            merged_head=_text_head(stt_text),
                        )
                elif sess.pending_text:
                    # 보관 만료 — pending 강제 commit 후 새 stt_text 앞에 prepend.
                    _pending_age_ms = int(sess.pending_age_sec() * 1000)
                    _pending_chars = len(sess.pending_text)
                    log.info(
                        "[ems_realtime] pending buffer aged out before merge (%.2fs >= %.2fs) — "
                        "force commit session=%s first_seq=%s",
                        sess.pending_age_sec(), _threshold_sec, session_id,
                        sess.pending_first_seq,
                    )
                    stt_text = (sess.pending_text + " " + stt_text).strip()
                    stt_lang = stt_lang or sess.pending_lang
                    _diag(
                        "force_commit",
                        session=session_id,
                        seq=client_seq,
                        force_commit_reason="timeout",
                        branch="merge",
                        pending_age_ms=_pending_age_ms,
                        pending_text_chars=_pending_chars,
                        pending_first_seq=sess.pending_first_seq,
                        threshold_sec=_threshold_sec,
                    )
                    _diag(
                        "pending_merge",
                        session=session_id,
                        seq=client_seq,
                        action="force-commit-aged",
                        merged_len=len(stt_text),
                        merged_head=_text_head(stt_text),
                    )
                    sess.clear_pending()
                    force_commit_this_round = True
                else:
                    _diag(
                        "pending_merge",
                        session=session_id,
                        seq=client_seq,
                        action="no-pending",
                    )

                # 합친(또는 새) 텍스트가 여전히 fragment 면 다음 chunk 를 기다린다.
                lang_guess_for_frag = stt_lang or detect_language_from_text(stt_text)
                # [Phase A diag] fragment 판정 결과 (단어수/heuristic 결과 포함).
                _fragment_word_count = text_word_count(stt_text)
                _fragment_has_term = has_sentence_terminator(stt_text)
                _fragment_has_emerg = has_emergency_signal(stt_text, lang_guess_for_frag)
                _is_frag = is_incomplete_fragment(stt_text, lang_guess_for_frag)
                _diag(
                    "fragment_decision",
                    session=session_id,
                    seq=client_seq,
                    text_head=_text_head(stt_text),
                    word_count=_fragment_word_count,
                    has_terminator=_fragment_has_term,
                    has_emergency=_fragment_has_emerg,
                    lang_guess=lang_guess_for_frag,
                    is_fragment=_is_frag,
                    force_commit_already=force_commit_this_round,
                )
                # 변경 2 — 이 chunk 에서 이미 force-commit 이 발동되었다면 (length-cap
                # 또는 timeout), fragment 라도 재버퍼링하지 않고 즉시 일반 흐름으로
                # 떠넘긴다. "무한 pending 금지" 의 핵심 — 같은 chunk 안에서 flush 가
                # 다시 fragment 로 잡혀 새 pending 을 만드는 사이클을 끊는다.
                if _is_frag and not force_commit_this_round:
                    if sess.pending_text is None:
                        sess.pending_first_seq = client_seq
                        sess.pending_started_at = time.perf_counter()
                    sess.pending_text = stt_text
                    if lang_guess_for_frag and lang_guess_for_frag != "unknown":
                        sess.pending_lang = lang_guess_for_frag
                    age_ms = int(sess.pending_age_sec() * 1000)
                    latency["buffer_ms"] = age_ms
                    latency["total_ms"] = int(
                        (time.perf_counter() - t_start) * 1000
                    )
                    log.info(
                        "[ems_realtime] pending fragment session=%s seq=%s first_seq=%s "
                        "age=%dms text=%r",
                        session_id, client_seq, sess.pending_first_seq, age_ms,
                        stt_text,
                    )
                    _diag(
                        "chunk_out",
                        session=session_id,
                        seq=client_seq,
                        mode=mode,
                        status="skipped",
                        reason="need-more-audio",
                        pending_first_seq=sess.pending_first_seq,
                        buffer_ms=age_ms,
                        total_ms=latency["total_ms"],
                        stt_ms=latency["stt_ms"],
                    )
                    return JSONResponse(
                        _envelope(
                            session_id, client_seq, "skipped",
                            text=stt_text, reason="need-more-audio",
                            source_language=(
                                lang_guess_for_frag
                                if lang_guess_for_frag and lang_guess_for_frag != "unknown"
                                else "unknown"
                            ),
                            latency=latency,
                        ),
                        status_code=200,
                    )

                # confident OR force-committed — pending 정리 (idempotent).
                if pending_merged_this_round:
                    log.info(
                        "[ems_realtime] pending buffer confident after merge — commit "
                        "session=%s first_seq=%s text=%r",
                        session_id, sess.pending_first_seq, stt_text,
                    )
                    _diag(
                        "commit_reason",
                        session=session_id,
                        seq=client_seq,
                        reason="confident-after-merge",
                        first_seq=sess.pending_first_seq,
                        text_head=_text_head(stt_text),
                    )
                if force_commit_this_round and _is_frag:
                    _diag(
                        "commit_reason",
                        session=session_id,
                        seq=client_seq,
                        reason="force-commit-still-fragment",
                        text_head=_text_head(stt_text),
                    )
                sess.clear_pending()

            # ---- 4. 세션 dedup (정규화 일치) ----
            norm = normalize_for_dedup(stt_text)
            # [Phase A diag] dedup 비교 대상 미리보기.
            _diag(
                "dedup_check",
                session=session_id,
                seq=client_seq,
                norm_head=_text_head(norm),
                recent_seqs=[s for s, _, _ in sess.recent_texts],
                recent_count=len(sess.recent_texts),
            )
            for prev_seq, prev_text, prev_norm in sess.recent_texts:
                if prev_norm == norm:
                    log.info(
                        "[ems_realtime] skipped duplicate of seq=%s session=%s",
                        prev_seq, session_id,
                    )
                    latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                    _diag(
                        "dedup_decision",
                        session=session_id,
                        seq=client_seq,
                        action="duplicate",
                        matched_seq=prev_seq,
                        matched_head=_text_head(prev_text),
                    )
                    _diag(
                        "chunk_out",
                        session=session_id,
                        seq=client_seq,
                        mode=mode,
                        status="skipped",
                        reason=f"duplicate-of-{prev_seq}",
                        total_ms=latency["total_ms"],
                        stt_ms=latency["stt_ms"],
                    )
                    return JSONResponse(
                        _envelope(
                            session_id, client_seq, "skipped",
                            text=stt_text,
                            reason=f"duplicate-of-{prev_seq}",
                            latency=latency,
                        ),
                        status_code=200,
                    )
            _diag(
                "dedup_decision",
                session=session_id,
                seq=client_seq,
                action="no-match",
            )

            # ---- 5. 직전 chunk와 끝-앞 overlap trim ----
            text = stt_text
            overlap_removed = ""
            if sess.recent_texts:
                _, last_text, _ = sess.recent_texts[-1]
                stripped, removed = strip_overlap_from_prev(last_text, stt_text)
                if removed:
                    stripped_norm = normalize_for_dedup(stripped)
                    if len(stripped_norm) < 2:
                        latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                        _diag(
                            "overlap_decision",
                            session=session_id,
                            seq=client_seq,
                            action="overlap-empty",
                            prev_tail_head=_text_head(last_text[-_DIAG_TEXT_HEAD:]),
                            removed_head=_text_head(removed),
                            stripped_len=len(stripped),
                        )
                        _diag(
                            "chunk_out",
                            session=session_id,
                            seq=client_seq,
                            mode=mode,
                            status="skipped",
                            reason="overlap-empty",
                            total_ms=latency["total_ms"],
                            stt_ms=latency["stt_ms"],
                        )
                        return JSONResponse(
                            _envelope(
                                session_id, client_seq, "skipped",
                                text=stt_text, reason="overlap-empty",
                                latency=latency,
                            ),
                            status_code=200,
                        )
                    text = stripped
                    overlap_removed = removed
                    _diag(
                        "overlap_decision",
                        session=session_id,
                        seq=client_seq,
                        action="stripped",
                        removed_head=_text_head(removed),
                        new_text_head=_text_head(text),
                    )
                else:
                    _diag(
                        "overlap_decision",
                        session=session_id,
                        seq=client_seq,
                        action="no-overlap",
                    )
            else:
                _diag(
                    "overlap_decision",
                    session=session_id,
                    seq=client_seq,
                    action="empty-recent-texts",
                )

            # ---- 6. 언어 + 역할 ----
            lang = stt_lang or detect_language_from_text(text)
            classification = classify_speaker(text, lang, sess)
            speaker = classification["speaker"]
            source_language = classification["source_language"]
            target_language = classification["target_language"]
            if speaker == "caller" and source_language in LANG_CODES:
                sess.register_caller_language(source_language)

            # 확정된 발화만 dedup 히스토리에 기록.
            sess.recent_texts.append(
                (client_seq, text, normalize_for_dedup(text))
            )
            _diag(
                "classify_decision",
                session=session_id,
                seq=client_seq,
                detected_language=lang,
                speaker=speaker,
                src=source_language,
                tgt=target_language,
                confidence=classification.get("confidence"),
                reason_head=_text_head(classification.get("reason") or ""),
                committed_text_head=_text_head(text),
                overlap_removed_head=_text_head(overlap_removed),
                sess_recent_after=len(sess.recent_texts),
            )

            # ---- 7. 번역/TTS skip 조건 ----
            if (
                speaker in ("unknown", "interpreter")
                or target_language == "unknown"
                or target_language not in LANG_CODES
            ):
                latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                log.info(
                    "[ems_realtime] ok no-translate session=%s seq=%s speaker=%s reason=%s",
                    session_id, client_seq, speaker, classification["reason"],
                )
                # force-commit-timeout 이 발생했지만 target_language=unknown 같은
                # 사유로 번역까지는 못 가는 경우에도, 진단 신호로 force-commit-timeout
                # 을 reason 에 노출해 프론트의 listening placeholder 가 정상 해소되게 한다.
                if force_commit_this_round:
                    _no_tr_reason = "force-commit-timeout"
                elif target_language == "unknown":
                    _no_tr_reason = "no-translation-target"
                else:
                    _no_tr_reason = None
                _diag(
                    "chunk_out",
                    session=session_id,
                    seq=client_seq,
                    mode=mode,
                    status="ok",
                    reason=_no_tr_reason or "speaker-skip",
                    force_commit=force_commit_this_round,
                    speaker=speaker,
                    src=source_language,
                    tgt=target_language,
                    has_audio=False,
                    total_ms=latency["total_ms"],
                    stt_ms=latency["stt_ms"],
                )
                return JSONResponse(
                    _envelope(
                        session_id, client_seq, "ok",
                        text=text,
                        translated="",
                        source_language=source_language,
                        target_language=target_language,
                        speaker=speaker,
                        speaker_reason=classification["reason"],
                        speaker_confidence=classification["confidence"],
                        segments=segments,
                        latency=latency,
                        reason=_no_tr_reason,
                    ),
                    status_code=200,
                )

            # ---- 8. 번역 ----
            # 운영팀(주무관) 안내 message 형태:
            #   system: "You are a real-time interpreter. Output only the translation."
            #   user  : "{source_text}"
            # 본 라우터는 caller↔operator 방향이 동적으로 바뀌므로 system 한 줄에 target
            # 언어를 명시해 방향을 고정한다. user는 원문만 — 메타 라벨/지시 없음.
            target_label = LANGUAGE_LABEL_EN.get(target_language, target_language)
            sys_prompt = (
                f"You are a real-time interpreter. "
                f"Translate the user's message into {target_label}. "
                f"Output only the translation."
            )
            usr_prompt = text

            t0 = time.perf_counter()
            try:
                translated = await call_translate(
                    client, sys_prompt, usr_prompt,
                    target_lang=target_language,
                    source_lang=source_language,
                )
            except LLMAuthMissing:
                # API 키가 환경에 없는 경우 — 외부 호출 시도조차 하지 않고 즉시 종료.
                # translated=""/audio_base64=null/status="error" 의 명시적 envelope으로 반환.
                latency["translate_ms"] = int((time.perf_counter() - t0) * 1000)
                latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                _diag(
                    "chunk_out",
                    session=session_id,
                    seq=client_seq,
                    mode=mode,
                    status="error",
                    reason="llm-auth-missing",
                    speaker=speaker,
                    src=source_language,
                    tgt=target_language,
                    total_ms=latency["total_ms"],
                    stt_ms=latency["stt_ms"],
                    translate_ms=latency["translate_ms"],
                )
                return JSONResponse(
                    _envelope(
                        session_id, client_seq, "error",
                        text=text,
                        translated="",
                        source_language=source_language,
                        target_language=target_language,
                        speaker=speaker,
                        speaker_reason=classification["reason"],
                        speaker_confidence=classification["confidence"],
                        segments=segments,
                        latency=latency,
                        audio_base64=None,
                        error="LLM API key missing",
                        reason="llm-auth-missing",
                    ),
                    status_code=200,
                )
            except LLMPostprocessEmpty as e:
                # LLM 응답에 텍스트는 있었지만 후처리(메타 제거 + target 스크립트 필터) 결과
                # 최종 번역 후보가 남지 않았다 — 사용자 spec의 전용 분기.
                latency["translate_ms"] = int((time.perf_counter() - t0) * 1000)
                latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                _diag(
                    "chunk_out",
                    session=session_id,
                    seq=client_seq,
                    mode=mode,
                    status="error",
                    reason="translation-postprocess-empty",
                    speaker=speaker,
                    src=source_language,
                    tgt=target_language,
                    total_ms=latency["total_ms"],
                    stt_ms=latency["stt_ms"],
                    translate_ms=latency["translate_ms"],
                )
                return JSONResponse(
                    _envelope(
                        session_id, client_seq, "error",
                        text=text,
                        translated="",
                        source_language=source_language,
                        target_language=target_language,
                        speaker=speaker,
                        speaker_reason=classification["reason"],
                        speaker_confidence=classification["confidence"],
                        segments=segments,
                        latency=latency,
                        audio_base64=None,
                        error="translate: no final translation extracted",
                        reason="translation-postprocess-empty",
                        debug_llm_shape=getattr(e, "shape", None),
                    ),
                    status_code=200,
                )
            except LLMEmptyResponse as e:
                # 401은 아니지만 응답 구조가 비어/예상 밖이라 번역 텍스트를 못 뽑은 경우.
                # 진단을 위해 envelope에 debug_llm_shape를 임시로 노출한다.
                # (민감정보는 포함하지 않음 — 응답 구조 metadata만.)
                latency["translate_ms"] = int((time.perf_counter() - t0) * 1000)
                latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                _diag(
                    "chunk_out",
                    session=session_id,
                    seq=client_seq,
                    mode=mode,
                    status="error",
                    reason="llm-empty-response",
                    speaker=speaker,
                    src=source_language,
                    tgt=target_language,
                    total_ms=latency["total_ms"],
                    stt_ms=latency["stt_ms"],
                    translate_ms=latency["translate_ms"],
                )
                return JSONResponse(
                    _envelope(
                        session_id, client_seq, "error",
                        text=text,
                        translated="",
                        source_language=source_language,
                        target_language=target_language,
                        speaker=speaker,
                        speaker_reason=classification["reason"],
                        speaker_confidence=classification["confidence"],
                        segments=segments,
                        latency=latency,
                        audio_base64=None,
                        error=f"translate: {e}",
                        reason="llm-empty-response",
                        debug_llm_shape=getattr(e, "shape", None),
                    ),
                    status_code=200,
                )
            except Exception as e:
                log.exception(
                    "[ems_realtime] translate failed session=%s seq=%s",
                    session_id, client_seq,
                )
                latency["translate_ms"] = int((time.perf_counter() - t0) * 1000)
                latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
                _diag(
                    "chunk_out",
                    session=session_id,
                    seq=client_seq,
                    mode=mode,
                    status="error",
                    reason="translate-exception",
                    exc=type(e).__name__,
                    speaker=speaker,
                    src=source_language,
                    tgt=target_language,
                    total_ms=latency["total_ms"],
                    stt_ms=latency["stt_ms"],
                    translate_ms=latency["translate_ms"],
                )
                return JSONResponse(
                    _envelope(
                        session_id, client_seq, "error",
                        text=text,
                        translated="",
                        source_language=source_language,
                        target_language=target_language,
                        speaker=speaker,
                        speaker_reason=classification["reason"],
                        speaker_confidence=classification["confidence"],
                        segments=segments,
                        latency=latency,
                        audio_base64=None,
                        error=f"translate: {e}",
                    ),
                    status_code=200,
                )
            latency["translate_ms"] = int((time.perf_counter() - t0) * 1000)
            _diag(
                "translate_done",
                session=session_id,
                seq=client_seq,
                translated_len=len(translated or ""),
                translated_head=_text_head(translated),
                translate_ms=latency["translate_ms"],
            )

            # ---- 9. TTS (실패해도 번역 결과는 살린다) ----
            audio_b64: Optional[str] = None
            tts_failed = False
            if translated:
                t0 = time.perf_counter()
                try:
                    tts_bytes = await call_tts(client, translated, target_language)
                    audio_b64 = base64.b64encode(tts_bytes).decode("ascii")
                    _diag(
                        "tts_done",
                        session=session_id,
                        seq=client_seq,
                        audio_bytes=len(tts_bytes),
                        tts_ms=int((time.perf_counter() - t0) * 1000),
                    )
                except Exception as e:
                    log.exception(
                        "[ems_realtime] TTS failed (non-fatal) session=%s seq=%s: %s",
                        session_id, client_seq, e,
                    )
                    tts_failed = True
                    _diag(
                        "tts_done",
                        session=session_id,
                        seq=client_seq,
                        action="failed",
                        exc=type(e).__name__,
                        tts_ms=int((time.perf_counter() - t0) * 1000),
                    )
                latency["tts_ms"] = int((time.perf_counter() - t0) * 1000)

            latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
            log.info(
                "[ems_realtime] ok session=%s seq=%s speaker=%s lang=%s→%s "
                "stt=%dms tr=%dms tts=%dms total=%dms",
                session_id, client_seq, speaker, source_language,
                target_language, latency["stt_ms"], latency["translate_ms"],
                latency["tts_ms"], latency["total_ms"],
            )
            # 최종 envelope.reason 우선순위:
            #   1) force-commit-timeout — pending 이 timeout 으로 flush 된 commit (진단 신호).
            #   2) overlap-removed:<tail> — 직전 chunk 와 겹치는 부분이 제거됨.
            # 둘 다 발생 시 force-commit-timeout 이 우선 (UI 의 "듣는 중" placeholder 해소
            # 신호로 더 중요). overlap 정보는 동일 chunk 의 overlapRemoved 필드에서 분리되어
            # 보존된다 (envelope 의 source/target 등은 그대로).
            if force_commit_this_round:
                _commit_reason: Optional[str] = "force-commit-timeout"
            elif overlap_removed:
                _commit_reason = f"overlap-removed:{overlap_removed}"
            else:
                _commit_reason = None
            _diag(
                "chunk_out",
                session=session_id,
                seq=client_seq,
                mode=mode,
                status="ok",
                reason=_commit_reason,
                force_commit=force_commit_this_round,
                speaker=speaker,
                src=source_language,
                tgt=target_language,
                has_audio=audio_b64 is not None,
                tts_failed=tts_failed,
                stt_ms=latency["stt_ms"],
                translate_ms=latency["translate_ms"],
                tts_ms=latency["tts_ms"],
                total_ms=latency["total_ms"],
            )
            return JSONResponse(
                _envelope(
                    session_id, client_seq, "ok",
                    text=text,
                    translated=translated,
                    source_language=source_language,
                    target_language=target_language,
                    speaker=speaker,
                    speaker_reason=classification["reason"],
                    speaker_confidence=classification["confidence"],
                    segments=segments,
                    latency=latency,
                    audio_base64=audio_b64,
                    reason=_commit_reason,
                ),
                status_code=200,
            )
    except Exception as e:
        # 기타 모든 예외는 envelope("error")로 — OWI 프로세스 보호.
        log.exception(
            "[ems_realtime] unhandled error session=%s seq=%s",
            session_id, client_seq,
        )
        latency["total_ms"] = int((time.perf_counter() - t_start) * 1000)
        _diag(
            "chunk_out",
            session=session_id,
            seq=client_seq,
            status="error",
            reason="unhandled-exception",
            exc=type(e).__name__,
            total_ms=latency["total_ms"],
        )
        return JSONResponse(
            _envelope(session_id, client_seq, "error",
                      latency=latency, error=str(e)),
            status_code=200,
        )
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except Exception:
                pass


@router.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "sessions": len(SESSIONS),
        "stt_url": STT_URL,
        "diarize_url": DIARIZE_URL,
        "llm_url": LLM_URL,
        "llm_model": LLM_MODEL,
        # LLM API 키가 환경에서 정상 로드되었는지 여부 (값 자체는 노출하지 않음).
        "llm_auth_configured": bool(LLM_API_KEY),
        "llm_auth_source": LLM_API_KEY_SOURCE,
        "llm_auth_required": LLM_AUTH_REQUIRED,
        "tts_url": TTS_URL,
        "ssl_verify": SSL_VERIFY,
    }


@router.post("/session/{session_id}/reset")
def reset_session(session_id: str) -> dict:
    SESSIONS.pop(session_id, None)
    return {"status": "ok", "session_id": session_id}


@router.get("/session/{session_id}")
def get_session_info(session_id: str) -> dict:
    sess = SESSIONS.get(session_id)
    if sess is None:
        return {"status": "empty", "session_id": session_id}
    return {
        "status": "ok",
        "session_id": session_id,
        "primary_caller_language": sess.primary_caller_language,
        "latest_caller_language": sess.latest_caller_language,
        "secondary_caller_languages": sess.secondary_caller_languages,
        "has_korean_caller": sess.has_korean_caller,
        "recent_text_count": len(sess.recent_texts),
    }
