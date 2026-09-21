/**
 * Symphony Console 后端 —— 会议纪要流水线服务
 * API:  POST /api/tasks(上传) · GET /api/tasks · GET /api/tasks/:id · POST /api/tasks/:id/restart
 * 认证: 全部 /api 需登录(R03);会话为 HttpOnly Cookie,非 GET 请求要求 X-Requested-With 头(CSRF 防护)
 * 静态: 仅 dist/(SPA);纪要与转写产物一律走受认证保护的 /api/tasks/:id/minutes(R04)
 * 配置: meeting.secret.json(不入库;优先读数据卷内副本)→ { iflytek:{...}, llm:{...} }
 */
"use strict";
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const auth = require("./auth.cjs");
const { renderMinutes } = require("./minutes-template.cjs");
const { createTask, loadTasks, saveTasks, runPipeline, enqueuePipeline, recoverInterruptedTasks, queueDepth, QUEUE_CAPACITY,
        DATA, UPLOADS, OUTPUTS, TASKS_FILE, hasFfmpeg, probeAudioSeconds, readQuota, AUDIO_EXT, VIDEO_EXT } = require("./pipeline.cjs");
const { hasKeys } = require("./iflytek.cjs");
const { writeJsonAtomic, readJsonWithRecovery } = require("./persist.cjs");
const { assertLlmUrl } = require("./llm.cjs");

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
// R12:密钥优先读数据卷内副本(不进镜像);回退旧位置兼容既有部署
const SECRET_FILE = fs.existsSync(path.join(DATA, "meeting.secret.json"))
  ? path.join(DATA, "meeting.secret.json")
  : path.join(__dirname, "meeting.secret.json");
const SETTINGS_FILE = path.join(DATA, "settings.json");   // 数据卷持久化
const AUDIT_FILE = path.join(DATA, "audit.log");

/** 操作审计:登录/改密/重跑/删除/设置变更落一行(时间/IP/用户/动作/明细/结果) */
function audit(req, action, detail = "", ok = true) {
  // R03:清洗控制字符,防日志行伪造;仅用 socket 地址(未配置可信代理,不信任 X-Forwarded-For)
  const clean = (v) => String(v).replace(/[\r\n\t\u0000-\u001f]/g, " ").slice(0, 200);
  const user = clean(req.authUser || "anon");
  const line = `${new Date().toISOString()}\t${clean(req.ip || "-")}\t${user}\t${clean(action)}\t${clean(detail)}\t${ok ? "ok" : "fail"}\n`;
  try { fs.appendFileSync(AUDIT_FILE, line); } catch { /* best effort */ }
}

