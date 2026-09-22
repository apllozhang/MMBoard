/**
 * R19 真实 FunASR 压测(三轮复审 §7-6 / 四轮复审 §3.6)—— 对真实 FunASR 服务记录:
 *   健康响应、提交/排队/转写耗时(串行与并发)、转写内容非空且可断言、并发结果不串扰、失败清理。
 *
 * 夹具策略(四轮复审:仓库不放音频文件,全新 clone 默认命令可运行):
 *   1. 环境变量 FUNASR_WAV 指向现成 wav → 直接使用(此时不做双夹具交叉断言);
 *   2. 默认用 Windows 自带 SAPI 在本机合成两段"含已知标记词"的语音(scripts/gen_tts_fixture.ps1),
 *      合成结果缓存于系统临时目录,再次运行直接复用;仓库只保存生成脚本,不含任何音频;
 *   3. SAPI 不可用/无任何语音 → 明确"环境阻断"退出(非零),绝不宣称测试通过。
 *
 * 运行:node scripts/funasr_load_test.cjs [funasr_base](默认 http://10.10.10.144:8300)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const BASE = (process.env.FUNASR_URL || "http://10.10.10.144:8300").replace(/\/$/, "");
const T1 = path.join(os.tmpdir(), "mmb-funasr-t1.wav");
const T2 = path.join(os.tmpdir(), "mmb-funasr-t2.wav");
const LANG_MARK = path.join(os.tmpdir(), "mmb-funasr-lang.txt");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const envBlocked = (msg) => {
  console.error(`\n[环境阻断] ${msg}`);
  console.error("[环境阻断] 准备方式(二选一):");
  console.error("  ① 设置 FUNASR_WAV 指向一段 ≥5 秒的清晰语音 wav 后重跑;");
  console.error("  ② 在 Windows 设置→语音→管理语音 中安装任意语音(或中文语音)后重跑,脚本会自动合成。");
  console.error("[环境阻断] 按验收口径,本套件不宣称通过(退出码 2)。");
  process.exit(2);
};

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + p, { method, headers, timeout: 600000 }, (x) => {
      let d = ""; x.on("data", (c) => d += c); x.on("end", () => resolve({ status: x.statusCode, body: d }));
    });
    r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

function uploadOne(name, content) {
  return new Promise((resolve, reject) => {
    const b = "----fl" + Math.random().toString(36).slice(2);
    const head = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: audio/wav\r\n\r\n`;
    const tail = `\r\n--${b}--\r\n`;
    const body = Buffer.concat([Buffer.from(head), content, Buffer.from(tail)]);
    const r = http.request(BASE + "/tasks", { method: "POST", timeout: 600000, headers: {
      "Content-Type": `multipart/form-data; boundary=${b}`, "Content-Length": body.length } }, (x) => {
      let d = ""; x.on("data", (c) => d += c); x.on("end", () => resolve({ status: x.statusCode, body: d }));
    });
    r.on("error", reject); r.write(body); r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(id, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时(${timeoutMs / 1000}s)`);
    const r = await req("GET", `/tasks/${id}`);
    if (r.status === 404) throw new Error("task 404");
    const j = JSON.parse(r.body);
    if (j.status === "done" || j.status === "failed") return j;
    await sleep(2000);
  }
}

/** 夹具准备:外部注入 > 缓存复用 > SAPI 现场合成;返回标记词(lang 为 en/zh 时启用内容断言) */
function ensureFixtures() {
  if (process.env.FUNASR_WAV) {
    const p = process.env.FUNASR_WAV;
    if (!fs.existsSync(p)) envBlocked(`FUNASR_WAV 指向的文件不存在: ${p}`);
    return { files: [p, p], markers: null };
  }
  const cached = fs.existsSync(T1) && fs.existsSync(T2)
    && fs.statSync(T1).size > 200000 && fs.statSync(T2).size > 200000 && fs.existsSync(LANG_MARK);
  if (!cached) {
    const ps1 = path.join(__dirname, "gen_tts_fixture.ps1");
    if (!fs.existsSync(ps1)) envBlocked(`缺少夹具生成脚本 ${ps1}`);
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Out1", T1, "-Out2", T2],
      { encoding: "utf8", timeout: 120000 });
    const out = `${r.stdout || ""}`;
    const lang = (out.match(/LANG=(\w+)/) || [])[1] || "none";
    if (lang === "none") envBlocked("本机未安装任何 SAPI 语音(无法合成含已知文字的夹具)");
    if (r.error || r.status !== 0 || !out.includes("GEN=ok") || !fs.existsSync(T1) || !fs.existsSync(T2)
        || fs.statSync(T1).size < 200000 || fs.statSync(T2).size < 200000) {
      envBlocked(`SAPI 语音合成失败(status=${r.status} err=${(r.stderr || r.error || "").toString().slice(0, 160)})`);
    }
    try { fs.writeFileSync(LANG_MARK, lang); } catch { /* 缓存标记写失败仅影响下次复用 */ }
  }
  const lang = (fs.existsSync(LANG_MARK) ? fs.readFileSync(LANG_MARK, "utf8") : "") || "en";
  const markers = lang.includes("zh")
    ? { a: [/会议测试一/], b: [/会议测试二/] }
    : { a: [/meeting test one/i], b: [/meeting test two/i] };
  return { files: [T1, T2], markers };
}

