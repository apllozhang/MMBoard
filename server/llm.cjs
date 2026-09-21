/**
 * LLM 分析适配层 —— OpenAI 兼容协议(/chat/completions)
 * 智谱 GLM / DeepSeek / 通义 / 本地 vLLM/Ollama(OpenAI 兼容端点)通吃:
 * 配置 meeting.secret.json → llm: { baseUrl, apiKey, model },无配置走 mock。
 * 输出统一为结构化 JSON(纪要骨架),失败时抛错由流水线标记 failed。
 * ⚠ 用原生 https 而非 fetch:undici 默认 300s 等不到响应头就掐连接(fetch failed),
 *   大输入+长生成(34000 字→16384 tokens)会稳挂;原生 socket 空闲超时自控 20 分钟。
 */
"use strict";
const https = require("https");
const http = require("http");
const net = require("net");
const dns = require("dns").promises;

/* ── R05:LLM 地址白名单——协议/解析目的校验,默认拒绝私网与保留地址 ──
 * 内网部署的本地模型(vLLM/Ollama)需在 settings.json 显式 "allowPrivateLlmHosts": true;
 * 云元数据地址(169.254.169.254)无条件拒绝。原生 https.request 不跟随重定向,无跳转绕过。 */
function isPrivateIp(ip) {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return true;                 // 环回/私网/保留
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;                           // 链路本地/云元数据
    return false;
  }
  if (net.isIPv6(ip)) return ip === "::1" || ip === "::" || /^(f[cd]|fe[89ab])/i.test(ip);
  return false;
}

async function assertLlmUrl(urlStr, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(urlStr)); } catch { throw new Error("LLM 地址格式无效"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("LLM 地址仅允许 http/https 协议");
  if (/metadata/i.test(u.hostname)) throw new Error("LLM 地址指向云元数据端点,无条件拒绝");
  let addrs;
  if (net.isIP(u.hostname)) addrs = [u.hostname];
  else {
    try { addrs = (await dns.lookup(u.hostname, { all: true })).map((x) => x.address); }
    catch (e) { throw new Error(`LLM 地址无法解析(${u.hostname}): ${e.message}`); }
  }
  if (addrs.some((ip) => ip === "169.254.169.254")) {
    throw new Error("LLM 地址指向云元数据端点,无条件拒绝");
  }
  if (!allowPrivate && addrs.some(isPrivateIp)) {
    throw new Error("LLM 地址解析到内网/保留地址,已拒绝;如确需内网模型服务,请在 settings.json 配置 allowPrivateLlmHosts: true");
  }
  return true;
}

/** POST JSON,空闲超时默认 20 分钟,返回 {status, text} */
function postJson(urlStr, headers, bodyObj, timeoutMs = 20 * 60 * 1000) {
  // R17:空闲超时 + 总截止(25min)+ 响应体上限(10MB)
  const DEADLINE_MS = 25 * 60 * 1000;
  const MAX_BODY = 10 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "http:" ? http : https;
    const body = Buffer.from(JSON.stringify(bodyObj), "utf8");
    const req = mod.request(u, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": body.length },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy(new Error(`LLM 响应超过 ${MAX_BODY / 1048576}MB 上限`));
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error(`LLM 请求空闲超时(${Math.round(timeoutMs / 60000)} 分钟无数据)`)));
    const deadline = setTimeout(() => req.destroy(new Error(`LLM 请求总耗时超过 ${Math.round(DEADLINE_MS / 60000)} 分钟`)), DEADLINE_MS);
    req.on("error", (e) => { clearTimeout(deadline); reject(e); });
    req.on("close", () => clearTimeout(deadline));
    req.end(body);
  });
}

/** 分析转写文本 → 结构化纪要数据(双协议:anthropic Messages / openai chat.completions)
 *  R17+:瞬态失败(空正文/超时/解析失败)自动重试一次——GLM-5.3-Flash 偶发把预算全部
 *  花在思考上(响应 0 字 stop=max_tokens),同输入重试即可成功 */
