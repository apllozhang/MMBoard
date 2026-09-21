/**
 * 讯飞录音文件转写适配层 —— 官方四步协议(2026-09 与 https://www.xfyun.cn/doc/asr/lfasr/API.html 逐字段核对)
 *   prepare(app_id/signa/ts/file_len/file_name/slice_num) → task_id
 *   upload(multipart: app_id/signa/ts/task_id/slice_id/content=二进制分片, slice_id 为 26 进制自增)
 *   merge(app_id/signa/ts/task_id) → 触发转写
 *   getProgress(status=9) → getResult(data=句子数组[{bg,ed,onebest,speaker}])
 * 认证: signa = base64(HmacSHA1(MD5(app_id+ts), secretKey));SecretKey 取控制台"录音文件转写"页的 SecretKey(两件套)。
 * 无密钥走 mock(确定性示例文本),保证全链路无密钥可演示。
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE = "https://raasr.xfyun.cn/api";
const CHUNK = 10 * 1024 * 1024;          // 官方建议分片 10MB
const POLL_INTERVAL = 5000;
const POLL_TIMEOUT = 30 * 60 * 1000;

/** 4.1 配置 schema 统一:settings/密钥文件统一为 appId+apiKey+apiSecret;
 *  旧字段 secretKey 作为 apiSecret 的别名兼容。返回规范化配置。 */
function normalizeCfg(cfg) {
  if (!cfg || typeof cfg !== "object") return { appId: "", apiKey: "", apiSecret: "" };
  const trimReal = (v) => {
    const s = String(v || "").trim();
    return s.startsWith("在此") ? "" : s;   // example 占位符不算已配置
  };
  return {
    appId: trimReal(cfg.appId),
    apiKey: trimReal(cfg.apiKey),
    apiSecret: trimReal(cfg.apiSecret || cfg.secretKey),
    language: cfg.language,
    roleType: cfg.roleType,
    demo: !!cfg.demo,
  };
}

function hasKeys(cfg) {
  const c = normalizeCfg(cfg);
  // 录音文件转写(lfasr)真实签名仅需 appId+apiSecret(secretKey);apiKey 为其他讯飞服务的可选项
  return !!(c.appId && c.apiSecret);
}

function makeSigna(appId, apiSecret) {
  const ts = String(Math.floor(Date.now() / 1000));
  const md5 = crypto.createHash("md5").update(appId + ts).digest("hex");
  const signa = crypto.createHmac("sha1", apiSecret).update(md5).digest("base64");
  return { ts, signa };
}

/** R17:单请求超时(30s),防止讯飞接口挂起拖死任务 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch (e) {
    if (e.name === "AbortError") throw new Error(`讯飞请求超时(${timeoutMs / 1000}s): ${url}`);
    throw e;
  } finally { clearTimeout(t); }
}

async function postForm(ep, params) {
  const res = await fetchWithTimeout(`${BASE}/${ep}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`讯飞 ${ep} HTTP ${res.status}`);
  return res.json();
}

async function uploadSlice(appId, secretKey, taskId, sliceId, content) {
  const { ts, signa } = makeSigna(appId, secretKey);
  const boundary = "----symphony" + crypto.randomBytes(8).toString("hex");
  const fields = [
    ["app_id", appId], ["signa", signa], ["ts", ts], ["task_id", taskId], ["slice_id", sliceId],
  ];
  const parts = fields.map(([k, v]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="slice"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(content, Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await fetchWithTimeout(`${BASE}/upload`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  }, 10 * 60 * 1000);   // 大分片上传给足时间
  if (!res.ok) throw new Error(`讯飞 upload HTTP ${res.status}`);
  return res.json();
}

/** slice_id:10 字符 26 进制自增,第 n 片(1 起) */
function sliceId(n) {
  let s = "aaaaaaaaaa";
  for (let i = 0; i < n - 1; i++) {
    const arr = s.split("");
    let pos = arr.length - 1;
    while (pos >= 0) {
      if (arr[pos] !== "z") { arr[pos] = String.fromCharCode(arr[pos].charCodeAt(0) + 1); break; }
      arr[pos] = "a"; pos--;
    }
    s = arr.join("");
  }
  return s;
}

