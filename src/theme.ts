/**
 * 119 긴급구조 공공 서비스 공통 색상/스타일 토큰.
 * 어두운 네이비 배경 + 흰색 카드 + 강조색(긴급 적색 / 행정 네이비) 구성.
 */

export const COLORS = {
  // 페이지 / 헤더 (어두운 네이비)
  pageBg: "#0b1f3a",
  headerBg: "#0a1b34",
  // 어두운 보조 패널
  panelBg: "#102a4d",
  panelBorder: "#23446f",
  // 흰색 카드 / 행정 문서
  cardBg: "#ffffff",
  cardBorder: "#d3dbe7",
  track: "#eef1f6",
  // 텍스트
  ink: "#1f2a37",
  inkSoft: "#3f4856",
  inkMuted: "#717c8b",
  onDark: "#eef3fa",
  onDarkMuted: "#9db0ca",
  // 강조색
  red: "#d92d20",
  redDark: "#b21e13",
  redSoft: "#fdeceb",
  navy: "#1c4e8f",
  navyDark: "#143a6b",
  navySoft: "#e9f0f9",
  amber: "#b8730a",
  green: "#0f7b54",
  violet: "#6d44b8",
  slate: "#516175",
  // 발화자 구분 (신고자 = 적색 계열, 구급대원 = 네이비 계열)
  caller: "#c0392b",
  callerSoft: "#fbeceb",
  operator: "#1c4e8f",
  operatorSoft: "#e9f0f9",
} as const;

/** 흰색 카드 공통 스타일 */
export const whiteCard: React.CSSProperties = {
  backgroundColor: COLORS.cardBg,
  border: `1px solid ${COLORS.cardBorder}`,
  borderRadius: 14,
  padding: 22,
  boxShadow: "0 6px 22px rgba(5, 18, 40, 0.28)",
};

/** 카드 내부 섹션 제목 스타일 */
export const sectionHeading: React.CSSProperties = {
  margin: "0 0 14px",
  fontSize: 18,
  fontWeight: 800,
  color: COLORS.ink,
  display: "flex",
  alignItems: "center",
  gap: 8,
  borderLeft: `4px solid ${COLORS.red}`,
  paddingLeft: 10,
  lineHeight: 1.2,
};
