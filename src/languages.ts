/**
 * 업로드 전사 / 실시간 통역 화면이 공통으로 사용하는 언어 옵션.
 * - label: UI에 표시되는 한글 라벨
 * - value: STT/번역 API의 language 필드로 그대로 전달되는 언어 코드
 * 전북 외국인 주민 주요 국적 기준.
 */
export type LanguageOption = { value: string; label: string };

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "영어" },
  { value: "zh", label: "중국어" },
  { value: "ja", label: "일본어" },
  { value: "vi", label: "베트남어" },
  { value: "th", label: "태국어" },
  { value: "km", label: "캄보디아어" },
  { value: "ne", label: "네팔어" },
];

/** 언어 코드 → 한글 라벨 (옵션에 없으면 코드 그대로 반환) */
export function languageLabel(code: string): string {
  return LANGUAGE_OPTIONS.find((l) => l.value === code)?.label ?? code;
}
