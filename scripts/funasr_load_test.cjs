/**
 * R19 真实 FunASR 压测(三轮复审 §7-6)—— 对真实 FunASR 服务记录:
 *   健康响应、提交/排队/转写耗时(串行与并发)、转写质量(文本/说话人)、TTL 行为由 stub 套件覆盖。
 *
 * 运行:node scripts/funasr_load_test.cjs [funasr_base]
 * 默认地址 http://10.10.10.144:8300;测试音频:同目录 _funasr_t1.wav(可注入 FUNASR_WAV)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const BASE = (process.env.FUNASR_URL || "http://10.10.10.144:8300").replace(/\/$/, "");
const WAV = process.env.FUNASR_WAV || path.join(__dirname, "..", "_funasr_t1.wav");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
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

(async () => {
  console.log(`目标: ${BASE}`);
  // ① 健康检查
  const h0 = Date.now();
  const h = await req("GET", "/health");
  const hJ = JSON.parse(h.body);
  ok("健康检查 200 且 ok=true", h.status === 200 && hJ.ok === true, `${Date.now() - h0}ms model=${hJ.model}`);
  const healthMs = Date.now() - h0;
  ok("健康响应 < 1s", healthMs < 1000, `${healthMs}ms`);

  const wav = fs.readFileSync(WAV);

  // ② 串行单任务:提交→排队→转写→结果质量
  const t0 = Date.now();
  const u1 = await uploadOne("load-serial.wav", wav);
  ok("串行提交 200", u1.status === 200, u1.body.slice(0, 80));
  const id1 = JSON.parse(u1.body).id;
  const r1 = await waitDone(id1, 15 * 60 * 1000);
  const serialSec = ((Date.now() - t0) / 1000).toFixed(1);
  ok("串行转写完成 done", r1.status === "done", `耗时 ${serialSec}s(含排队) error=${r1.error || "无"}`);
  ok("转写文本非空", r1.status === "done" && (r1.result?.text || "").length >= 20, `text ${(r1.result?.text || "").length} 字`);

  // ③ 并发 3 任务:全部完成且互不干扰
  const t1c = Date.now();
  const ups = await Promise.all([1, 2, 3].map((i) => uploadOne(`load-par-${i}.wav`, wav)));
  ok("并发 3 提交全部 200", ups.every((u) => u.status === 200), ups.map((u) => u.status).join(","));
  const ids = ups.map((u) => JSON.parse(u.body).id);
  const results = [];
  const pc0 = Date.now();
  for (;;) {
    if (Date.now() - pc0 > 20 * 60 * 1000) throw new Error("并发等待超时");
    const sts = await Promise.all(ids.map((id) => req("GET", `/tasks/${id}`).then((r) => JSON.parse(r.body))));
    if (sts.every((s) => s.status === "done" || s.status === "failed")) { results.push(...sts); break; }
    await sleep(3000);
  }
  const parSec = ((Date.now() - t1c) / 1000).toFixed(1);
  ok("并发 3 全部 done", results.every((r) => r.status === "done"), `总耗时 ${parSec}s(3 个 ${wav.length}B 任务)`);
  ok("并发结果互不串扰(各自有文本)", results.every((r) => (r.result?.text || "").length > 10));

  // ④ 压测记录(供交付文档引用)
  console.log(`\n[记录] 音频 ${wav.length}B | 健康响应 ${healthMs}ms | 串行转写(含排队)${serialSec}s | 并发 3 总耗时 ${parSec}s | 队列能力见 local-asr stub 套件`);

  console.log(`\n===== FunASR 真实压测:${pass} 通过,${fail} 失败 =====`);
  if (failuresCount(fail)) process.exit(1);
  function failuresCount(n) { return n > 0; }
})().catch((e) => { console.error("压测异常:", e.message); process.exit(1); });
