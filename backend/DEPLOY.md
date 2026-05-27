# 119 Realtime 백엔드 — 배포 & 테스트 가이드

새 라우터 `ems_realtime.py`를 `ai2` Docker 컨테이너에 배치하고, `main.py`에 include
줄을 추가한 다음, 서버를 재시작하고 curl로 검증하는 절차입니다.

## 0. 준비

이 디렉터리(`backend/`)에는 두 개의 산출물이 있습니다.

| 파일 | 컨테이너 내 위치 |
|------|------------------|
| `ems_realtime.py` | `/app/backend/open_webui/routers/ems_realtime.py` |
| `main.py.patch.md` | 참조용 — 컨테이너 내 `main.py`에 직접 적용 |

`ai2` 컨테이너 이름은 환경에 따라 다를 수 있으니 `docker ps`로 확인하세요. 이 문서에서는
편의상 `${EMS_CONTAINER}` 변수로 부릅니다.

```bash
# 컨테이너 이름 확인
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# 이후 명령에서 쓸 변수 (호스트 셸에서)
export EMS_CONTAINER=ai2-openwebui   # 실제 이름으로 바꿔주세요
```

## 1. 라우터 파일 컨테이너에 복사

호스트(이 Windows 머신)에서:

```powershell
# PowerShell
docker cp "C:\Users\User\OneDrive\바탕 화면\ems-interpret-ui\backend\ems_realtime.py" `
  ${env:EMS_CONTAINER}:/app/backend/open_webui/routers/ems_realtime.py
```

```bash
# Linux/macOS 셸에서 동일 작업
docker cp ./backend/ems_realtime.py \
  $EMS_CONTAINER:/app/backend/open_webui/routers/ems_realtime.py
```

복사 확인:

```bash
docker exec $EMS_CONTAINER ls -la /app/backend/open_webui/routers/ems_realtime.py
```

## 2. `main.py`에 router include 1회 추가

컨테이너 안으로 들어가서:

```bash
docker exec -it $EMS_CONTAINER bash
cd /app/backend/open_webui
cp main.py main.py.bak.$(date +%s)        # 원본 백업 (필수)
vi main.py                                 # 또는 nano
```

`main.py.patch.md`의 try/except 블록을 다른 `app.include_router(...)` 줄들 바로 아래에
복사해 붙여 넣습니다. **prefix는 router 안에 이미 박혀 있으므로 추가 지정 금지.**

문법 검증:

```bash
docker exec $EMS_CONTAINER python -c "import ast; ast.parse(open('/app/backend/open_webui/main.py').read())"
# (출력 없이 종료되면 OK)
```

## 3. 컨테이너 재시작

OWI 핵심 API와 분리돼 있지만, FastAPI 라우팅 등록을 반영하려면 프로세스 재시작이 필요합니다.

```bash
# 컨테이너 단위 재시작 (가장 안전)
docker restart $EMS_CONTAINER

# 로그 확인 (다른 터미널에서)
docker logs -f --tail=200 $EMS_CONTAINER
```

OWI는 기본적으로 uvicorn으로 부팅됩니다. 부팅 로그에 `ems_realtime`이 import 실패한
흔적이 없는지(`ems_realtime router import failed` 메시지) 확인하세요.

> **참고**: 재시작이 부담스러우면 `--reload` 옵션이 켜진 dev 빌드에서는 파일 변경만으로도
> 자동 적용됩니다. 다만 `main.py`가 바뀐 경우엔 항상 재시작해야 합니다.

## 4. 라우터 동작 확인 (curl)

### 4-1. health 체크

```bash
curl -sS http://ai2.jb.go.kr/api/119/realtime/health | jq
# 또는 컨테이너 내부 포트로
curl -sS http://localhost:8080/api/119/realtime/health | jq
```

응답 예:
```json
{
  "status": "ok",
  "sessions": 0,
  "stt_url": "https://ai.jb.go.kr/stt/v1/audio/transcriptions",
  "diarize_url": "http://192.168.0.8:30203/v1/audio/transcriptions",
  "llm_url": "https://ai.jb.go.kr/llm/v1/chat/completions",
  "tts_url": "https://ai.jb.go.kr/tts/v1/audio/speech"
}
```

### 4-2. 짧은 더미 오디오 → skipped 응답 확인

```bash
# 64바이트짜리 너무 짧은 더미 wav — MIN_AUDIO_BYTES 미만이라 STT 호출 없이 skipped
head -c 64 /dev/urandom > /tmp/tiny.wav

curl -sS -X POST http://ai2.jb.go.kr/api/119/realtime/process \
  -F "file=@/tmp/tiny.wav;type=audio/wav" \
  -F "session_id=test-session-1" \
  -F "client_seq=1" \
  -F "mode=normal" | jq
