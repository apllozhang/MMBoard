/**
 * 复审整改批次 A 验证脚本(可复现:相对路径、零外部依赖、隔离数据目录)
 *
 * 覆盖(MMBOARD_REASSESSMENT_2026-09-21.md 批次 A + B/C 抽验):
 *   A1 认证 fail-closed / 一次性随机密码 / 登录限流 / 审计注入清洗 / XFF 不信任 / 撤销一致
 *   A2 speaker 恶意名 XSS(正文/表格/图表 tooltip)
 *   A3 讯飞字段契约(appId+apiSecret,secretKey 别名)/ 生产禁静默 mock / example 契约
 *   A4 部署不可变镜像与健康检查(静态断言)
 *   B  persist 原子写与损坏恢复 / 队列满防线 / speaker 运行互斥
 *   C  采样覆盖率 / missingFields→partial / 三类日期语义
 *   R05 LLM 地址白名单 / settings/test 限流
 *   R19 本地 ASR worker 化(静态断言)
 *
 * 运行:node scripts/verify_batch_a.cjs   (需 Node 18+;本进程内启动真实 HTTP 服务)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function section(name, fn) {
  console.log(`\n■ ${name}`);
  try { await fn(); } catch (e) { fail++; failures.push(`${name}(异常: ${e.message})`); console.log(`  ✗ 异常: ${e.stack || e.message}`); }
}

/* ── 隔离环境:先做纯单元断言(auth/persist),再起 HTTP 服务做集成 ── */
process.env.MMB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mmb-verify-a-"));
process.env.PORT = String(18000 + Math.floor(Math.random() * 2000));
process.env.MMB_ADMIN_PASSWORD = "VerifyPass-批次A-123";
const DATA = process.env.MMB_DATA_DIR;

const auth = require(path.join(ROOT, "server", "auth.cjs"));
const persist = require(path.join(ROOT, "server", "persist.cjs"));
const iflytek = require(path.join(ROOT, "server", "iflytek.cjs"));
const llm = require(path.join(ROOT, "server", "llm.cjs"));
const { renderMinutes } = require(path.join(ROOT, "server", "minutes-template.cjs"));

(async () => {

await section("A1 认证:损坏配置 fail-closed、一次性随机密码、原子写", async () => {
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "mmb-a1-"));
  const f1 = path.join(d1, "auth.json");
  fs.writeFileSync(f1, "{corrupt!!");
  let threw = "";
  try { auth.loadAuth(d1); } catch (e) { threw = e.message; }
  ok("损坏 auth.json → loadAuth 抛错(fail-closed)", threw.includes("认证配置损坏"));
  ok("损坏文件未被覆盖删除(供人工恢复)", fs.readFileSync(f1, "utf8") === "{corrupt!!");

  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "mmb-a2-"));
  const prev = process.env.MMB_ADMIN_PASSWORD;
  delete process.env.MMB_ADMIN_PASSWORD;
  const a2 = auth.loadAuth(d2);
  process.env.MMB_ADMIN_PASSWORD = prev;
  ok("首次初始化密码 ≠ 公开默认值(mmboard2026)", auth.verifyPassword(a2, "admin", "mmboard2026") === false);
  ok("初始化记录标记 defaultPassword(提醒改密)", a2.defaultPassword === true && a2.hash.length === 64);
  ok("MMB_ADMIN_PASSWORD 环境注入生效", (() => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "mmb-a3-"));
    process.env.MMB_ADMIN_PASSWORD = "EnvPass-xyz";
    const a3 = auth.loadAuth(d3);
    process.env.MMB_ADMIN_PASSWORD = prev;   // 恢复,供后续 HTTP 服务初始化使用
    return auth.verifyPassword(a3, "admin", "EnvPass-xyz");
  })());

  const f2 = path.join(d2, "auth.json");
  auth.saveAuth(d2, a2);
  ok("saveAuth 原子写:无 .tmp 残留", !fs.existsSync(f2 + ".tmp"));
});