/** R05:本地 ASR 服务地址仅允许内网/本机(防 SSRF 探测公网或元数据端点) */
const PRIVATE_URL = /^https?:\/\/(localhost|\[::1\]|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/i;
const validLocalUrl = (u) => PRIVATE_URL.test(String(u || "").trim());

/** R05:测试类接口限流(每 IP 每分钟 6 次) */
const rateMap = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (rateMap.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { rateMap.set(key, arr); return false; }
  arr.push(now);
  rateMap.set(key, arr);
  return true;
}

/* ── 设置(模型管理,模仿 ZCode:多条目 + 激活其一 + 连通性测试) ── */
function loadSettings() {
  // R09:损坏时回退 .bak;两者皆坏抛错(绝不静默清空配置);ENOENT = 首次运行,返回空配置
  try { return readJsonWithRecovery(SETTINGS_FILE); }
  catch (e) {
    if (e.code === "ENOENT") return { activeId: null, models: [] };
    throw new Error(`设置数据不可读: ${e.message}`);
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  writeJsonAtomic(SETTINGS_FILE, s);
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
/** 生效 LLM/讯飞配置:设置里的激活模型与讯飞参数优先,回退 meeting.secret.json(兼容既有部署) */
function loadSecret() {
  let s = {};
  if (fs.existsSync(SECRET_FILE)) {
    try { s = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8")); }
    catch (e) { console.error("[secret] 解析失败,按未配置处理:", e.message); }
  }
  const st = loadSettings();
  const act = (st.models || []).find((x) => x.id === st.activeId);
  if (act && act.apiKey && act.model && act.baseUrl) {
    s.llm = { provider: act.provider, baseUrl: act.baseUrl, apiKey: act.apiKey, model: act.model,
              allowPrivate: !!st.allowPrivateLlmHosts };   // R05:内网 LLM 需显式放行
  }
  /* 转写通道:settings.asr 存在即生效(provider: iflytek | local);讯飞参数 settings 优先 */
  if (st.asr && st.asr.provider) s.asr = { provider: st.asr.provider, localUrl: st.asr.localUrl || "" };
  const ifly = st.iflytek && st.iflytek.appId ? st.iflytek : s.iflytek;
  if (ifly && ifly.appId) {
    s.iflytek = { appId: String(ifly.appId).trim(), apiKey: String(ifly.apiKey || "").trim(),
                  apiSecret: String(ifly.apiSecret || ifly.secretKey || "").trim() };
  }
  // R06 复审:mock 仅在显式演示开关下允许(MMB_DEMO=1 或配置 demo:true)
  if (process.env.MMB_DEMO === "1") {
    s.iflytek = { ...(s.iflytek || {}), demo: true };
    if (s.llm) s.llm.demo = true;
  }
  if (s.llm) s.llm.allowPrivate = !!st.allowPrivateLlmHosts;   // R05:回退路径同样受白名单开关控制
  return s;
}

/** 讯飞参数的"当前生效值":settings 里配置过用 settings,否则回退密钥文件(GET 打码与 PUT 打码保留的基准) */
function effectiveIflytek() {
  const st = loadSettings();
  if (st.iflytek && st.iflytek.appId) return st.iflytek;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
      if (s.iflytek && s.iflytek.appId) return s.iflytek;
    }
  } catch { /* 回退失败按无配置 */ }
  return {};
}

/** 探测本地转写服务是否在线(模型就绪) */
async function probeLocalAsr(localUrl) {
  if (!localUrl) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(String(localUrl).replace(/\/$/, "") + "/health", { signal: ctl.signal });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.ok;
  } catch { return false; }
  finally { clearTimeout(timer); }
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
  // R18:类型白名单在接收前拦截(不再先落盘后报错)——fileFilter 是 multer 顶层参数
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext)) return cb(null, true);
    cb(new Error(`不支持的文件类型: ${ext || "(无扩展名)"}(支持音频 mp3/wav/m4a/aac 等,视频 mp4/mov/mkv 等)`));
  },
  storage: multer.diskStorage({
    destination: UPLOADS,
    // R01:uploads 内使用唯一存储键,与用户原始文件名解耦——同名上传互不覆盖;
    //     原始名另存 task.originalFileName 供展示,扩展名保留(pipeline 靠它判断音视频)
    filename: (_req, file, cb) => {
      const safe = fixMojibakeName(file.originalname).replace(/[\\/:*?"<>|]/g, "_");
      const ext = path.extname(safe).toLowerCase();
      cb(null, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },  // 2GB 上限(讯飞单文件限 5 小时时长)
});

app.use(express.json());

/* 版本与健康信息(R10):不含任何密钥;匿名可查(供部署健康检查与一致性核对) */
app.get("/api/version", (_req, res) => {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")); } catch { /* 降级 */ }
  res.json({
    name: "mmboard",
    version: pkg.version || "unknown",
    commit: process.env.GIT_COMMIT || "unknown",
    builtAt: process.env.BUILD_TIME || "unknown",
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    node: process.version,
  });
});

/* ── R03 认证:除登录/状态外,全部 /api 需有效会话(注意 app.use 挂载下 req.path 为相对路径) ── */
const AUTH_PUBLIC = new Set(["/auth/login", "/auth/status"]);
/** R03:status 与业务中间件共用同一解析(签名+有效期+撤销) */
function resolveSession(req) {
  const a = auth.loadAuth(DATA);
  const token = auth.readSessionCookie(req);
  const sess = auth.verifyToken(a, token);
  if (!sess || auth.isRevoked(token)) return null;
  return { username: sess.username, token };
}
app.use("/api", (req, res, next) => {
  if (AUTH_PUBLIC.has(req.path)) return next();
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: "未登录或会话已过期" });
  req.authUser = sess.username;
  req.sessionToken = sess.token;
  next();
});
/* ── R03 CSRF 防护:非 GET 请求必须携带 X-Requested-With 头(Cookie 为 SameSite=Strict 双保险) ── */
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (req.headers["x-requested-with"] !== "XMLHttpRequest") {
    return res.status(403).json({ error: "缺少请求头(伪造站点请求防护)" });
  }
  next();
});