```

기대값: `"status": "skipped"`, `"reason": "audio-too-short"`.

### 4-3. 실제 한국어 발화 WAV로 정상 흐름 확인

테스트용 WAV가 있다면:

```bash
curl -sS -X POST http://ai2.jb.go.kr/api/119/realtime/process \
  -F "file=@./sample-ko.wav;type=audio/wav" \
  -F "session_id=test-session-2" \
  -F "client_seq=1" \
  -F "mode=normal" | jq '{
    status, text, translated, source_language, target_language,
    speaker, speaker_confidence, latency
  }'
```

기대값(예시):
```json
{
  "status": "ok",
  "text": "사람이 쓰러졌어요 빨리 와주세요",
  "translated": "",
  "source_language": "ko",
  "target_language": "unknown",
  "speaker": "caller",
  "speaker_confidence": 0.79,
  "latency": { "stt_ms": 420, "translate_ms": 0, "tts_ms": 0, "total_ms": 430 }
}
```
첫 chunk에서는 신고자 언어가 한국어로 감지될 뿐 target_language가 정해지지 않아
번역/TTS는 비어 있습니다. 다음 chunk가 영어로 들어오면 한국어로 번역돼 audio_base64까지
채워집니다.

### 4-4. 영어 신고자 발화 → 한국어 번역 + TTS

```bash
curl -sS -X POST http://ai2.jb.go.kr/api/119/realtime/process \
  -F "file=@./sample-en.wav;type=audio/wav" \
  -F "session_id=test-session-3" \
  -F "client_seq=1" \
  -F "mode=normal" | jq 'del(.audio_base64) + {audio_base64_len: (.audio_base64|length)}'
```

`status: "ok"`, `speaker: "caller"`, `source_language: "en"`, `target_language: "ko"`,
`translated`가 채워지고 `audio_base64_len`이 큰 값(보통 50KB 이상)이면 TTS까지 정상.

### 4-5. 화자분리 모드

```bash
curl -sS -X POST http://ai2.jb.go.kr/api/119/realtime/process \
  -F "file=@./sample.wav;type=audio/wav" \
  -F "session_id=test-session-4" \
  -F "client_seq=1" \
  -F "mode=diarization" | jq '{status, text, segments, latency}'
```

`segments` 배열에 `{speaker, start, end, text}` 가 들어옵니다.

### 4-6. 세션 상태 조회 / 리셋

```bash
curl -sS http://ai2.jb.go.kr/api/119/realtime/session/test-session-3 | jq
curl -sS -X POST http://ai2.jb.go.kr/api/119/realtime/session/test-session-3/reset | jq
```

## 5. 환경변수 override (선택)

다른 STT/LLM/TTS 엔드포인트를 쓰고 싶다면 컨테이너 환경에 다음을 넣어 재시작합니다.

```bash
EMS_STT_URL=...
EMS_STT_MODEL=cohere-transcribe
EMS_DIARIZE_URL=http://192.168.0.8:30203/v1/audio/transcriptions
EMS_LLM_URL=...
EMS_LLM_MODEL=Qwen3.5-397B-A17B-FP8
# LLM Authorization header에 들어갈 키. 코드에 하드코딩 금지.
# 조회 우선순위: EMS_LLM_API_KEY → JB_LLM_API_KEY → OPENAI_API_KEY
# 키 자체는 로그에 출력되지 않으며, /health 응답의 llm_auth_configured 로만 확인.
EMS_LLM_API_KEY=...
EMS_TTS_URL=...
EMS_TTS_MODEL=qwen3-tts
EMS_HTTP_TIMEOUT=60
EMS_MIN_AUDIO_BYTES=1024

# SSL 인증서 검증 — ai2 개발 컨테이너 내부에서 ai.jb.go.kr 호출이 사설 인증서를
# 거치는 경우가 있어 기본값 "false". 운영 인증서로 전환되면 "true"로 켤 것.
EMS_SSL_VERIFY=false
```

`/api/119/realtime/health` 응답의 `ssl_verify` 필드로 현재 적용 값을 확인할 수 있으며,
컨테이너 부팅 로그에 다음 한 줄이 찍힙니다.

```
[ems_realtime] SSL_VERIFY=false — 외부 HTTPS 호출 인증서 검증 비활성화 ...
```

## 6. 롤백

문제가 생기면 1단계 백업으로 즉시 되돌립니다.

```bash
docker exec $EMS_CONTAINER bash -c \
  "cd /app/backend/open_webui && cp main.py.bak.<timestamp> main.py && \
   rm -f /app/backend/open_webui/routers/ems_realtime.py"
docker restart $EMS_CONTAINER
```

## 7. 프론트엔드 연동(다음 단계 — 본 PR에는 포함하지 않음)

이번 단계는 백엔드 endpoint만 만드는 것이 목표입니다. 검증이 끝난 뒤
`RealtimePage.tsx`에서 `enterSttPipeline()` 경로를 `/api/119/realtime/process`로
교체하는 작업을 별도로 진행하세요.