/** 转写入口。返回 { text, mock } —— text 为按句换行的纯文本 */
async function transcribe(audioPath, cfg, log = console.log) {
  const nc = normalizeCfg(cfg);
  if (!hasKeys(nc)) {
    // R06 复审:生产缺配置必须显式失败;mock 仅在显式 demo 开关(MMB_DEMO=1 或配置 demo:true)下允许
    if (!nc.demo) {
      throw new Error("讯飞转写未配置(appId/apiKey/apiSecret 不完整),且未开启演示模式(MMB_DEMO=1)——拒绝静默生成模拟内容");
    }
    log("[iflytek] 演示模式 → mock 转写");
    return { text: mockTranscript(audioPath), mock: true };
  }
  const appId = nc.appId, secretKey = nc.apiSecret;
  const file = fs.readFileSync(audioPath);
  const sliceNum = Math.ceil(file.length / CHUNK);

  /* 1) prepare → task_id */
  let { ts, signa } = makeSigna(appId, secretKey);
  const prep = await postForm("prepare", {
    app_id: appId, signa, ts,
    file_len: String(file.length),
    file_name: path.basename(audioPath),
    slice_num: String(sliceNum),
    language: cfg.language || "cn",     // 中文普通话默认;英文会议可配 "en"
    roleType: cfg.roleType === false ? "0" : "1",   // 角色分离(现行 API 参数;结果句带 speaker)
  });
  if (prep.ok !== 0) throw new Error(`讯飞 prepare 失败: ${prep.err_no} ${prep.failed ?? ""}`.trim());
  const taskId = prep.data;
  log(`[iflytek] task_id=${taskId} 分片=${sliceNum}`);

  /* 2) upload 分片(multipart, content=二进制) */
  for (let i = 0; i < sliceNum; i++) {
    const r = await uploadSlice(appId, secretKey, taskId, sliceId(i + 1), file.subarray(i * CHUNK, (i + 1) * CHUNK));
    if (r.ok !== 0) throw new Error(`讯飞 upload 分片${i + 1} 失败: ${r.err_no} ${r.failed ?? ""}`.trim());
  }

  /* 3) merge 触发转写 */
  ({ ts, signa } = makeSigna(appId, secretKey));
  const merged = await postForm("merge", { app_id: appId, signa, ts, task_id: taskId });
  if (merged.ok !== 0) throw new Error(`讯飞 merge 失败: ${merged.err_no} ${merged.failed ?? ""}`.trim());

  /* 4) 轮询 getProgress(status=9) → getResult */
  const deadline = Date.now() + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    ({ ts, signa } = makeSigna(appId, secretKey));
    const p = await postForm("getProgress", { app_id: appId, signa, ts, task_id: taskId });
    if (p.ok !== 0) throw new Error(`讯飞 getProgress 失败: ${p.err_no} ${p.failed ?? ""}`.trim());
    const status = typeof p.data === "string" ? JSON.parse(p.data).status : p.data?.status;
    log(`[iflytek] progress status=${status}`);
    if (status === 9) {
      ({ ts, signa } = makeSigna(appId, secretKey));
      const r = await postForm("getResult", { app_id: appId, signa, ts, task_id: taskId });
      if (r.ok !== 0) throw new Error(`讯飞 getResult 失败: ${r.err_no} ${r.failed ?? ""}`.trim());
      const rows = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      const segs = (rows ?? [])
        .filter((x) => x && x.onebest)
        .map((x) => ({
          start: Number(x.bg) || 0,
          end: Number(x.ed) || 0,
          speaker: String(x.speaker ?? "").trim(),
          text: String(x.onebest).trim(),
        }));
      if (!segs.length) throw new Error("讯飞转写结果为空");
      const hasSpeakers = segs.some((s) => s.speaker);
      const fmt = (ms) => {
        const s = Math.round(ms / 1000);
        return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      };
      // 同一说话人的连续句合并为一行:[MM:SS] 说话人N: 内容;无角色则只带时间戳
      const lines = [];
      let last = null;
      for (const s of segs) {
        const head = `[${fmt(s.start)}]` + (hasSpeakers ? ` 说话人${s.speaker || "?"}:` : "");
        if (hasSpeakers && s.speaker && s.speaker === last && lines.length) {
          lines[lines.length - 1].text += " " + s.text;
        } else {
          lines.push({ head, text: s.text });
        }
        last = s.speaker;
      }
      const text = lines.map((l) => `${l.head} ${l.text}`).join("\n");
      return { text, segments: segs, hasSpeakers, mock: false };
    }
    if (status === -1) throw new Error("讯飞转写任务失败(status=-1)");
  }
  throw new Error(`讯飞转写轮询超时(${POLL_TIMEOUT / 60000} 分钟)`);
}

function basename(p) { return p.replace(/\\/g, "/").split("/").pop(); }

/** mock:确定性示例转写(演示链路用) */
function mockTranscript(audioPath) {
  const name = basename(audioPath);
  return [
    "大家好,现在开始本周的平台组例会,我先过一下上周的行动项。",
    "上周提到的登录接口 415 错误,张伟已经修复并合入了主干,回归测试全绿。",
    "第二个议题是季度报表分页失效的问题,初步定位是前端分页参数没有随筛选联动,李娜本周出修复方案。",
    "关于下月的客户培训,市场部希望我们出一版新的演示环境,数据用脱敏样本,王强负责环境搭建。",
    "预算方面,服务器扩容申请已经批复,下周完成采购流程,预计不影响上线计划。",
    "最后确认一下:纪要我会整理后发邮件,行动项负责人按节点更新状态。散会。",
  ].map((s, i) => `${name} [00:${String(i * 45).padStart(2, "0")}] ${s}`).join("\n");
}

module.exports = { transcribe, hasKeys, normalizeCfg };
