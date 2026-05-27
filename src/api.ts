// 백엔드 API URL 헬퍼.
//
// 배경:
//   Vite config 의 base 가 "/static/119/" 로 설정되어 빌드된 자산(JS/CSS/VAD 모델/
//   onnx wasm 등)은 그 prefix 아래에서 서빙된다. 그러나 **백엔드 API endpoint 는
//   서버 루트의 /api/... 에 마운트**되어 있다 (운영 ai2.jb.go.kr 에서 curl 로 확인:
//   POST /api/119/realtime/process → 422 (라우트 살아있음), POST /static/119/api/...
//   → 404). 정적 자산 base 와 API base 는 서로 다른 축이라는 뜻이다.
//
// 규칙:
//   - 자산(예: VAD 모델 / onnxruntime wasm) 은 import.meta.env.BASE_URL 을 그대로 쓴다
//     (예: `${BASE_URL}vad/`). 정적 자산 base 라서 그 prefix 가 있어야 한다.
//   - API 호출은 모두 apiUrl("/api/...") 로 감싼다. helper 가 "/api/..." 입력은
//     루트 origin-relative 로 그대로 반환하며 BASE_URL prefix 를 붙이지 않는다.
//     이렇게 해야 dev (localhost) / preview / 운영 (ai2.jb.go.kr) 어디서든 동일하게
//     `/api/119/realtime/process` 로 나간다.
//   - 도메인을 하드코딩하지 않는다 — 브라우저가 현재 origin 을 자동으로 붙인다.
//
// (이전 구현은 BASE_URL 을 모든 경로에 붙여 운영에서 "/static/119/api/..." 404 를
// 만들었다. 이번 수정으로 그 mismatch 를 helper 차원에서 차단한다.)

const BASE: string = import.meta.env.BASE_URL || "/";

/**
 * 입력 path 의 종류:
 *   "/api/..."        → 백엔드 API. 서버 루트 절대경로로 반환. BASE_URL prefix 미적용.
 *                       (운영 ai2.jb.go.kr 의 백엔드 라우트가 루트에 마운트되어 있어
 *                       정적 자산 base 와 분리되어야 한다.)
 *   "http(s)://..."   → 외부 게이트웨이 절대 URL. 그대로 통과.
 *   그 외 (예: "vad/") → 정적 자산 후보. 기존 동작대로 BASE_URL 을 prefix 한다.
 *                       (현 시점에 이 분기로 들어오는 호출은 없다 — 자산은 모두
 *                        호출부에서 BASE_URL 을 직접 조합한다.)
 */
export function apiUrl(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    return BASE;
  }
  // 절대 URL 은 그대로.
  if (/^https?:\/\//i.test(path)) return path;

  // 선행 슬래시 정규화.
  const withLead = path.startsWith("/") ? path : "/" + path;

  // /api/... 는 항상 서버 루트 origin-relative — 정적 자산 base 와 분리.
  if (/^\/api(\/|$)/i.test(withLead)) {
    return withLead;
  }

  // 나머지(자산 후보) — 기존 BASE_URL prefix 동작 유지. 단, 이미 BASE 로 시작하면
  // 이중 prefix 방지.
  const trimmed = withLead.replace(/^\/+/, "");
  const baseNoLead = BASE.replace(/^\/+/, ""); // "static/119/" 또는 "" (BASE="/")
  if (baseNoLead && trimmed.startsWith(baseNoLead)) {
    return "/" + trimmed;
  }
  return BASE + trimmed;
}