/* ── 认证端点 ── */
app.get("/api/auth/status", (req, res) => {
  let a;
  try { a = auth.loadAuth(DATA); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  const sess = resolveSession(req);
  res.json({ authenticated: !!sess, username: sess?.username || null, defaultPassword: !!a.defaultPassword });
});

app.post("/api/auth/login", (req, res) => {
  // R03:登录限流(每 IP 每分钟 5 次)
  if (!rateLimit(`login:${req.ip || "?"}`, 5, 60000)) {
    audit(req, "login", "rate-limited", false);
    return res.status(429).json({ error: "尝试过于频繁,请稍后再试" });
  }
  const { username, password } = req.body || {};
  const a = auth.loadAuth(DATA);
  if (!auth.verifyPassword(a, username, password)) {
    audit(req, "login", String(username || ""), false);
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  const token = auth.issueToken(a, a.username);
  audit(req, "login", a.username);
  res.setHeader("Set-Cookie", `mt_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
  res.json({ ok: true, username: a.username, defaultPassword: !!a.defaultPassword });
});

app.post("/api/auth/logout", (req, res) => {
  auth.revokeToken(req.sessionToken);   // 内存黑名单:本进程内立即失效(重启后清空,token 自然到期)
  audit(req, "logout", req.authUser || "");
  res.setHeader("Set-Cookie", "mt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.post("/api/auth/password", (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const a = auth.loadAuth(DATA);
  if (!auth.verifyPassword(a, req.authUser, oldPassword)) {
    audit(req, "password.change", "", false);
    return res.status(400).json({ error: "原密码错误" });
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: "新密码至少 8 位" });
  }
  a.salt = randomUUID().replace(/-/g, "");
  a.hash = auth.hashPassword(newPassword, a.salt);
  a.sessionSecret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");  // 轮换:全部旧会话失效
  a.defaultPassword = false;
  auth.saveAuth(DATA, a);
  audit(req, "password.change", a.username);
  const token = auth.issueToken(a, a.username);
  res.setHeader("Set-Cookie", `mt_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
  res.json({ ok: true });
});

/* ── API ── */
app.get("/api/meta", async (_req, res) => {
  const secret = loadSecret();
  const st = loadSettings();
  const asrProvider = st.asr?.provider === "local" ? "local" : "iflytek";
  const localAsrOnline = asrProvider === "local" ? await probeLocalAsr(st.asr?.localUrl) : false;
  res.json({
    ffmpeg: hasFfmpeg,
    iflytekConfigured: hasKeys(secret.iflytek || {}),
    llmConfigured: !!secret.llm?.apiKey,
    asrProvider,
    localAsrOnline,
  });
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
    // 转写通道(iflytek | local)
    asr: { provider: st.asr?.provider === "local" ? "local" : "iflytek", localUrl: st.asr?.localUrl || "" },
    // 讯飞云参数(appId 明文;key/secret 打码;来自 settings 或回退密钥文件)
    iflytek: (() => {
      const f = effectiveIflytek();
      return { appId: f.appId || "", apiKey: maskKey(f.apiKey), apiSecret: maskKey(f.apiSecret),
               fromFallback: !st.iflytek?.appId };
    })(),
    // 尚无设置条目时的现状提示:密钥文件里的 LLM(回退来源)
    fallback: secretLLM ? { provider: secretLLM.provider || "openai", baseUrl: secretLLM.baseUrl, model: secretLLM.model, apiKey: maskKey(secretLLM.apiKey) } : null,
  });
});

app.put("/api/settings", (req, res) => {
  const body = req.body || {};
  const prev = loadSettings();
  const prevById = new Map((prev.models || []).map((m) => [m.id, m]));
  for (const m of (Array.isArray(body.models) ? body.models : [])) {
    const old = prevById.get(m.id);
    // R05:修改了接口地址就不得沿用打码密钥——否则编辑者可让服务器把旧密钥发往新地址
    if (old && old.apiKey && typeof m.apiKey === "string" && m.apiKey.includes("****")
        && String(old.baseUrl || "") !== String(m.baseUrl || "").trim()) {
      return res.status(400).json({ error: `模型「${m.name}」修改了接口地址,请重新输入 API Key(不得沿用旧密钥)` });
    }
  }
  const models = (Array.isArray(body.models) ? body.models : []).map((m) => {
    const old = prevById.get(m.id);
    // apiKey 含 **** 视为未修改,沿用旧值(前端拿到的是打码值;baseUrl 变更已在上方拒绝)
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
  // asr 字段未提交时保留原值(兼容只改模型的旧调用)
  const asr = body.asr
    ? { provider: body.asr.provider === "local" ? "local" : "iflytek", localUrl: String(body.asr.localUrl || "").trim() }
    : (prev.asr || { provider: "iflytek", localUrl: "" });
  if (asr.provider === "local" && asr.localUrl && !validLocalUrl(asr.localUrl)) {
    return res.status(400).json({ error: "本地服务地址仅允许内网/本机地址(localhost / 10.x / 172.16-31.x / 192.168.x)" });
  }
  // 讯飞参数:appId 明文;key/secret 含打码则沿用当前生效值(R05 同款防外送);
  // body 未提交 iflytek 时保留 prev(可能来自回退,首次保存后固化进 settings)
  const eff = effectiveIflytek();
  const iflytekIn = body.iflytek;
  const iflytek = iflytekIn ? {
    appId: String(iflytekIn.appId || "").trim(),
    apiKey: (typeof iflytekIn.apiKey === "string" && iflytekIn.apiKey.includes("****")) ? String(eff.apiKey || "") : String(iflytekIn.apiKey || "").trim(),
    apiSecret: (typeof iflytekIn.apiSecret === "string" && iflytekIn.apiSecret.includes("****")) ? String(eff.apiSecret || "") : String(iflytekIn.apiSecret || "").trim(),
  } : (prev.iflytek || { appId: String(eff.appId || ""), apiKey: String(eff.apiKey || ""), apiSecret: String(eff.apiSecret || "") });
  // 转写真实签名仅需 appId+apiSecret;apiKey 为其他讯飞服务的可选项
  if (iflytek.appId && !iflytek.apiSecret) {
    return res.status(400).json({ error: "讯飞参数需填写 appId 与 apiSecret(apiKey 可选)" });
  }
  // R22:已知字段更新,保留 settings 里其他字段(如 asrDailyQuotaSeconds)
  saveSettings({ ...prev, activeId, models, asr, iflytek });
  audit(req, "settings.save", `models=${models.length} asr=${asr.provider} iflytek=${iflytek.appId ? "set" : "empty"}`);
  res.json({ ok: true, activeId, count: models.length, asr, iflytek: { appId: iflytek.appId, apiKey: maskKey(iflytek.apiKey), apiSecret: maskKey(iflytek.apiSecret) } });
});

app.post("/api/settings/test", async (req, res) => {
  // R05:测试接口限流 + 目的地址校验(与真实调用同一套白名单)
  if (!rateLimit(`test-llm:${req.ip || "?"}`, 6, 60000)) {
    return res.status(429).json({ ok: false, message: "测试过于频繁,请稍后再试" });
  }
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
  try {
    await assertLlmUrl(base, { allowPrivate: !!loadSettings().allowPrivateLlmHosts });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
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

/* ── 转写通道轻量切换(看板快捷开关用;只动 asr,不碰模型列表) ── */
app.put("/api/settings/asr", (req, res) => {
  const st = loadSettings();
  const body = req.body || {};
  if (body.provider) {
    st.asr = { ...(st.asr || { localUrl: "" }), provider: body.provider === "local" ? "local" : "iflytek" };
  }
  if (typeof body.localUrl === "string") {
    st.asr = { ...(st.asr || { provider: "iflytek" }), localUrl: body.localUrl.trim() };
  }
  if (st.asr.provider === "local" && st.asr.localUrl && !validLocalUrl(st.asr.localUrl)) {
    return res.status(400).json({ error: "本地服务地址仅允许内网/本机地址" });
  }
  saveSettings(st);
  audit(req, "settings.asr", `${st.asr.provider} ${st.asr.localUrl}`);
  res.json({ ok: true, asr: st.asr });
});

/* ── 转写通道测试:探测本地 FunASR 服务(R05:限流 + 内网地址白名单) ── */
app.post("/api/settings/test-asr", async (req, res) => {
  if (!rateLimit(`test-asr:${req.ip || "?"}`, 6, 60000)) {
    return res.status(429).json({ ok: false, message: "测试过于频繁,请稍后再试" });
  }
  const localUrl = String(req.body?.localUrl || "").trim();
  if (!localUrl) return res.json({ ok: false, message: "请先填写本地服务地址" });
  if (!validLocalUrl(localUrl)) {
    return res.status(400).json({ ok: false, message: "仅允许内网/本机地址(localhost / 10.x / 172.16-31.x / 192.168.x)" });
  }
  audit(req, "settings.test-asr", localUrl);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(String(localUrl).replace(/\/$/, "") + "/health", { signal: ctl.signal });
    if (!r.ok) return res.json({ ok: false, message: `HTTP ${r.status}` });
    const j = await r.json();
    return res.json(j.ok
      ? { ok: true, message: `本地转写服务在线(排队 ${j.queued || 0} 个任务)` }
      : { ok: false, message: `服务可达但模型未就绪(${j.model})` });
  } catch {
    return res.json({ ok: false, message: "服务不可达(检查地址与工作机服务)" });
  } finally { clearTimeout(timer); }
});

app.get("/api/tasks", (_req, res) => res.json(loadTasks().map(decorateTask)));

app.get("/api/tasks/:id", (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  t ? res.json(decorateTask(t)) : res.status(404).json({ error: "task not found" });
});

app.post("/api/tasks", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "缺少文件字段 file" });
  // R08:队列满则拒绝(在写任何状态/文件引用前;本轮已落盘文件在下方清理)
  if (queueDepth() >= QUEUE_CAPACITY) {
    try { fs.rmSync(req.file.path); } catch { /* best effort */ }
    return res.status(503).json({ error: `任务队列已满(${QUEUE_CAPACITY}),请等当前任务完成后再试` });
  }
  // R18:上传限流(每 IP 每分钟 6 次);超限删除本次落盘文件
  if (!rateLimit(`upload:${req.ip || "?"}`, 6, 60000)) {
    try { fs.rmSync(req.file.path); } catch { /* best effort */ }
    return res.status(429).json({ error: "上传过于频繁,请稍后再试" });
  }
  // R01:req.file.filename=唯一存储键;originalname 另存为展示用原始名(同名上传各自独立)
  const originalName = fixMojibakeName(req.file.originalname).replace(/[\\/:*?"<>|]/g, "_");
  let task;
  try {
    task = createTask(req.file.filename, originalName, req.file.size);
  } catch (e) {
    try { fs.rmSync(req.file.path); } catch { /* best effort */ }   // R18:建任务失败不留孤文件
    return res.status(503).json({ error: e.message });
  }
  audit(req, "task.create", `${task.id} ${originalName}`);
  // R08:全局串行队列(容量 10),满则 503 并清理本次文件
  try {
    enqueuePipeline(task, loadSecret());
  } catch (e) {
    try { fs.rmSync(req.file.path); } catch { /* best effort */ }
    const tasks = loadTasks();
    saveTasks(tasks.filter((x) => x.id !== task.id));
    return res.status(503).json({ error: e.message });
  }
  res.status(201).json(task);
});

/* 整条重跑额度预览:按当前转写通道给出不同口径
   本地通道 → 音频时长 + 预计转写耗时(RTF≈0.1 估),不涉讯飞额度
   讯飞通道 → 音频时长 + 当日余量(本地估算,免费额度按每日 2 小时为基准) */
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
  const provider = loadSecret().asr?.provider === "local" ? "local" : "iflytek";
  const day = new Date().toISOString().slice(0, 10);
  const dailySeconds = dailyAsrQuota();
  const usedSeconds = readQuota(day);
  const freeSeconds = Math.max(0, Math.round((dailySeconds - usedSeconds) * 10) / 10);
  res.json({
    provider,
    audioSeconds,
    estSeconds: provider === "local" ? Math.round(audioSeconds * 0.1 + 30) : null,
    usedSeconds: Math.round(usedSeconds * 10) / 10,
    dailySeconds,
    freeSeconds,
    enough: freeSeconds >= audioSeconds,
    mock: provider === "iflytek" && !hasKeys(loadSecret().iflytek || {}),   // 讯飞通道且配置不完整 = 模拟转写
  });
});

/* scope=analyze:复用已落盘转写文本,只重跑 AI 分析+生成纪要(不耗讯飞额度)
   scope=all(默认):整条重跑(重新转写)
   R07:运行中的任务拒绝重跑(409);每次重跑生成新 runId,旧执行的结果写入会被 runId 校验挡住 */
const RUNNING_STAGES = new Set(["queued", "extracting", "transcribing", "analyzing", "rendering"]);
app.post("/api/tasks/:id/restart", (req, res) => {
  const tasks = loadTasks();
  const t = tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  if (RUNNING_STAGES.has(t.stage)) {
    return res.status(409).json({ error: "任务正在流水线上运行,请等完成后再重跑" });
  }
  // R08:队列满在改写任何状态之前拒绝(不产生永久卡 queued 的任务)
  if (queueDepth() >= QUEUE_CAPACITY) {
    return res.status(503).json({ error: `任务队列已满(${QUEUE_CAPACITY}),请稍后再试` });
  }
  const scope = req.body?.scope === "analyze" ? "analyze" : "all";
  audit(req, "task.restart", `${t.id} scope=${scope}`);

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
    // 说话人标注应用:GLM 拿到的即真实姓名(person 归属更准)
    const smap = transcript.speakerMap || {};
    if (Object.keys(smap).length) transcript.text = applyMapToText(transcript.text, smap);
  }

  t.steps.forEach((s) => { s.status = "pending"; s.note = ""; s.startedAt = null; s.finishedAt = null; });
  t.stage = "queued";
  t.error = "";
  t.runId = require("crypto").randomUUID();   // 新运行实例:旧执行写入会被 runId 校验拒绝
  saveTasks(tasks);
  // R08:重跑同样入队(串行,不与当前任务抢资源)
  try {
    enqueuePipeline(t, loadSecret(), transcript ? { transcript } : {});
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }
  res.json(t);
});

/* ── 说话人手动标注(R15 人工确认):映射存 transcript.json 与 task,
      「重新跑分析」自动应用真名;有 analysis.json 时可纯重渲染(零额度零耗时) ── */
function applyMapToText(text, map) {
  const keys = Object.keys(map).sort((a, b) => Number(b) - Number(a));   // 长编号优先,防 1 吞 10
  for (const k of keys) text = text.split(`说话人${k}`).join(map[k]);
  return text;
}

function applySpeakerMapDeep(obj, map) {
  if (typeof obj === "string") return applyMapToText(obj, map);
  if (Array.isArray(obj)) return obj.map((x) => applySpeakerMapDeep(x, map));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = applySpeakerMapDeep(obj[k], map);
    return out;
  }
  return obj;
}

