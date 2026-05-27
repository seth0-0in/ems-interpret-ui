import { BrowserRouter, Routes, Route } from "react-router-dom";
import UploadPage from "./pages/UploadPage";
import RealtimePage from "./pages/RealtimePage";
import ResultPage from "./pages/ResultPage";

// Vite base("/static/119/")에서 동작하도록 Router에 basename을 맞춰준다.
// 새로고침 시 ai2.jb.go.kr/static/119/realtime 같은 경로가 올바르게 라우팅된다.
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

function App() {
  return (
    <BrowserRouter basename={ROUTER_BASENAME}>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/realtime" element={<RealtimePage />} />
        <Route path="/result" element={<ResultPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;