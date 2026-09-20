/**
 * 应用入口(R03):先查认证状态——未登录渲染登录卡片,已登录渲染看板。
 * 会话过期时,任意 API 的 401 会触发整页重载回到登录门。
 */
import { useEffect, useState } from "react";
import MeetingBoardPage from "./pages/MeetingBoardPage";
import { AuthGate } from "./components/AuthGate";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((j) => setAuthed(!!j.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return <div className="grid min-h-screen place-items-center" style={{ background: "var(--color-canvas)" }} aria-busy="true" />;
  }
  if (!authed) return <AuthGate onLogin={() => setAuthed(true)} />;
  return <MeetingBoardPage />;
}