await section("B persist:原子写、损坏恢复、隔离与双坏抛错", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mmb-persist-"));
  const f = path.join(d, "state.json");
  persist.writeJsonAtomic(f, { v: 1 });   // 首写(无 .bak)
  persist.writeJsonAtomic(f, { v: 2 });   // 二写:v1 进入 .bak
  fs.writeFileSync(f, "{broken");
  const r = persist.readJsonWithRecovery(f);
  ok("主文件损坏 → 从 .bak 恢复上一版数据", r.v === 1, `实际 v=${r.v}`);
  ok("主文件已被修复(可再次读)", JSON.parse(fs.readFileSync(f, "utf8")).v === 1);
  ok("损坏副本隔离为 .corrupt", fs.existsSync(f + ".corrupt"));

  const f2 = path.join(d, "both-bad.json");
  fs.writeFileSync(f2, "{bad-main");
  fs.writeFileSync(f2 + ".bak", "{bad-bak");
  let threw = "";
  try { persist.readJsonWithRecovery(f2); } catch (e) { threw = e.message; }
  ok("主备皆坏 → 抛明确错误(不静默清空)", threw.includes("均无法解析"));

  const f3 = path.join(d, "absent.json");
  let enoent = "";
  try { persist.readJsonWithRecovery(f3); } catch (e) { enoent = e.code || ""; }
  ok("文件不存在 → 抛 ENOENT 由调用方初始化", enoent === "ENOENT");
});

await section("A3 讯飞字段契约:appId+apiSecret 两件套,secretKey 别名", async () => {
  ok("normalizeCfg:旧字段 secretKey → apiSecret 别名", (() => {
    const c = iflytek.normalizeCfg({ appId: " app ", secretKey: " sk " });
    return c.appId === "app" && c.apiSecret === "sk" && c.apiKey === "";
  })());
  ok("hasKeys:appId+apiSecret 齐即视为已配置(两件套即可真实签名)", iflytek.hasKeys({ appId: "a", apiSecret: "s" }) === true);
  ok("hasKeys:缺 apiSecret 不算已配置", iflytek.hasKeys({ appId: "a", apiKey: "k" }) === false);
  ok("hasKeys:打码占位不算已配置", iflytek.hasKeys({ appId: "在此填入", apiSecret: "s" }) === false);

  let mockErr = "";
  try { await iflytek.transcribe("nonexistent.wav", { appId: "", apiSecret: "" }, () => {}); }
  catch (e) { mockErr = e.message; }
  ok("生产缺配置 → transcribe 明确抛错(不静默 mock)", mockErr.includes("拒绝静默生成模拟内容"));
  const demo = await iflytek.transcribe("nonexistent.wav", { appId: "", apiSecret: "", demo: true }, () => {});
  ok("显式 demo 开关才允许 mock", demo.mock === true && typeof demo.text === "string");

  const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "meeting.secret.example.json"), "utf8"));
  ok("meeting.secret.example 契约与适配器一致(appId/apiKey/apiSecret)",
     typeof ex.iflytek.appId === "string" && "apiSecret" in ex.iflytek);
});

await section("R05 LLM 地址白名单(assertLlmUrl)", async () => {
  const deny = async (u, opt) => { try { await llm.assertLlmUrl(u, opt); return false; } catch { return true; } };
  ok("非 http/https 协议拒绝", await deny("ftp://example.com"));
  ok("云元数据地址无条件拒绝", await deny("http://169.254.169.254/latest/meta-data/", { allowPrivate: true }));
  ok("私网地址默认拒绝(127.0.0.1)", await deny("http://127.0.0.1:11434"));
  ok("私网地址默认拒绝(192.168.x)", await deny("http://192.168.1.5:8000"));
  ok("allowPrivate 显式放行本机模型服务", await llm.assertLlmUrl("http://127.0.0.1:11434", { allowPrivate: true }).then(() => true, () => false));
  ok("公网字面量 IP 放行", await llm.assertLlmUrl("http://93.184.216.34/v1", { allowPrivate: false }).then(() => true, () => false));
  ok("不可解析主机名拒绝", await deny("http://no-such-host.invalid"));
  ok("isPrivateIp 分类正确", llm.isPrivateIp("10.0.0.1") && !llm.isPrivateIp("8.8.8.8") && llm.isPrivateIp("::ffff:127.0.0.1"));
});

