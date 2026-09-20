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
const { createTask, loadTasks, runPipeline, UPLOADS, OUTPUTS, hasFfmpeg, probeAudioSeconds, readQuota } = require("./pipeline.cjs");

/** 每日转写免费额度基准(秒):讯飞 lfasr 普遍规则为每日约 2 小时,可在 data/settings.json
 *  加 "asrDailyQuotaSeconds": <秒> 覆盖;余量提示始终为本地估算,以讯飞控制台为准 */
const DEFAULT_DAILY_ASR_SECONDS = 2 * 3600;
function dailyAsrQuota() {
  const n = Number(loadSettings().asrDailyQuotaSeconds);
  return isFinite(n) && n > 0 ? n : DEFAULT_DAILY_ASR_SECONDS;
}

/** 任务附加运行时可用性:转写文本已落盘(可只重跑分析)/ 源文件还在(可整条重跑) */
function decorateTask(t) {
  return {
    ...t,
    hasTranscript: fs.existsSync(path.join(OUTPUTS, t.id, "transcript.json")),
    hasSource: !!t.fileName && fs.existsSync(path.join(UPLOADS, t.fileName)),
  };
}

const PORT = process.env.PORT || 8787;
const DIST = path.join(__dirname, "..", "dist");
const SECRET_FILE = path.join(__dirname, "meeting.secret.json");
const SETTINGS_FILE = path.join(__dirname, "data", "settings.json");   // 数据卷持久化