async function analyze(transcript, cfg, log = console.log) {
  const provider = cfg?.provider === "anthropic" ? "anthropic" : "openai";
  const usable = cfg && cfg.baseUrl && cfg.apiKey && cfg.model && !cfg.apiKey.startsWith("在此");
  if (!usable) {
    log("[llm] 未配置 → mock 分析");
    return { ...mockAnalysis(transcript), mock: true };
  }
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await analyzeOnce(transcript, cfg, provider, log, attempt);
    } catch (e) {
      lastErr = e;
      if (e.noRetry || attempt === 2) throw e;   // R17:确定性错误与末次直接抛
      log(`[llm] 第 1 次调用失败(${String(e.message).slice(0, 80)}),3s 后自动重试`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function analyzeOnce(transcript, cfg, provider, log = console.log) {
  await assertLlmUrl(cfg.baseUrl, { allowPrivate: !!cfg.allowPrivate });   // R05:发请求前校验地址
  samplingTruncatedFlag.value = false;
  const { prompt, truncated: samplingTruncated, coverage } = buildPrompt(transcript);
  const system = "你是专业的会议纪要分析师。只输出 JSON,不要输出任何其他文字。";
  console.log(`[llm] 模型=${cfg.model} 转写 ${transcript.length} 字 → 提示 ${prompt.length} 字${samplingTruncated ? `(采样覆盖率约 ${coverage}%)` : ""}`);

  let res, j;
  if (provider === "anthropic") {
    // Anthropic Messages 协议(智谱 anthropic 兼容端点等)
    res = await postJson(`${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    }, {
      model: cfg.model,
      max_tokens: 16384,   // 求同存疑等章节加入后,8192 会被截断(无闭合括号)
      system,
      messages: [{ role: "user", content: prompt }],
    });
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`LLM API HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      if (res.status >= 400 && res.status < 500) err.noRetry = true;   // R17:确定性错误不重试
      throw err;
    }
    j = JSON.parse(res.text);
    const content = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const stopReason = j.stop_reason ?? "-";
    const thought = (j.content ?? []).some((b) => b.type === "thinking");
    console.log(`[llm] 响应 ${content.length} 字 stop=${stopReason}${thought ? " (含思考块)" : ""}`);
    if (!content.trim()) {
      // R17:思考预算耗尽时 GLM 可能正文为空——必须显式失败(触发重试),不能当空串解析
      throw new Error(`GLM 返回空正文(stop=${stopReason}${thought ? ",仅思考块" : ""})——思考预算耗尽或服务异常`);
    }
    // R14:输出结构规范化 + 截断/采样标记(部分结果不得冒充完整纪要)
    const { obj, partial } = extractJson(content);
    return { ...normalizeAnalysis(obj), mock: false,
             partial: partial || (stopReason !== "end_turn" && stopReason !== "-"),
             samplingTruncated, samplingCoverage: coverage };
  }

  // OpenAI 兼容协议
  res = await postJson(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    Authorization: `Bearer ${cfg.apiKey}`,
  }, {
    model: cfg.model,
    max_tokens: 16384,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
  });
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`LLM API HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    if (res.status >= 400 && res.status < 500) err.noRetry = true;
    throw err;
  }
  j = JSON.parse(res.text);
  const content = j.choices?.[0]?.message?.content ?? "";
  const stopReason = j.choices?.[0]?.finish_reason ?? "-";
  console.log(`[llm] 响应 ${content.length} 字 stop=${stopReason}`);
  if (!content.trim()) {
    throw new Error(`GLM 返回空正文(stop=${stopReason})——思考预算耗尽或服务异常`);
  }
  const { obj, partial } = extractJson(content);
  return { ...normalizeAnalysis(obj), mock: false,
           partial: partial || (stopReason !== "stop" && stopReason !== "-"),
           samplingTruncated, samplingCoverage: coverage };
}

/** R14:LLM 输出结构规范化——类型不符纠正、缺失补空,模板渲染永不因字段异常崩溃 */
function normalizeAnalysis(a) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
  const str = (v) => (typeof v === "string" ? v : (v == null ? "" : String(v)));
  const strArr = (v) => (Array.isArray(v) ? v.map(str).filter((x) => x.trim()) : []);
  if (!a || typeof a !== "object" || Array.isArray(a)) a = {};
  // R14 复审:区分"明确返回空"与"字段缺失/类型错误"(缺失者标 partial,模板不得显示为"无")
  const REQUIRED = ["title", "summary", "topics", "decisions", "actions"];
  const missingFields = REQUIRED.filter((k) => !(k in a) || a[k] == null);
  return {
    missingFields,
    summary: str(a.summary),
    topics: arr(a.topics).map((t) => ({ heading: str(t.heading), person: str(t.person), detail: str(t.detail) })),
    decisions: strArr(a.decisions),
    actions: arr(a.actions).map((x) => ({ owner: str(x.owner), item: str(x.item), due: str(x.due),
                                          quote: typeof x.quote === "string" ? x.quote : "",
                                          tref: typeof x.tref === "string" ? x.tref : "" })),
    risks: strArr(a.risks),
    highlights: strArr(a.highlights),
    strengths: arr(a.strengths).map((x) => ({
      person: str(x.person),
      items: arr(x.items).map((it) => (typeof it === "object"
        ? { title: str(it.title), detail: str(it.detail) }
        : { title: str(it), detail: "" })),
    })),
    weaknesses: arr(a.weaknesses).map((x) => ({ person: str(x.person), items: strArr(x.items) })),
    comparison: arr(a.comparison).map((x) => ({ dimension: str(x.dimension), best: str(x.best), reason: str(x.reason) })),
    suggestions: arr(a.suggestions).map((x) => ({
      person: str(x.person),
      items: arr(x.items).map((it) => (typeof it === "object"
        ? { title: str(it.title), detail: str(it.detail) }
        : { title: str(it), detail: "" })),
    })),
    consensus: arr(a.consensus).map((c) => ({ person: str(c.person), viewpoint: str(c.viewpoint), basis: str(c.basis) })),
    doubts: arr(a.doubts).map((d) => ({ person: str(d.person), claim: str(d.claim), issue: str(d.issue), basis: str(d.basis), kw: str(d.kw) })),
    partial: !!a.partial || missingFields.length > 0,
    missingFields,
    samplingTruncated: !!a.samplingTruncated,
  };
}

/** R13/R15:buildPrompt 是否走了采样(经此标记传入分析结果,供模板标注覆盖范围) */
const samplingTruncatedFlag = { value: false };

function buildPrompt(transcript) {
  // 长会采样:全量 ≤ LIMIT 直接用;超限保留【开头(议程/背景)+结尾(决议/行动项)】,中段按整行略去。
  // R13:换行搜索限距 2000(稀疏换行/单行长文本不再撑爆预算);组装后仍有硬预算兜底。
  const LIMIT = 42000, HEAD = 34000, TAIL = 6000, LOOKAHEAD = 2000, MIDDLE_KEEP = 12000;
  let input = transcript;
  let truncated = false;
  let coverage = 100;
  if (transcript.length > LIMIT) {
    truncated = true;
    const nlAfter = (n) => { const k = transcript.indexOf("\n", n); return (k > 0 && k <= n + LOOKAHEAD) ? k : n; };
    const nlBefore = (n) => { const k = transcript.lastIndexOf("\n", transcript.length - n); return (k > 0 && k >= transcript.length - n - LOOKAHEAD) ? k + 1 : transcript.length - n; };
    const hEnd = nlAfter(HEAD), tStart = nlBefore(TAIL);
    const head = transcript.slice(0, hEnd);
    const tail = transcript.slice(tStart);
    const middle = transcript.slice(hEnd, tStart);
    // R13 复审:中段按行均匀采样保留 MIDDLE_KEEP 字符(不再整体丢弃),覆盖率随采样标注
    let midKept = middle;
    if (middle.length > MIDDLE_KEEP) {
      const rows = middle.split("\n");
      const avg = middle.length / Math.max(1, rows.length);
      const K = Math.max(2, Math.floor(MIDDLE_KEEP / Math.max(1, avg)));
      const step = rows.length / K;
      const picked = [];
      for (let i = 0; i < rows.length; i += step) picked.push(rows[Math.floor(i)]);
      midKept = picked.join("\n");
    }
    coverage = Math.round(((head.length + tail.length + midKept.length) / transcript.length) * 100);
    input = head + `\n[……中段已按时间均匀采样,覆盖率约 ${coverage}%……]\n` + midKept + "\n" + tail;
    if (input.length > LIMIT) input = input.slice(0, HEAD) + "\n[……中段省略……]\n" + input.slice(-TAIL);   // 硬预算兜底
    samplingTruncatedFlag.value = true;
  }
  const prompt = `请把以下会议转写整理成深度结构化纪要,严格只输出一个 JSON(不要任何其他文字)。
转写为逐句文本,每行格式:「[MM:SS] 说话人N: 内容」(N 是讯飞角色分离的编号,不一定对应真实姓名)。
结构分两大部分:「记录」(必有)与「点评」(内容支撑得起才输出,支撑不起则对应字段给空数组)。
所有分析必须引用转写里的真实细节(可用「」引用原话),禁止编造。
person 字段一律原样填写「说话人N」(N 为该行标注的说话人编号),禁止自行推测或还原真实姓名——
真实姓名由系统在展示阶段按人工标注映射。字段全部保留:

{
  "title": "会议标题(≤20字)",
  "summary": "整体摘要,2-4 句,概括议程与结论",
  "topics": [{ "heading": "议题/板块名", "person": "主讲人,无则空串", "detail": "讨论要点,2-3 句" }],
  "decisions": ["达成的决议,每条一句"],
  "actions": [{ "owner": "负责人", "item": "待办事项", "due": "时间节点,无则空串", "tref": "来源时间范围如 05:12-07:40(取自行首时间戳,可选)", "quote": "支撑该行动项的原始发言片段(可选,禁止编造)" }],
  "risks": ["风险与待确认事项"],
  "highlights": ["亮点点评,每条一句,引用具体细节"],
  "strengths": [{ "person": "讲者/部门名", "items": [{ "title": "维度名(如 能力拆分/实用价值/高光环节)", "detail": "具体分析,2-3句" }] }],
  "weaknesses": [{ "person": "讲者/部门名", "items": ["1. 缺点,一句概括+具体依据(重点:客观、可执行)"] }],
  "comparison": [{ "dimension": "对比维度(如 最有故事感)", "best": "表现最佳者", "reason": "理由一句话" }],
  "suggestions": [{ "person": "对象", "items": [{ "title": "建议/改稿方案名", "detail": "可执行做法,含时间/步骤则写明" }] }],
  "consensus": [{ "person": "讲者", "viewpoint": "被认可的观点(引用原话或精确概括)", "basis": "认可理由:符合行业现状/主流实践/公开标准的哪一点" }],
  "doubts": [{ "person": "讲者", "claim": "存疑观点(引用原话)", "issue": "存疑/不合理之处,客观对事不对人", "basis": "查证方向(如 IEEE 802.1Q、厂商官方文档名、知名行业报告),无把握写空串", "kw": "检索关键词 2-4 个" }]
}
「求同存疑」纪律(最高优先):① consensus 只列确有行业现状/主流实践/公开标准支撑的观点,严禁客套式表扬;② doubts 只在存在具体理由(与主流实践/公开标准/已知事实相悖,或逻辑跳跃、证据不足)时列出,必须点名到人并引用原话,绝不硬凑;③ **绝不生成任何 URL/链接**——查证方向只写来源名称,检索关键词会由系统渲染为搜索入口,由人工核实;④ 若所有观点确凿无疑,doubts 诚实地给空数组。
${truncated ? `注意:转写较长,已按时间均匀采样(覆盖率约 ${coverage}%),请基于保留内容分析,不要臆测未覆盖部分,并在可能处标注来源时间范围。\n` : ""}
会议转写:
${input}`;
  return { prompt, truncated, coverage };
}

/** 截断 JSON 修复:扫描字符串/转义状态,截到最后一个完整顶层成员,按该时刻的栈闭合剩余结构 */
function repairTruncatedJson(src) {
  let inStr = false, esc = false;
  const stack = [];
  let lastSafe = -1, safeStack = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") { stack.push(c); continue; }
    if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 1) { lastSafe = i + 1; safeStack = stack.slice(); }   // 快照此刻的栈
      if (stack.length === 0) return src;         // 本就完整
    }
  }
  if (lastSafe <= 0 || !safeStack) return null;
  let cut = src.slice(0, lastSafe).replace(/[,:\s]+$/, "");
  for (let i = safeStack.length - 1; i >= 0; i--) cut += safeStack[i] === "{" ? "}" : "]";
  return cut;
}

/** 宽容解析:模型偶尔包 ```json 围栏、在字符串里输出裸控制字符(换行/制表)、或被 max_tokens 截断(无闭合括号) */
function extractJson(text) {
  let lastErr = "";
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    // 控制字符在 JSON 字符串里非法,替换为空格(内容影响可忽略)
    const cleaned = m[0].replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
    try { return { obj: JSON.parse(cleaned), partial: false }; }
    catch (e) { lastErr = e.message; }
  }
  // 截断修复:保留已完成字段(后置章节缺失由 normalizeAnalysis 兜底),并标记 partial
  const src = m ? m[0] : text;
  const repaired = repairTruncatedJson(src);
  if (repaired) {
    try {
      const obj = JSON.parse(repaired.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " "));
      console.log(`[llm] 输出疑似被截断,已修复为部分纪要(${Object.keys(obj).length} 个字段)`);
      return { obj, partial: true };
    } catch { /* 继续走报错 */ }
  }
  throw new Error("LLM 未返回可解析 JSON(" + (lastErr || "无闭合括号").slice(0, 80) + "): " +
    src.slice(0, 80) + " ……尾部: " + src.slice(-60));
}