function rebuildTalkStats(segments, hasSpeakers, map = {}) {
  if (!hasSpeakers || !Array.isArray(segments) || !segments.length) return [];
  const acc = new Map();
  for (const s of segments) {
    const sp = String(s.speaker ?? "?");
    acc.set(sp, (acc.get(sp) || 0) + Math.max(0, (s.end || 0) - (s.start || 0)));
  }
  const total = [...acc.values()].reduce((a, b) => a + b, 0) || 1;
  return [...acc.entries()]
    .map(([speaker, ms]) => ({ speaker: map[String(speaker)] || `说话人${speaker}`,
                               ms, pct: Math.round((ms / total) * 1000) / 10 }))
    .sort((a, b) => b.ms - a.ms);
}

app.get("/api/tasks/:id/speakers", (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  const tp = path.join(OUTPUTS, t.id, "transcript.json");
  if (!fs.existsSync(tp)) return res.status(404).json({ error: "该任务没有已保存的转写文本" });
  let tr;
  try { tr = JSON.parse(fs.readFileSync(tp, "utf8")); }
  catch { return res.status(500).json({ error: "转写文本读取失败" }); }
  const speakers = [...new Set((tr.segments || []).map((x) => String(x.speaker ?? "?")))].filter((x) => x !== "?");
  res.json({
    speakers,
    map: (tr.speakerMap || t.speakerMap || {}),
    hasAnalysis: fs.existsSync(path.join(OUTPUTS, t.id, "analysis.json")),
  });
});