await section("A2 XSS:恶意说话人名在正文/表格/图表数据中全部转义", async () => {
  const EVIL = '<img src=x onerror=alert(1)>';
  const { html } = renderMinutes({
    analysis: llm.normalizeAnalysis({
      title: "T", summary: "S", topics: [], decisions: [], actions: [], risks: [], highlights: [],
    }),
    meta: {
      date: "2026-09-20", uploadedAt: "2026-09-20T10:00:00.000Z", generatedAt: "2026-09-21T08:00:00.000Z",
      fileName: "x.mp3", transcriptChars: 100, talkStats: [
        { speaker: EVIL, ms: 600000, pct: 60 },
        { speaker: "说话人2", ms: 400000, pct: 40 },
      ],
    },
  });
  const imgTags = html.match(/<img[^>]*>/gi) || [];
  ok("无任何 <img 标签携带注入载荷(onerror / src=x)", imgTags.every((t) => !t.includes("onerror") && !t.includes("src=x")),
     `共 ${imgTags.length} 个 img 标签(模板 logo 与图片缩放为合法存在)`);
  ok("恶意名以转义形态出现在数据表中", html.includes("&lt;img"));
  ok("图表 tooltip 使用预编码 speakerHtml 字段", html.includes("speakerHtml"));
  const m = html.match(/var TALK = (\[.*?\]);/s);
  ok("TALK JSON 内 speaker 已预编码", !!m && !m[1].includes("<img src=x") && m[1].includes("speakerHtml"));
});

await section("C 内容正确性:采样覆盖率、missingFields→partial、三类日期", async () => {
  const rows = [];
  for (let i = 0; i < 1400; i++) rows.push(`[10:00] 说话人1: 第${i}行 MIDDLE_MARKER_${i} 讨论内容补充扩展一些字数确保超过限制`);
  const totalLen = rows.join("\n").length;
  const { prompt, truncated, coverage } = llm.buildPrompt(rows.join("\n"));
  ok(`超长转写触发采样且返回覆盖率(输入 ${totalLen} 字)`, truncated === true && coverage > 0 && coverage < 100,
     `truncated=${truncated} coverage=${coverage} prompt=${prompt.length}`);
  ok("中段内容按均匀采样保留(非整体丢弃)", prompt.includes("MIDDLE_MARKER_500"));
  ok("提示注明覆盖率", prompt.includes("覆盖率约"));

  const missing = llm.normalizeAnalysis({ title: "只有标题" });
  ok("字段缺失被识别(missingFields)", missing.missingFields.includes("summary") && missing.missingFields.includes("actions"));
  ok("字段缺失 → partial=true", missing.partial === true);
  const full = llm.normalizeAnalysis({ title: "t", summary: "s", topics: [], decisions: [], actions: [], risks: [], highlights: [] });
  ok("字段齐全不误标 partial", full.partial === false && full.missingFields.length === 0);

  const { html } = renderMinutes({
    analysis: full,
    meta: { date: "2026-09-20", uploadedAt: "2026-09-20T10:00:00.000Z", generatedAt: "2026-09-21T08:00:00.000Z",
            fileName: "x.mp3", transcriptChars: 10, talkStats: [] },
  });
  ok("渲染上传时间(≠生成时间)", html.includes("上传时间:2026-09-20"));
  ok("渲染纪要生成时间", html.includes("纪要生成:2026-09-21"));
  ok("会议日期明确标注未提供(不冒充)", html.includes("会议日期:未提供"));
});

