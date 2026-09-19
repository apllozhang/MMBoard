/**
 * Symphony Console 后端 —— 会议纪要流水线服务
 * API:  POST /api/tasks(上传) · GET /api/tasks · GET /api/tasks/:id · POST /api/tasks/:id/restart
 * 静态: dist/(SPA) + /outputs/(纪要产物) —— 生产模式单容器单进程
 * 配置: meeting.secret.json(不入库) → { iflytek:{appId,apiKey,apiSecret}, llm:{baseUrl,apiKey,model} }
 */
"use strict";
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { createTask, loadTasks, runPipeline, UPLOADS, OUTPUTS, hasFfmpeg } = require("./pipeline.cjs");

const PORT = process.env.PORT || 8787;
const DIST = path.join(__dirname, "..", "dist");
const SECRET_FILE = path.join(__dirname, "meeting.secret.json");

function loadSecret() {
  if (!fs.existsSync(SECRET_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SECRET_FILE, "utf8")); }
  catch (e) { console.error("[secret] 解析失败,按未配置处理:", e.message); return {}; }
}

const app = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) => cb(null, file.originalname.replace(/[\\/:*?"<>|]/g, "_")),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },  // 2GB 上限(讯飞单文件限 5 小时时长)
});

app.use(express.json());

/* ── API ── */
app.get("/api/meta", (_req, res) => {
  res.json({ ffmpeg: hasFfmpeg, iflytekConfigured: !!loadSecret().iflytek?.appId, llmConfigured: !!loadSecret().llm?.apiKey });
});

app.get("/api/tasks", (_req, res) => res.json(loadTasks()));

app.get("/api/tasks/:id", (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  t ? res.json(t) : res.status(404).json({ error: "task not found" });
});

app.post("/api/tasks", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "缺少文件字段 file" });
  const task = createTask(req.file.filename, req.file.size);
  runPipeline(task, loadSecret());   // 异步跑流水线,状态轮询看板自取
  res.status(201).json(task);
});

app.post("/api/tasks/:id/restart", (req, res) => {
  const tasks = loadTasks();
  const t = tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  t.steps.forEach((s) => { s.status = "pending"; s.note = ""; s.startedAt = null; s.finishedAt = null; });
  t.stage = "queued";
  t.error = "";
  fs.writeFileSync(path.join(__dirname, "data", "tasks.json"), JSON.stringify(tasks, null, 2));
  runPipeline(t, loadSecret());
  res.json(t);
});

/* ── 纪要产物 ── */
app.use("/outputs", express.static(OUTPUTS, { extensions: ["html"] }));

/* ── SPA ── */
app.use(express.static(DIST));
app.get(/^\/(?!api|outputs).*/, (_req, res) => res.sendFile(path.join(DIST, "index.html")));

app.listen(PORT, () => {
  console.log(`[symphony-console] server on http://127.0.0.1:${PORT}`);
  console.log(`[symphony-console] ffmpeg=${hasFfmpeg ? "可用" : "未安装(视频不可处理,音频直传)"} 密钥=${fs.existsSync(SECRET_FILE) ? "已配置" : "未配置(mock 模式)"}`);
});