app.put("/api/tasks/:id/speakers", (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  // 4.3:运行中的任务禁止标注(避免与流水线竞争写 transcript/纪要)
  if (RUNNING_STAGES.has(t.stage)) {
    return res.status(409).json({ error: "任务正在流水线上运行,请等完成后再标注" });
  }
  const map = {};
  for (const [k, v] of Object.entries(req.body?.map || {})) {
    if (/^\d+$/.test(String(k)) && typeof v === "string" && v.trim()) {
      map[String(k)] = v.trim().slice(0, 30);   // 姓名限 30 字符
    }
  }
  const tp = path.join(OUTPUTS, t.id, "transcript.json");
  if (!fs.existsSync(tp)) return res.status(404).json({ error: "该任务没有已保存的转写文本" });
  let tr;
  try { tr = JSON.parse(fs.readFileSync(tp, "utf8")); }
  catch { return res.status(500).json({ error: "转写文本读取失败" }); }

  tr.speakerMap = map;   // 原始文本与编号不动,map 可反复修改
  writeJsonAtomic(tp, tr);
  const tasks = loadTasks();
  const t2 = tasks.find((x) => x.id === t.id);
  if (t2) { t2.speakerMap = map; t2.updatedAt = new Date().toISOString(); saveTasks(tasks); }
  audit(req, "task.speakers", `${t.id} ${JSON.stringify(map)}`);

  // 纯重渲染:有 analysis.json 才能只重渲染(否则提示先重跑分析)
  const ap = path.join(OUTPUTS, t.id, "analysis.json");
  if (!fs.existsSync(ap)) {
    return res.json({ ok: true, map, rerendered: false,
      message: "已保存标注;该任务暂无可复用的分析结果,请点「重新跑分析」生成后再标注生效" });
  }
  const saved = JSON.parse(fs.readFileSync(ap, "utf8"));
  const analysis2 = applySpeakerMapDeep(saved.analysis, map);
  const talkStats = rebuildTalkStats(tr.segments, tr.hasSpeakers, map);
  const { html, fileName } = renderMinutes({
    analysis: analysis2,
    meta: { ...saved.meta, talkStats },
  });
  fs.writeFileSync(path.join(OUTPUTS, t.id, fileName), html, "utf8");
  if (!t.minutesFile) {
    t.minutesFile = `${t.id}/${fileName}`;
    const tasks2 = loadTasks();
    const t3 = tasks2.find((x) => x.id === t.id);
    if (t3 && !t3.minutesFile) { t3.minutesFile = t.minutesFile; t3.updatedAt = new Date().toISOString(); fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks2, null, 2)); }
  }
  res.json({ ok: true, map, rerendered: true, minutesFile: `${t.id}/${fileName}` });
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