await section("A4/R19 部署与本地 ASR 静态断言", async () => {
  const dep = fs.readFileSync(path.join(ROOT, "deploy", "deploy.cjs"), "utf8");
  ok("候选与生产运行均使用不可变 imageId(sha256)", dep.includes("'{{.Id}}'") && dep.includes("runProd = await run(conn") && dep.includes("${imageId}"));
  ok("回滚依据旧容器不可变镜像 ID(非可变标签)", dep.includes("'{{.Image}}'") && dep.includes("${oldImageId}"));
  ok("健康检查逐项断言 2xx(curl -sf + 正则)", dep.includes("curl -sf") && dep.includes("/^2\\d\\d$/"));
  ok("候选容器挂载生产数据卷", dep.includes("-v ${DATA_VOL}:/app/server/data ${imageId}"));
  ok("远端解包前清理旧残留", dep.includes(`rm -rf \${REMOTE_DIR}`));

  const py = fs.readFileSync(path.join(ROOT, "tools", "local-asr", "server.py"), "utf8");
  ok("队列有界且满时 503", py.includes("queue.Queue(maxsize=QUEUE_CAPACITY)") && py.includes("queue.Full") && py.includes("503"));
  ok("queued/running 状态分离", py.includes('"status": "queued"') && py.includes('TASKS[tid] = {"status": "running"}'));
  ok("转码移入 worker 线程(submit 不再阻塞事件循环)", /def worker\(\):[\s\S]*to_wav16k\(src, tid\)/.test(py) && !/async def submit[\s\S]{0,800}to_wav16k/.test(py));
  ok("结果与临时文件按 TTL 清理", py.includes("TASK_TTL_SEC") && py.includes("def ttl_sweeper"));
});

/* ── 集成:启动真实服务(隔离数据目录) ── */
console.log(`\n■ 集成测试:启动 HTTP 服务(:${process.env.PORT},数据目录 ${DATA})`);
require(path.join(ROOT, "server", "server.cjs"));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let cookie = "";
const api = async (method, p, body, extra = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}),
               ...(method !== "GET" && method !== "HEAD" ? { "X-Requested-With": "XMLHttpRequest" } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
};

let up = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(BASE + "/api/version"); if (r.ok) { up = true; break; } } catch { /* 未就绪 */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!up) { console.error("服务未能启动"); process.exit(1); }

await section("集成:登录/审计/限流/撤销", async () => {
  let r = await api("POST", "/api/auth/login", { username: "admin", password: "VerifyPass-批次A-123" });
  ok("环境注入密码登录成功", r.status === 200);
  const sc = r.headers.get("set-cookie") || "";
  cookie = sc.split(";")[0];

  r = await fetch(BASE + "/api/auth/status", { headers: { Cookie: cookie } });
  const st1 = await r.json();
  ok("status 显示已登录", st1.authenticated === true);

  await api("POST", "/api/auth/logout");
  r = await fetch(BASE + "/api/auth/status", { headers: { Cookie: cookie } });
  ok("登出后 status 与业务接口一致判定未登录", ((await r.json()).authenticated) === false);

  r = await api("POST", "/api/auth/login", { username: "admin", password: "VerifyPass-批次A-123" });
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  ok("重新登录获取新会话", r.status === 200);

  // 审计注入:换行用户名不得伪造日志行;XFF 不得被信任
  const auditBefore = fs.readFileSync(path.join(DATA, "audit.log"), "utf8").split("\n").filter((x) => x.trim()).length;
  await api("POST", "/api/auth/login", { username: "hacker\nFAKE-LINE ok", password: "wrong" },
            { "X-Forwarded-For": "1.2.3.4" });
  const lines = fs.readFileSync(path.join(DATA, "audit.log"), "utf8").split("\n").filter((x) => x.trim());
  ok("审计日志无伪造行(控制字符被清洗)", lines.length === auditBefore + 1 && !lines.some((l) => l.trim() === "FAKE-LINE ok"));
  ok("不信任 X-Forwarded-For", !lines[lines.length - 1].includes("1.2.3.4"));

  // 登录限流:此前窗口内 login 已计 3 次(首次成功/重登/注入失败),再 2 次失败到 5,第 6 次应 429
  await api("POST", "/api/auth/login", { username: "admin", password: "wrong" });
  await api("POST", "/api/auth/login", { username: "admin", password: "wrong" });
  r = await api("POST", "/api/auth/login", { username: "admin", password: "wrong" });
  ok("登录限流:窗口内第 6 次请求 429", r.status === 429, `实际 ${r.status}`);
});