/* ── 设置(模型管理,模仿 ZCode:多条目 + 激活其一 + 连通性测试) ── */
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); }
  catch { return { activeId: null, models: [] }; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
function maskKey(k) {
  const s = String(k || "");
  if (s.length <= 8) return s ? "********" : "";
  return s.slice(0, 4) + "****" + s.slice(-4);
}
function activeLLM() {
  const st = loadSettings();
  const m = (st.models || []).find((x) => x.id === st.activeId);
  return (m && m.apiKey && m.model && m.baseUrl) ? { provider: m.provider, baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model } : null;
}
/** 生效 LLM 配置:设置里的激活模型优先,回退 meeting.secret.json(兼容既有部署) */
function loadSecret() {
  let s = {};
  if (fs.existsSync(SECRET_FILE)) {
    try { s = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8")); }
    catch (e) { console.error("[secret] 解析失败,按未配置处理:", e.message); }
  }
  const act = activeLLM();
  if (act) s.llm = act;
  return s;
}

const app = express();

/* 浏览器把中文文件名以 UTF-8 放进 multipart,busboy 默认按 Latin-1 解码 → 乱码。
   特征:文件名含 Latin-1 高位字符(如 è/ç/å);Latin-1 字节重读为 UTF-8 能还原则修复,
   还原失败(含替换符)或本就是正确 CJK/ASCII 则原样返回。 */
function fixMojibakeName(s) {
  if (!s || !/[\u0080-\u00FF]/.test(s)) return s;
  const fixed = Buffer.from(s, "latin1").toString("utf8");
  return fixed.includes("\uFFFD") ? s : fixed;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) => cb(null, fixMojibakeName(file.originalname).replace(/[\\/:*?"<>|]/g, "_")),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },  // 2GB 上限(讯飞单文件限 5 小时时长)
});

app.use(express.json());

/* ── API ── */
app.get("/api/meta", (_req, res) => {
  res.json({ ffmpeg: hasFfmpeg, iflytekConfigured: !!loadSecret().iflytek?.appId, llmConfigured: !!loadSecret().llm?.apiKey });
});

/* ── 设置:模型管理 ── */
app.get("/api/settings", (_req, res) => {
  const st = loadSettings();
  const secretLLM = (() => {
    if (!fs.existsSync(SECRET_FILE)) return null;
    try { const s = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8")); return s.llm || null; } catch { return null; }
  })();
  res.json({
    activeId: st.activeId || null,
    models: (st.models || []).map((m) => ({ ...m, apiKey: maskKey(m.apiKey) })),
    // 尚无设置条目时的现状提示:密钥文件里的 LLM(回退来源)
    fallback: secretLLM ? { provider: secretLLM.provider || "openai", baseUrl: secretLLM.baseUrl, model: secretLLM.model, apiKey: maskKey(secretLLM.apiKey) } : null,
  });
});

app.put("/api/settings", (req, res) => {
  const body = req.body || {};
  const prev = loadSettings();
  const prevById = new Map((prev.models || []).map((m) => [m.id, m]));
  const models = (Array.isArray(body.models) ? body.models : []).map((m) => {
    const old = prevById.get(m.id);
    // apiKey 含 **** 视为未修改,沿用旧值(前端拿到的是打码值)
    const key = (typeof m.apiKey === "string" && m.apiKey.includes("****") && old) ? old.apiKey : (m.apiKey || "");
    return {
      id: String(m.id || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
      name: String(m.name || "未命名模型").slice(0, 40),
      provider: m.provider === "anthropic" ? "anthropic" : "openai",
      baseUrl: String(m.baseUrl || "").trim(),
      model: String(m.model || "").trim(),
      apiKey: key,
    };
  });
  const activeId = models.some((m) => m.id === body.activeId) ? body.activeId : (models[0]?.id || null);
  saveSettings({ activeId, models });
  res.json({ ok: true, activeId, count: models.length });
});

app.post("/api/settings/test", async (req, res) => {
  const body = req.body || {};
  let cfg = null;
  if (body.id) {
    cfg = (loadSettings().models || []).find((m) => m.id === body.id) || null;
  } else if (body.entry && !String(body.entry.apiKey || "").includes("****")) {
    cfg = body.entry;    // 表单直测(要求已填明文 key)
  }
  if (!cfg || !cfg.baseUrl || !cfg.model || !cfg.apiKey) {
    return res.status(400).json({ ok: false, message: "配置不完整(需要 baseUrl / model / apiKey;若未修改密钥请使用已保存条目的测试)" });
  }
  const base = String(cfg.baseUrl).replace(/\/$/, "");
  const provider = cfg.provider === "anthropic" ? "anthropic" : "openai";
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    let r;
    if (provider === "anthropic") {
      r = await fetch(`${base}/v1/messages`, {
        method: "POST", signal: ac.signal,
        headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: cfg.model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
      });
    } else {
      r = await fetch(`${base}/chat/completions`, {
        method: "POST", signal: ac.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
      });
    }
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (!r.ok) {
      const text = (await r.text()).slice(0, 200);
      return res.json({ ok: false, ms, message: `HTTP ${r.status}: ${text}` });
    }
    await r.json().catch(() => null);
    res.json({ ok: true, ms, message: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} 协议连通` });
  } catch (e) {
    const ms = Date.now() - t0;
    res.json({ ok: false, ms, message: e.name === "AbortError" ? "超时(15s)" : String(e.message).slice(0, 160) });
  }
});

app.get("/api/tasks", (_req, res) => res.json(loadTasks().map(decorateTask)));

app.get("/api/tasks/:id", (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  t ? res.json(decorateTask(t)) : res.status(404).json({ error: "task not found" });
});

app.post("/api/tasks", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "缺少文件字段 file" });
  const task = createTask(req.file.filename, req.file.size);
  runPipeline(task, loadSecret());   // 异步跑流水线,状态轮询看板自取
  res.status(201).json(task);
});

/* 整条重跑额度预览:本次音频时长 + 当日转写余量(本地估算,讯飞免费额度按每日 2 小时为基准) */
app.get("/api/tasks/:id/rerun-preview", async (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  const srcPath = path.join(UPLOADS, t.fileName || "");
  let audioSeconds = null;
  try { audioSeconds = await probeAudioSeconds(srcPath); }
  catch {
    audioSeconds = Number(t.audioSeconds) || null;   // 回退:转写时记录的时长
    if (!audioSeconds) return res.status(409).json({ error: "无法探测音频时长(源文件缺失或损坏)" });
  }
  const day = new Date().toISOString().slice(0, 10);
  const dailySeconds = dailyAsrQuota();
  const usedSeconds = readQuota(day);
  const freeSeconds = Math.max(0, Math.round((dailySeconds - usedSeconds) * 10) / 10);
  res.json({
    audioSeconds,
    usedSeconds: Math.round(usedSeconds * 10) / 10,
    dailySeconds,
    freeSeconds,
    enough: freeSeconds >= audioSeconds,
    mock: !loadSecret().iflytek?.appId,   // 讯飞未配置 = 模拟转写,不消耗额度
  });
});

/* scope=analyze:复用已落盘转写文本,只重跑 AI 分析+生成纪要(不耗讯飞额度)
   scope=all(默认):整条重跑(重新转写) */
app.post("/api/tasks/:id/restart", (req, res) => {
  const tasks = loadTasks();
  const t = tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  const scope = req.body?.scope === "analyze" ? "analyze" : "all";

  let transcript = null;
  if (scope === "analyze") {
    const tp = path.join(OUTPUTS, t.id, "transcript.json");
    if (!fs.existsSync(tp)) {
      return res.status(400).json({ error: "该任务没有已保存的转写文本,请用「整条重跑」" });
    }
    try { transcript = JSON.parse(fs.readFileSync(tp, "utf8")); }
    catch { return res.status(500).json({ error: "转写文本读取失败,请用「整条重跑」" }); }
    if (!transcript || !transcript.text || String(transcript.text).length < 10) {
      return res.status(400).json({ error: "已存转写文本为空,请用「整条重跑」" });
    }
  }

  t.steps.forEach((s) => { s.status = "pending"; s.note = ""; s.startedAt = null; s.finishedAt = null; });
  t.stage = "queued";
  t.error = "";
  fs.writeFileSync(path.join(__dirname, "data", "tasks.json"), JSON.stringify(tasks, null, 2));
  runPipeline(t, loadSecret(), transcript ? { transcript } : {});
  res.json(t);
});

/* ── 纪要下载(Attachment,文件名用会议标题) ── */
app.get("/api/tasks/:id/minutes/download", (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  if (!t || !t.minutesFile) return res.status(404).json({ error: "minutes not found" });
  const p = path.join(OUTPUTS, t.minutesFile);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "minutes file missing" });
  const safeName = String(t.title || t.id).replace(/[\\\/:*?"<>|]/g, "_");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename="${t.id}.html"; filename*=UTF-8''${encodeURIComponent(safeName + ".html")}`);
  fs.createReadStream(p).pipe(res);
});

/* ── 任务删除(连带纪要产物目录与上传源文件;二次确认由前端承担) ── */
app.delete("/api/tasks/:id", (req, res) => {
  const tasks = loadTasks();
  const i = tasks.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "task not found" });
  const [t] = tasks.splice(i, 1);
  fs.writeFileSync(path.join(__dirname, "data", "tasks.json"), JSON.stringify(tasks, null, 2));
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };
  if (t.minutesFile) rm(path.join(OUTPUTS, t.minutesFile.split("/")[0]));
  if (t.fileName) rm(path.join(UPLOADS, t.fileName));
  res.json({ ok: true, id: t.id });
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