/* ── 任务删除(连带纪要产物目录与上传源文件;二次确认由前端承担)
   R07:运行中的任务拒绝删除(409),防止后台仍在写入造成"已删除又复活";
   R01:只删该任务自己的存储键与转码文件,不影响同名其他任务 ── */
app.delete("/api/tasks/:id", (req, res) => {
  const tasks = loadTasks();
  const i = tasks.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "task not found" });
  const t = tasks[i];
  if (RUNNING_STAGES.has(t.stage)) {
    return res.status(409).json({ error: "任务正在流水线上运行,请等完成(或失败)后再删除" });
  }
  tasks.splice(i, 1);
  saveTasks(tasks);
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };
  if (t.minutesFile) rm(path.join(OUTPUTS, t.minutesFile.split("/")[0]));
  else rm(path.join(OUTPUTS, t.id));   // 无纪要也清产物目录(transcript.json 等)
  if (t.fileName) rm(path.join(UPLOADS, t.fileName));
  // 转码中间文件:新任务为 <uuid>.mp3,历史任务为 <task.id>.mp3,两种都清(仅限本任务拥有的键)
  if (t.uuid) rm(path.join(UPLOADS, `${t.uuid}.mp3`));
  rm(path.join(UPLOADS, `${t.id}.mp3`));
  audit(req, "task.delete", t.id);
  res.json({ ok: true, id: t.id });
});

