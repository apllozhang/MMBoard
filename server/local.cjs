/**
 * 本地离线转写通道客户端 —— 调用 Windows 工作机上的 FunASR 服务(D:\Tools\local-asr)
 * 服务接口:POST /tasks(提交) · GET /tasks/:id(轮询) · GET /health
 * 返回结构与 iflytek.cjs 对齐:{ text, segments, hasSpeakers, mock }
 */
"use strict";
const fs = require("fs");
const path = require("path");

const POLL_MS = 3000;
const DEFAULT_TIMEOUT_SEC = 90 * 60;   // 长会议 CPU 转写上限

async function transcribe(audioPath, cfg = {}, log = () => {}) {
  const base = String(cfg.localUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("本地转写未配置服务地址(设置页·转写通道)");

  /* 前置健康检查 */
  const hctl = new AbortController();
  const htimer = setTimeout(() => hctl.abort(), 8000);
  let health;
  try {
    health = await (await fetch(`${base}/health`, { signal: hctl.signal })).json();
  } catch {
    throw new Error(`本地转写服务不可达: ${base}(检查工作机服务是否启动)`);
  } finally {
    clearTimeout(htimer);
  }
  if (!health.ok) throw new Error(`本地转写模型未就绪(${health.model}),稍后重试`);
  if (health.queued > 0) log(`本地服务排队中: ${health.queued} 个任务在前`);

  /* 提交(203 已转好 16k mp3,直接上传) */
  const buf = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf]), path.basename(audioPath));
  const sctl = new AbortController();
  const stimer = setTimeout(() => sctl.abort(), 10 * 60 * 1000);   // 上传大文件宽限
  let sub;
  try {
    const r = await fetch(`${base}/tasks`, { method: "POST", body: form, signal: sctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    sub = await r.json();
  } finally {
    clearTimeout(stimer);
  }
  log("已提交本地转写:", sub.id);

  /* 轮询(单次查询失败有限容错,连续 3 次才判失败;总超时见下) */
  const t0 = Date.now();
  let pollErrors = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const pctl = new AbortController();
    const ptimer = setTimeout(() => pctl.abort(), 15000);
    let st;
    try {
      const r = await fetch(`${base}/tasks/${sub.id}`, { signal: pctl.signal });
      clearTimeout(ptimer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      st = await r.json();
      pollErrors = 0;
    } catch (e) {
      clearTimeout(ptimer);
      if (++pollErrors >= 3) throw new Error(`本地转写轮询连续 ${pollErrors} 次失败: ${e.message}`);
      log(`本地转写轮询异常(${pollErrors}/3),继续重试:`, e.message);
      continue;
    } finally {
      clearTimeout(ptimer);
    }
    if (st.status === "done") {
      const { text, segments, hasSpeakers } = st.result || {};
      log(`本地转写完成: ${st.elapsedSec}s(含排队)`);
      return { text, segments: segments || [], hasSpeakers: !!hasSpeakers, mock: false };
    }
    if (st.status === "failed") throw new Error(`本地转写失败: ${st.error || "未知错误"}`);
    if ((Date.now() - t0) / 1000 > (cfg.timeoutSec || DEFAULT_TIMEOUT_SEC)) {
      throw new Error("本地转写超时");
    }
  }
}

module.exports = { transcribe };