await section("集成:讯飞配置契约贯通 settings → meta", async () => {
  const persist2 = require(path.join(ROOT, "server", "persist.cjs"));
  persist2.writeJsonAtomic(path.join(DATA, "settings.json"),
    { activeId: null, models: [], iflytek: { appId: "cfg-app", apiSecret: "cfg-secret" } });
  const r = await api("GET", "/api/meta");
  ok("settings 三字段契约 → /api/meta 判定已配置", (await r.json()).iflytekConfigured === true);
  persist2.writeJsonAtomic(path.join(DATA, "settings.json"),
    { activeId: null, models: [], iflytek: { appId: "cfg-app", secretKey: "legacy-secret" } });
  ok("旧字段 secretKey 别名同样贯通", (await (await api("GET", "/api/meta")).json()).iflytekConfigured === true);
});

await section("集成:speaker 标注运行互斥 + settings/test 限流", async () => {
  persist.writeJsonAtomic(path.join(DATA, "tasks.json"),
    [{ id: "MT-TEST-99", stage: "transcribing", runId: "r1", steps: [], title: "运行中", createdAt: new Date().toISOString() }]);
  const r = await api("PUT", "/api/tasks/MT-TEST-99/speakers", { map: { "0": "张三" } });
  ok("运行中任务标注 → 409(与流水线互斥)", r.status === 409);

  for (let i = 0; i < 6; i++) await api("POST", "/api/settings/test", {});   // 400(配置不完整),但消耗限流配额
  const r429 = await api("POST", "/api/settings/test", {});
  ok("settings/test 限流生效(第 7 次 429)", r429.status === 429);
});

await section("集成:队列满防线(单元级)与 restart 前置检查顺序", async () => {
  const pipeline = require(path.join(ROOT, "server", "pipeline.cjs"));
  ok("QUEUE_CAPACITY=10 且 queueDepth 可观测", pipeline.QUEUE_CAPACITY === 10 && pipeline.queueDepth() === 0);
  let fullErr = "";
  try {
    // 首次入队的 1 个被 drainQueue 立即取走执行,故需 CAPACITY+2 次才触发同步抛错
    for (let i = 0; i < pipeline.QUEUE_CAPACITY + 2; i++) {
      pipeline.enqueuePipeline({ id: `no-such-${i}`, runId: "rx", steps: [] }, {}, {});
    }
  } catch (e) { fullErr = e.message; }
  ok("队列满同步抛错(enqueuePipeline 防线)", fullErr.includes("队列已满"), fullErr || "未抛错");

  const src = fs.readFileSync(path.join(ROOT, "server", "server.cjs"), "utf8");
  const restartBody = src.slice(src.indexOf('app.post("/api/tasks/:id/restart"'), src.indexOf('app.get("/api/tasks/:id/speakers"'));
  const at503 = restartBody.indexOf("queueDepth() >= QUEUE_CAPACITY");
  const atQueued = restartBody.indexOf('t.stage = "queued"');
  ok("restart 在改写 queued 状态之前拒绝队列满(不再永久卡 queued)", at503 > -1 && atQueued > -1 && at503 < atQueued);
});

console.log(`\n===== 结果:${pass} 通过,${fail} 失败 =====`);
if (failures.length) { console.log("失败项:"); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