/* ── 纪要产物(R04):不再静态公开整个产物目录;
      纪要 HTML 走受认证保护的接口,transcript.json 仅内部使用 ── */
app.get("/api/tasks/:id/minutes", (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  if (!t || !t.minutesFile) return res.status(404).json({ error: "minutes not found" });
  const p = path.join(OUTPUTS, t.minutesFile);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "minutes file missing" });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  fs.createReadStream(p).pipe(res);
});

/* ── SPA ── */
app.use(express.static(DIST));
app.get(/^\/(?!api|outputs).*/, (_req, res) => res.sendFile(path.join(DIST, "index.html")));

/* R08:启动恢复——把上次运行中(失去执行者)的任务标记为中断 */
recoverInterruptedTasks();

/* R03:认证配置预检——损坏直接拒绝启动(fail-closed),绝不静默重建默认账号 */
try { auth.loadAuth(DATA); }
catch (e) {
  console.error("[auth] FATAL:", e.message);
  process.exit(1);
}

/* R18:multer/业务错误的统一转换(fileFilter 抛出的类型错误 → 400) */
app.use((err, _req, res, _next) => {
  const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
  res.status(status).json({ error: err.message || "请求处理失败" });
});

app.listen(PORT, () => {
  console.log(`[symphony-console] server on http://127.0.0.1:${PORT}`);
  console.log(`[symphony-console] ffmpeg=${hasFfmpeg ? "可用" : "未安装(视频不可处理,音频直传)"} 密钥=${fs.existsSync(SECRET_FILE) ? "已配置" : "未配置(mock 模式)"}`);
});
