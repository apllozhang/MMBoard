import React from "react";
import ReactDOM from "react-dom/client";
import MeetingBoardPage from "./pages/MeetingBoardPage";
import "./i18n";
import "./index.css";

/* 首帧前应用已保存主题(防闪烁) */
document.documentElement.classList.toggle("dark", localStorage.getItem("theme") === "dark");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MeetingBoardPage />
  </React.StrictMode>,
);