(async () => {
  console.log(`目标: ${BASE}`);
  // ① 健康检查(服务不可达 = 环境阻断,如实报告,不视为用例失败)
  let h, hJ, healthMs;
  const h0 = Date.now();
  try {
    h = await req("GET", "/health");
    hJ = JSON.parse(h.body);
    healthMs = Date.now() - h0;
  } catch (e) {
    envBlocked(`真实 FunASR 服务不可达(${BASE}): ${e.message}`);
  }
  ok("健康检查 200 且 ok=true", h.status === 200 && hJ.ok === true, `${healthMs}ms model=${hJ.model}`);
  ok("健康响应 < 1s", healthMs < 1000, `${healthMs}ms`);

  const { files, markers } = ensureFixtures();
  const wav1 = fs.readFileSync(files[0]);
  const wav2 = fs.readFileSync(files[1]);
  console.log(`夹具: ${files[0]}(${wav1.length}B) / ${files[1]}(${wav2.length}B)${markers ? "" : "(外部注入,跳过标记词断言)"}`);

  // ② 串行单任务:提交→排队→转写→内容断言
  const t0 = Date.now();
  const u1 = await uploadOne("load-serial.wav", wav1);
  ok("串行提交 200", u1.status === 200, u1.body.slice(0, 80));
  const id1 = JSON.parse(u1.body).id;
  const r1 = await waitDone(id1, 15 * 60 * 1000);
  const serialSec = ((Date.now() - t0) / 1000).toFixed(1);
  ok("串行转写完成 done", r1.status === "done", `耗时 ${serialSec}s(含排队) error=${r1.error || "无"}`);
  ok("转写文本非空", r1.status === "done" && (r1.result?.text || "").length >= 20, `text ${(r1.result?.text || "").length} 字`);
  if (markers) {
    ok("串行转写内容含第 1 夹具标记词", markers.a.every((m) => m.test(r1.result?.text || "")), (r1.result?.text || "").slice(0, 60));
    ok("串行转写不含第 2 夹具内容", !markers.b.some((m) => m.test(r1.result?.text || "")));
  }

  // ③ 失败清理:非法音频(无音轨)→ 明确 failed,不留悬挂任务
  const bad = await uploadOne("load-bad.wav", Buffer.from("this is not a real audio container"));
  let badStatus = "submitted";
  if (bad.status >= 400) badStatus = "rejected";
  else {
    const bj = await waitDone(JSON.parse(bad.body).id, 120000);
    badStatus = bj.status;
  }
  ok("坏音频 → 明确 failed/拒绝(不悬挂)", badStatus === "failed" || badStatus === "rejected", `status=${badStatus}`);

  // ④ 并发 3 任务(A/B/A):全部完成、内容按任务对应、互不串扰
  const t1c = Date.now();
  const ups = await Promise.all([wav1, wav2, wav1].map((w, i) => uploadOne(`load-par-${i + 1}.wav`, w)));
  ok("并发 3 提交全部 200", ups.every((u) => u.status === 200), ups.map((u) => u.status).join(","));
  const ids = ups.map((u) => JSON.parse(u.body).id);
  const expect = [wav1, wav2, wav1];
  const results = [];
  const pc0 = Date.now();
  for (;;) {
    if (Date.now() - pc0 > 20 * 60 * 1000) throw new Error("并发等待超时");
    const sts = await Promise.all(ids.map((id) => req("GET", `/tasks/${id}`).then((r) => JSON.parse(r.body))));
    if (sts.every((s) => s.status === "done" || s.status === "failed")) { results.push(...sts); break; }
    await sleep(3000);
  }
  const parSec = ((Date.now() - t1c) / 1000).toFixed(1);
  ok("并发 3 全部 done", results.every((r) => r.status === "done"), `总耗时 ${parSec}s(3 个 ~${wav1.length}B 任务)`);
  if (markers) {
    const byIdx = results.map((r, i) => {
      const text = r.result?.text || "";
      const wantA = expect[i] === wav1;
      const hasOwn = (wantA ? markers.a : markers.b).every((m) => m.test(text));
      const hasOther = (wantA ? markers.b : markers.a).some((m) => m.test(text));
      return { hasOwn, hasOther };
    });
    ok("并发结果按任务对应(各自含己方标记词)", byIdx.every((x) => x.hasOwn), JSON.stringify(byIdx));
    ok("并发结果互不串扰(无他方标记词)", byIdx.every((x) => !x.hasOther));
  } else {
    ok("并发结果互不串扰(各自有文本)", results.every((r) => (r.result?.text || "").length > 10));
  }

  // ⑤ 压测记录(供交付文档引用)
  console.log(`\n[记录] 音频 ${wav1.length}B/${wav2.length}B | 健康响应 ${healthMs}ms | 串行转写(含排队)${serialSec}s | 并发 3 总耗时 ${parSec}s | 队列/TTL 行为见 local-asr stub 套件`);

  console.log(`\n===== FunASR 真实压测:${pass} 通过,${fail} 失败 =====`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(String(e.message))) {
    envBlocked(`真实 FunASR 服务不可达(${BASE}): ${e.message}`);
  }
  console.error("压测异常:", e.message); process.exit(1);
});