function mockAnalysis(transcript) {
  return {
    title: "平台组周例会(mock)",
    summary: "本次会议过上周行动项,围绕报表分页缺陷修复、客户培训演示环境准备与服务器扩容预算进行了讨论,并明确了各项负责人与时间节点。(当前为 mock 分析,接入 LLM 后自动生成真实内容)",
    topics: [
      { heading: "上周行动项回顾", detail: "登录接口 415 错误已修复合入主干,回归测试全绿。" },
      { heading: "季度报表分页缺陷", detail: "定位为前端分页参数未随筛选联动,本周出修复方案。" },
      { heading: "客户培训准备", detail: "需要脱敏样本数据的演示环境,由环境组搭建。" },
      { heading: "服务器扩容", detail: "预算已批复,走采购流程,不影响上线计划。" },
    ],
    decisions: [
      "登录接口修复方案通过并合并",
      "演示环境统一使用脱敏样本数据",
      "扩容采购下周内完成",
    ],
    actions: [
      { owner: "李娜", item: "输出报表分页修复方案", due: "本周五" },
      { owner: "王强", item: "搭建客户培训演示环境", due: "下周五" },
      { owner: "主持人", item: "整理会议纪要并发邮件", due: "今日" },
    ],
    risks: [
      "报表分页缺陷影响季度数据导出,需在季度结算前修复",
      "演示环境数据脱敏标准待市场部确认",
    ],
  };
}

module.exports = { analyze, buildPrompt, normalizeAnalysis, extractJson, assertLlmUrl, isPrivateIp };   // 后四者导出供回归测试
