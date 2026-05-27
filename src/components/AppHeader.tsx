import { useLocation, useNavigate } from "react-router-dom";
import { COLORS } from "../theme";

const NAV_ITEMS = [
  { path: "/", label: "업로드 전사" },
  { path: "/realtime", label: "실시간 통역" },
  { path: "/result", label: "결과 문서" },
];

/**
 * 모든 페이지 상단 공통 헤더.
 * 119 공공기관 느낌의 네이비 바 + 적색 강조선 + 현재 페이지 표시 내비게이션.
 */
function AppHeader({ subtitle }: { subtitle?: string }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <header
      style={{
        backgroundColor: COLORS.headerBg,
        borderBottom: `3px solid ${COLORS.red}`,
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          padding: "14px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              backgroundColor: COLORS.red,
              color: "#fff",
              fontWeight: 900,
              fontSize: 22,
              lineHeight: 1,
              borderRadius: 10,
              padding: "10px 12px",
              letterSpacing: 1,
            }}
          >
            119
          </div>
          <div>
            <div
              style={{
                color: "#ffffff",
                fontSize: 20,
                fontWeight: 800,
                letterSpacing: -0.3,
              }}
            >
              다국어 긴급구조 통역 시스템
            </div>
            <div
              style={{ color: COLORS.onDarkMuted, fontSize: 13, marginTop: 2 }}
            >
              {subtitle ?? "긴급구조 현장 통역 표준 지원 시스템"}
            </div>
          </div>
        </div>

        <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.path;
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                style={{
                  padding: "9px 16px",
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                  border: `1px solid ${active ? COLORS.red : COLORS.panelBorder}`,
                  backgroundColor: active ? COLORS.red : "transparent",
                  color: active ? "#ffffff" : COLORS.onDarkMuted,
                }}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

export default AppHeader;
