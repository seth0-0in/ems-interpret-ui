import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.JB_LLM_API_KEY;

  return {
    // 🔥 ai2.jb.go.kr/static/119/ 기준 asset 경로
    base: "/static/119/",

    plugins: [react()],

    server: {
      proxy: {
        /**
         * STT
         * 로컬 개발:
         *   /stt -> https://ai.jb.go.kr/stt/v1/audio/transcriptions
         *
         * 배포 환경:
         *   same-origin "/stt/v1/audio/transcriptions" 직접 호출
         */
        "/stt": {
          target: "https://ai.jb.go.kr",
          changeOrigin: true,
          secure: true,
          rewrite: () => "/stt/v1/audio/transcriptions",
        },

        /**
         * 번역 (LLM)
         * 로컬 개발:
         *   /translate -> https://ai.jb.go.kr/llm/v1/chat/completions
         *
         * 배포 환경:
         *   same-origin "/translate" 직접 호출
         */
        "/translate": {
          target: "https://ai.jb.go.kr",
          changeOrigin: true,
          secure: true,
          rewrite: () => "/llm/v1/chat/completions",

          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              // 로컬 개발용 Authorization header
              if (apiKey) {
                proxyReq.setHeader(
                  "Authorization",
                  `Bearer ${apiKey}`
                );
              }
            });
          },
        },

        /**
         * TTS
         * 로컬 개발:
         *   /tts -> https://ai.jb.go.kr/tts/v1/audio/speech
         *
         * 배포 환경:
         *   same-origin "/tts" 직접 호출
         */
        "/tts": {
          target: "https://ai.jb.go.kr",
          changeOrigin: true,
          secure: true,
          rewrite: () => "/tts/v1/audio/speech",
        },

        /**
         * 화자분리 STT (실험)
         * 로컬 개발:
         *   /diarize -> http://192.168.0.8:30203/v1/audio/transcriptions
         *
         * 배포 환경:
         *   same-origin "/diarize/v1/audio/transcriptions" 직접 호출
         *
         * 응답 형식:
         *   { text, segments: [{ speaker, start, end, text }] }
         */
        "/diarize": {
          target: "http://192.168.0.8:30203",
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/diarize/, ""),
        },
      },
    },
  };
});