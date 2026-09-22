/**
 * ALE 会议纪要模板生成器 —— docs/prompts/提示词样例.md「模板一(文档类)」的服务端实现
 * 硬约束:真实 Logo(亮暗 base64 内嵌,禁止仿制) · 全套令牌 CSS 变量 · 3px 主紫顶条 ·
 *         版本徽章与文件名一致 · 官方商标行 · 双主题+reduced-motion+焦点可见 · 320 无溢出
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "..", "public", "assets");
const VENDOR = path.join(__dirname, "..", "vendor");
const logoB64 = (f) => `data:image/png;base64,${fs.readFileSync(path.join(ASSETS, f)).toString("base64")}`;

/* ECharts(自托管 vendor/echarts.min.js;缺文件时图表降级为纯数据表) */
let echartsSrc = "";
try {
  echartsSrc = fs.readFileSync(path.join(VENDOR, "echarts.min.js"), "utf8")
    .replace(/<\/script/g, "<\\/script").replace(/<!--/g, "<\\!--");
} catch { /* vendor 未部署 → 纯数据表 */ }

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ── 说话人姓名映射(二轮复审 §5.1:姓名只在最终渲染层映射) ──
 * canonical 原则:analysis/transcript 全程只含「说话人N」稳定标识;
 * 本模块在渲染前把编号替换为当前人工标注名,任意次改名都不会残留旧姓名。 */
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

/* ── R15 三轮:行动项证据真实性强校验 ──
 * quote 必须能在转写全文中(去空白后)找到;tref 必须是合法时间范围且与转写 segment 重叠。
 * 校验结果写入 quoteState/trefState:verified(核验通过)/ unverified(附了但没核验到)/ invalid(格式错)/ none(未附)。
 * 校验需转写原文上下文,由流水线在分析完成后调用一次并随 analysis.json 持久化。 */
function verifyActionEvidence(analysis, transcriptText, segments) {
  const norm = (s) => String(s || "").replace(/\s+/g, "");
  const text = norm(transcriptText);
  for (const a of analysis?.actions || []) {
    a.quoteState = "none";
    a.trefState = "none";
    if (a.quote && String(a.quote).trim()) {
      a.quoteState = text.includes(norm(a.quote)) ? "verified" : "unverified";
    }
    const m = a.tref ? /^(\d{1,3}):([0-5]\d)\s*-\s*(\d{1,3}):([0-5]\d)$/.exec(String(a.tref).trim()) : null;
    if (a.tref && String(a.tref).trim()) {
      if (!m) { a.trefState = "invalid"; }
      else {
        const from = (+m[1]) * 60000 + (+m[2]) * 1000;
        const to = (+m[3]) * 60000 + (+m[4]) * 1000;
        const overlap = (segments || []).some((sg) => Number(sg.start) < to && Number(sg.end) > from);
        a.trefState = overlap ? "verified" : "unverified";
      }
    }
  }
  return analysis;
}

/** 行动项证据状态的可读标注(模板内联使用) */
function evidenceBadge(a) {
  if (a.quoteState === "unverified") return '<span class="tref-warn">所附原文未在转写中核验到</span>';
  if (a.trefState === "unverified") return '<span class="tref-warn">所附时间范围未与转写对齐</span>';
  if (a.trefState === "invalid") return '<span class="tref-warn">所附时间范围格式无法解析</span>';
  return "";
}

/** R06/R15:模拟数据、采样覆盖、输出截断——任一情况全程醒目标识(含移动端,不隐藏) */
function noticeBannerHtml(meta, a) {
  const tags = [];
  if (meta.transcriptionMode === "mock") tags.push("转写为演示模拟数据");
  if (meta.analysisMode === "mock") tags.push("AI 分析为演示模拟数据");
  if (a && a.samplingTruncated) tags.push("分析基于转写采样(非全文,部分中段未覆盖)");
  if (a && a.partial) tags.push("AI 输出被截断或字段缺失,本纪要为部分结果");
  if (a && Array.isArray(a.missingFields) && a.missingFields.length) {
    tags.push(`分析未生成章节:${a.missingFields.map(esc).join("、")}`);
  }
  if (!tags.length) return "";
  const label = tags.some((x) => x.includes("演示")) ? "演示数据" : "内容完整性提示";
  return `<div class="mock-banner" role="note">⚠ ${esc(label)}:${tags.map(esc).join(";")}</div>`;
}

/** 生成纪要 HTML。返回 { html, fileName } */
const { normalizeAnalysis } = require("./llm.cjs");

function renderMinutes({ analysis, meta }) {
  // R14 防御深度:无论来源,渲染前统一规范化(类型不符纠正、缺失补空),模板永不因字段异常崩溃
  const a = normalizeAnalysis(analysis);
  const date = meta.date || String(meta.generatedAt || "").slice(0, 10) || "unknown";   // YYYY-MM-DD(pipeline 必传;容错兜底)
  const stamp = date.replace(/-/g, "");            // YYYYMMDD
  const slug = (a.title || "meeting-minutes").replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 30).replace(/^-|-$/g, "") || "meeting-minutes";
  const fileName = `${slug}-v0.1-${stamp}.html`;   // 徽章与文件名一致(模板一约定)
  const version = `v0.1 · ${date}`;

  const topics = (a.topics || []).map((t) => `
      <section class="topic">
        <h3>${esc(t.heading)}${t.person ? ` <span class="who">${esc(t.person)}</span>` : ""}</h3>
        <p>${esc(t.detail)}</p>
      </section>`).join("\n");

  const decisions = (a.decisions || []).map((d) => `        <li>${esc(d)}</li>`).join("\n");

  const highlights = (a.highlights || []).length ? `
      <section id="highlights" class="sec">
        <h2 class="section-head">亮点点评</h2>
        <div class="card">
          <ul class="list">
${(a.highlights || []).map((h) => `            <li>${esc(h)}</li>`).join("\n")}
          </ul>
        </div>
      </section>` : "";

  const strengths = (a.strengths || []).length ? `
      <section id="strengths" class="sec">
        <h2 class="section-head">优点分析</h2>
${(a.strengths || []).map((s) => `
        <div class="card person">
          <h3 class="person-name">${esc(s.person)}</h3>
${(s.items || []).map((it) => `
          <div class="item">
            <h4>${esc(it.title)}</h4>
            <p>${esc(it.detail)}</p>
          </div>`).join("\n")}
        </div>`).join("\n")}
      </section>` : "";

  const weaknesses = (a.weaknesses || []).length ? `
      <section id="weaknesses" class="sec">
        <h2 class="section-head">客观复盘:缺点与不足<span class="em-tag">重点</span></h2>
${(a.weaknesses || []).map((s) => `
        <div class="card person warn">
          <h3 class="person-name">${esc(s.person)}</h3>
          <ol class="list">
${(s.items || []).map((it) => `            <li>${esc(it)}</li>`).join("\n")}
          </ol>
        </div>`).join("\n")}
      </section>` : "";

  const comparison = (a.comparison || []).length ? `
      <section id="comparison" class="sec">
        <h2 class="section-head">对比总览</h2>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th scope="col">维度</th><th scope="col">表现最佳</th><th scope="col">理由</th></tr></thead>
            <tbody>
${(a.comparison || []).map((c) => `              <tr><td>${esc(c.dimension)}</td><td class="best">${esc(c.best)}</td><td>${esc(c.reason)}</td></tr>`).join("\n")}
            </tbody>
          </table>
        </div>
      </section>` : "";

  const suggestions = (a.suggestions || []).length ? `
      <section id="suggestions" class="sec">
        <h2 class="section-head">建议与改进</h2>
${(a.suggestions || []).map((s) => `
        <div class="card person">
          <h3 class="person-name">${esc(s.person)}</h3>
${(s.items || []).map((it) => `
          <div class="item">
            <h4>${esc(it.title)}</h4>
            <p>${esc(it.detail)}</p>
          </div>`).join("\n")}
        </div>`).join("\n")}
      </section>` : "";

  const searchLink = (kw) => kw ? `<a class="ev-link" href="https://www.bing.com/search?q=${encodeURIComponent(kw)}" target="_blank" rel="noreferrer noopener">检索「${esc(kw)}」</a>` : "";
  const review = ((a.consensus || []).length || (a.doubts || []).length) ? `
      <section id="review-same-diff" class="sec">
        <h2 class="section-head">求同存疑 · 客观复盘</h2>
        <p class="ev-note">客观视角、对事不对人:「求同」列出与行业现状/规则相符、逻辑成立的观点;「存疑」点名待商榷处并附查证方向——检索链接仅为人工核实的入口,结论以核实结果为准。</p>
        ${(a.consensus || []).length ? `
        <div class="card">
          <h3 class="card-head ok">求同 · 已认可的观点</h3>
          <ul class="list">
${(a.consensus || []).map((c) => `            <li><b>${esc(c.person)}</b>:${esc(c.viewpoint)}<span class="why"> —— ${esc(c.basis)}</span></li>`).join("\n")}
          </ul>
        </div>` : ""}
        ${(a.doubts || []).length ? `
        <div class="card">
          <h3 class="card-head doubt">存疑 · 点名待商榷</h3>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th scope="col">讲者</th><th scope="col">观点(引用)</th><th scope="col">存疑理由</th><th scope="col">查证入口(需人工核实)</th></tr></thead>
              <tbody>
${(a.doubts || []).map((x) => `                <tr><td>${esc(x.person)}</td><td>${esc(x.claim)}</td><td>${esc(x.issue)}</td><td>${x.basis ? `<div class="basis">${esc(x.basis)}</div>` : ""}${x.kw ? searchLink(x.kw) : ""}</td></tr>`).join("\n")}
              </tbody>
            </table>
          </div>
        </div>` : ""}
      </section>` : "";

  /* 发言时长(ECharts 条形图;数据=讯飞时间戳真实统计;规范 app-workbench:类别比较→条形,配一句话摘要+数据表) */
  const talk = Array.isArray(meta.talkStats) ? meta.talkStats : [];
  const hasChart = !!(echartsSrc && talk.length >= 2);
  const talkChart = talk.length ? `
      <section id="talk-time" class="sec">
        <h2 class="section-head">发言时长</h2>
        <div class="card">
          <p class="chart-summary">各说话人累计发言时长(按转写时间戳统计):${talk.map((x) => `${esc(x.speaker)} ${x.pct}%`).join("、")}${talk.length >= 2 ? `——占比最高者为 ${esc(talk[0].speaker)}` : ""}。</p>
          ${hasChart ? `<div id="talk-chart" style="width:100%;height:${Math.max(180, talk.length * 56)}px"></div>` : ""}
          <details class="chart-data" ${hasChart ? "" : "open"}>
            <summary>时长数据表</summary>
            <table class="data">
              <thead><tr><th scope="col">说话人</th><th scope="col">累计时长</th><th scope="col">占比</th></tr></thead>
              <tbody>
${talk.map((x) => `                <tr><td>${esc(x.speaker)}</td><td class="num">${(x.ms / 60000).toFixed(1)} 分钟</td><td class="num">${x.pct}%</td></tr>`).join("\n")}
              </tbody>
            </table>
          </details>
        </div>
      </section>` : "";

  const actionRows = (a.actions || []).map((x) => {
    // R15 三轮:证据状态标注——verified 静默;unverified/invalid 明确警示;none 标模型推断
    const warn = evidenceBadge(x);
    const src = x.quote
      ? `依据原文:「${esc(x.quote)}」${x.tref ? `(${esc(x.tref)})` : ""}${warn ? " " + warn : ""}`
      : `<span class="tref-warn">模型推断,未附原文${x.tref ? `(时间 ${esc(x.tref)})${x.trefState && x.trefState !== "none" && x.trefState !== "verified" ? " ⚠ " + warn : ""}` : ""}</span>`;
    return `
          <tr>
            <td>${esc(x.owner || "—")}</td>
            <td>${esc(x.item)}<span class="quote-src">${src}</span></td>
            <td>${esc(x.due || "—")}</td>
          </tr>`;
  }).join("\n");

  const risks = (a.risks || []).length
    ? `
      <section id="risks" class="sec">
        <h2 class="section-head">风险与待确认</h2>
        <ul class="list">
${(a.risks || []).map((r) => `          <li>${esc(r)}</li>`).join("\n")}
        </ul>
      </section>`
    : "";

  // R06/R15:分析或转写任一环节为模拟、或结果不完整,即全程醒目标识
  const isMock = !!(a.mock || meta.transcriptionMode === "mock" || meta.analysisMode === "mock");
  const mockTag = isMock ? '<span class="badge-warn">模拟数据</span>' : "";
  const mockBanner = noticeBannerHtml(meta, a);

  return {
    fileName,
    html: `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(a.title || "会议纪要")} · ALE 会议纪要</title>
<style>
:root{
  --purple:#6b489d; --purple-deep:#4f3478; --purple-500:#7e5cb4;
  --purple-40:#e4d9f3; --purple-100:#f1ecf7;
  --canvas:#f7f7f5; --surface:#ffffff;
  --text:#1a1a1a; --text-2:#4b4d50; --text-3:#616467;
  --border:#d9d9d6; --border-soft:#e9e8e4;
  --info-bg:#e3f1f9; --info-text:#006aa2;
  --warn-bg:#fceedd; --warn-text:#9a4707;
  --radius-s:8px; --radius-m:12px; --radius-l:16px;
}
html.dark{
  --canvas:#171420; --surface:#211d2e;
  --text:#f2f1f6; --text-2:#c6c3cf; --text-3:#a5a1b0;
  --border:#3d3849; --border-soft:#322d3e;
  --purple-40:#3a2f52; --purple-100:#2b2340;
  --info-bg:#12283a; --warn-bg:#39281a;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--canvas);color:var(--text);
  font-family:"Trebuchet MS","Noto Sans SC",sans-serif;font-size:16px;line-height:1.65}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
:focus-visible{outline:2px solid var(--purple);outline-offset:2px;border-radius:2px}

.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:16px;
  min-height:64px;padding:0 16px;background:rgb(255 255 255 / 96%);backdrop-filter:blur(10px);
  border-bottom:3px solid var(--purple)}
html.dark .topbar{background:rgb(23 20 32 / 96%)}
.topbar img{height:30px;width:auto}
.logo-dark{display:none}
html.dark .logo-light{display:none}
html.dark .logo-dark{display:inline}
.topbar .divi{width:1px;height:24px;background:var(--border)}
.topbar .title{font-weight:700;font-size:15px;color:var(--text)}
.badge-ver{display:inline-flex;align-items:center;padding:.18em .7em;border:1px solid var(--purple-40);
  border-radius:999px;background:var(--purple-100);color:var(--purple-deep);font-size:12px;font-weight:700;white-space:nowrap}
html.dark .badge-ver{color:#c9b3ea}
.badge-warn{display:inline-flex;align-items:center;padding:.18em .7em;border-radius:999px;
  background:var(--warn-bg);color:var(--warn-text);font-size:12px;font-weight:700}
.topbar .grow{flex:1}
.theme-btn{position:relative;display:inline-grid;place-items:center;width:44px;height:44px;
  color:var(--text-2);background:transparent;border:1px solid transparent;border-radius:var(--radius-s);cursor:pointer;font-size:18px}
.theme-btn:hover{background:var(--purple-100);color:var(--purple)}

nav.toc{display:flex;flex-wrap:wrap;gap:4px 16px;padding:12px 16px;border-bottom:1px solid var(--border-soft)}
nav.toc a{color:var(--text-2);text-decoration:none;min-height:44px;display:inline-flex;align-items:center}
nav.toc a:hover{color:var(--purple)}
nav.toc a[aria-current="true"]{color:var(--purple);font-weight:700}

.hero{position:relative;overflow:hidden;background:linear-gradient(135deg,var(--purple-deep),var(--purple) 55%,var(--purple-500));
  color:#fff;padding:48px 16px 96px}
.hero .wrap{max-width:960px;margin:0 auto;position:relative;z-index:2}
.hero .wave{position:absolute;right:0;bottom:-2px;left:0;width:100%;height:90px;fill:var(--canvas)}
.hero h1{margin:0 0 8px;font-size:32px;line-height:1.2}
.hero p{margin:0;opacity:.92;font-size:15px}
.hero .meta{margin-top:16px;display:flex;flex-wrap:wrap;gap:6px 20px;font-size:13px;opacity:.85}

main{max-width:960px;margin:0 auto;padding:8px 16px 48px}
.sec{margin-top:40px}
.section-head{display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:22px}
.section-head::before{content:"";width:4px;height:22px;border-radius:2px;background:var(--purple)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-m);
  padding:20px;box-shadow:0 1px 2px rgb(0 0 0 / 5%)}
.topic h3{margin:0 0 4px;font-size:16px}
.topic p{margin:0;color:var(--text-2)}
.topic .who{display:inline-block;margin-left:6px;padding:.1em .6em;border-radius:999px;
  background:var(--purple-100);color:var(--purple-deep);font-size:12px;font-weight:600;vertical-align:1px}
html.dark .topic .who{color:#c9b3ea}
.card.person{margin-top:12px}
.card.person:first-of-type{margin-top:0}
.person-name{margin:0 0 8px;font-size:16px;color:var(--purple-deep)}
html.dark .person-name{color:#c9b3ea}
.card.person .item{padding:10px 0;border-top:1px solid var(--border-soft)}
.card.person .item h4{margin:0 0 4px;font-size:14px}
.card.person .item p{margin:0;color:var(--text-2);font-size:14px}
.card.person.warn{border-left:4px solid var(--warn-graphic,#f59e0b)}
.card.person.warn .person-name{color:var(--warn-text,#9a4707)}
html.dark .card.person.warn .person-name{color:#f5b04d}
.em-tag{display:inline-block;margin-left:8px;padding:.1em .6em;border-radius:999px;
  background:var(--warn-bg);color:var(--warn-text);font-size:12px;font-weight:700;vertical-align:3px}
table.data td.best{font-weight:700;color:var(--purple-deep);white-space:nowrap}
html.dark table.data td.best{color:#c9b3ea}
.topic{padding:12px 0;border-bottom:1px solid var(--border-soft)}
.topic:last-child{border-bottom:0;padding-bottom:0}
ol.list,ul.list{margin:0;padding-left:22px}
ol.list li,ul.list li{margin:6px 0}

table.data{width:100%;border-collapse:collapse;background:var(--surface);
  border:1px solid var(--border);border-radius:var(--radius-m);overflow:hidden;font-size:14px}
table.data th{background:var(--purple-100);color:var(--purple-deep);text-align:left;font-weight:700;white-space:nowrap}
html.dark table.data th{color:#c9b3ea}
table.data th,table.data td{padding:10px 12px;border-bottom:1px solid var(--border-soft)}
table.data tr:last-child td{border-bottom:0}
.table-wrap{overflow-x:auto}

/* 14A 列宽调整 + 发言时长图表 */
table.data{table-layout:fixed;width:100%}
table.data th{position:relative}
table.data th .grip{position:absolute;right:-2px;top:0;bottom:0;width:8px;cursor:col-resize;touch-action:none}
table.data th .grip:hover,table.data th .grip:focus-visible{background:var(--purple-500,#7e5cb4);opacity:.4}
table.data th .grip:focus-visible{outline:1px solid var(--purple,#6b489d);outline-offset:0}
.chart-summary{margin:0 0 10px;font-size:.9rem;color:var(--text-2)}
.chart-data{margin-top:10px}
.chart-data summary{cursor:pointer;color:var(--purple,#6b489d);font-weight:600;font-size:.9rem}

/* 求同存疑 · 客观复盘 */
.ev-note{margin:0 0 14px;font-size:.86rem;color:var(--text-3)}
.card-head{margin:0 0 10px;font-size:1rem}
.card-head.ok{color:var(--info-text)}
.card-head.doubt{color:var(--warn-text)}
.list .why{color:var(--text-3);font-size:.92em}
.basis{margin-bottom:4px;color:var(--text-2)}
.ev-link{display:inline-block;font-size:.84rem;color:var(--purple);border-bottom:1px dashed var(--purple);text-decoration:none}
.ev-link:hover{color:var(--purple-deep)}
html.dark .ev-link{color:var(--purple-40);border-bottom-color:var(--purple-40)}

footer{border-top:1px solid var(--border-soft);margin-top:56px;padding:20px 16px 40px;
  text-align:center;color:var(--text-3);font-size:12px}
footer .tm{margin:0 0 4px}

/* 窄屏(≤560px):版本徽章只显示短号,隐藏次要顶栏元素,防横向溢出(OVF-320 同款做法) */
@media (max-width:560px){
  .badge-ver .full{display:none}
  .badge-warn,.topbar .divi,.topbar .title{display:none}
  .topbar{gap:10px}
  .hero{padding:36px 16px}
  .hero h1{font-size:26px}
}
  .quote-src{display:block;margin-top:3px;font-size:12px;color:var(--color-text-muted)}
  .tref-warn{color:var(--status-warning-text)}
  .mock-banner{background:var(--status-warning-bg);color:var(--status-warning-text);font-weight:600;
    padding:10px 16px;text-align:center;font-size:13.5px;border-bottom:1px solid var(--color-border)}
  @media (max-width:560px){.mock-banner{font-size:12.5px;padding:9px 10px}}
</style>
</head>
<body>
${mockBanner}
<header class="topbar">
  <img src="${logoB64("ale-logo.png")}" alt="Alcatel-Lucent Enterprise" class="logo-light">
  <img src="${logoB64("ale-logo-white.png")}" alt="" class="logo-dark">
  <span class="divi" aria-hidden="true"></span>
  <span class="title">会议纪要</span>
  <span class="badge-ver"><span class="short">${esc(version.split(" · ")[0])}</span><span class="full"> · ${esc(version.split(" · ")[1])}</span></span>
  ${mockTag}
  <span class="grow"></span>
  <button type="button" class="theme-btn" id="themeBtn" aria-label="切换亮色/暗色主题">◐</button>
</header>

<nav class="toc" aria-label="页内导航">
  <a href="#summary">会议概要</a>
  <a href="#topics">议题与讨论</a>
  <a href="#decisions">决议事项</a>
  <a href="#actions">行动项</a>${(a.risks || []).length ? `
  <a href="#risks">风险与待确认</a>` : ""}${(a.highlights || []).length ? `
  <a href="#highlights">亮点点评</a>` : ""}${(a.strengths || []).length ? `
  <a href="#strengths">优点分析</a>` : ""}${(a.weaknesses || []).length ? `
  <a href="#weaknesses">缺点复盘</a>` : ""}${(a.comparison || []).length ? `
  <a href="#comparison">对比总览</a>` : ""}${(a.suggestions || []).length ? `
  <a href="#suggestions">建议</a>` : ""}${talkChart ? `
  <a href="#talk-time">发言时长</a>` : ""}${((a.consensus || []).length || (a.doubts || []).length) ? `
  <a href="#review-same-diff">求同存疑</a>` : ""}
</nav>

<div class="hero">
  <div class="wrap">
    <h1>${esc(a.title || "会议纪要")}</h1>
    <p>${esc(a.summary || "")}</p>
    <div class="meta">
      <span>上传时间:${esc(meta.uploadedAt || meta.date)}</span>
        <span>纪要生成:${esc(meta.generatedAt || meta.date)}</span>
        <span>会议日期:未提供</span>
      <span>来源:${esc(meta.fileName)}</span>
      <span>转写:${esc(String(meta.transcriptChars))} 字</span>
    </div>
  </div>
  <svg class="wave" viewBox="0 0 1440 90" preserveAspectRatio="none" aria-hidden="true"><path d="M0 50 C240 90 480 20 720 40 C960 60 1200 90 1440 50 L1440 90 L0 90 Z"/></svg>
</div>

<main>
  <section id="summary" class="sec">
    <h2 class="section-head">会议概要</h2>
    <div class="card"><p style="margin:0">${esc(a.summary || "")}</p></div>
  </section>

  <section id="topics" class="sec">
    <h2 class="section-head">议题与讨论</h2>
    <div class="card">${topics || "<p style=\"margin:0\">无</p>"}</div>
  </section>

  <section id="decisions" class="sec">
    <h2 class="section-head">决议事项</h2>
    <div class="card">
      <ol class="list">
${decisions || "        <li>无</li>"}
      </ol>
    </div>
  </section>

  <section id="actions" class="sec">
    <h2 class="section-head">行动项</h2>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th scope="col">负责人</th><th scope="col">事项</th><th scope="col">时间节点</th></tr></thead>
        <tbody>${actionRows || `
          <tr><td colspan="3" style="text-align:center">无</td></tr>`}
        </tbody>
      </table>
    </div>
  </section>
${risks}
${highlights}
${strengths}
${weaknesses}
${comparison}
${suggestions}
${talkChart}
${review}
</main>

<footer>
  <p class="tm">The Alcatel-Lucent name and logo are trademarks of Nokia used under license by ALE. www.al-enterprise.com</p>
  <p style="margin:0">ALE 会议纪要 · ${esc(version)}</p>
</footer>

<script>
(function(){
  var saved = localStorage.getItem("theme");
  var dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  apply();
  document.getElementById("themeBtn").addEventListener("click", function(){
    dark = !dark;
    localStorage.setItem("theme", dark ? "dark" : "light");
    apply();
  });
  function apply(){
    document.documentElement.classList.toggle("dark", dark);
    var btn = document.getElementById("themeBtn");
    if (btn) btn.setAttribute("aria-pressed", String(dark));
  }
})();
</script>
${talkChart ? `<script>${hasChart ? echartsSrc : ""}</` + `script>
${hasChart ? `<script>
(function(){
  var TALK = ${JSON.stringify(talk.map((x) => ({ ...x, speakerHtml: esc(x.speaker) }))).replace(/</g, "\\u003c")};
  var el = document.getElementById("talk-chart");
  if (!window.echarts || !el || !TALK.length) return;
  function dark(){ return document.documentElement.classList.contains("dark"); }
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var chart = echarts.init(el);
  function render(){
    var d = dark();
    chart.setOption({
      backgroundColor: "transparent",
      animation: !reduce,
      grid: { left: 96, right: 70, top: 8, bottom: 8 },
      xAxis: { type: "value", name: "分钟", nameTextStyle: { color: d ? "#a5a1b0" : "#616467" },
               axisLabel: { color: d ? "#a5a1b0" : "#616467" },
               splitLine: { lineStyle: { color: d ? "#3d3849" : "#d9d9d6" } } },
      yAxis: { type: "category", data: TALK.map(function(x){ return x.speaker; }).reverse(),
               axisLabel: { color: d ? "#c6c3cf" : "#1a1a1a" },
               axisLine: { lineStyle: { color: d ? "#3d3849" : "#d9d9d6" } } },
      tooltip: { trigger: "axis", formatter: function(ps){
        var p = ps[0]; var x = TALK[TALK.length - 1 - p.dataIndex];
        return x.speakerHtml + ": " + (x.ms / 60000).toFixed(1) + " 分钟(" + x.pct + "%)";
      } },
      series: [{ type: "bar", barMaxWidth: 26,
        data: TALK.map(function(x){ return x.ms / 60000; }).reverse(),
        itemStyle: { color: "#6b489d", borderRadius: [0, 6, 6, 0] },
        label: { show: true, position: "right",
                 formatter: function(p){ return TALK[TALK.length - 1 - p.dataIndex].pct + "%"; },
                 color: d ? "#c6c3cf" : "#616467" } }]
    }, true);
  }
  render();
  window.addEventListener("resize", function(){ chart.resize(); });
  document.getElementById("themeBtn").addEventListener("click", function(){ setTimeout(render, 60); });
})();
</script>` : ""}` : ""}
<script>
/* 14A 列宽调整:手柄 role=separator + tabindex=0 + ←/→ ±10(Shift ±1);拖哪列只有那列变(F14) */
(function(){
  function init(scope){
    scope.querySelectorAll("table.data").forEach(function(tb){
      if (tb.dataset.rsReady) return;
      tb.dataset.rsReady = "1";
      tb.style.tableLayout = "fixed";
      var ths = Array.prototype.slice.call(tb.querySelectorAll("thead th"));
      ths.forEach(function(th){ th.style.width = th.offsetWidth + "px"; });
      ths.slice(0, -1).forEach(function(th){
        var g = document.createElement("span");
        g.className = "grip";
        g.setAttribute("role", "separator");
        g.setAttribute("tabindex", "0");
        g.setAttribute("aria-label", "调整列宽,左右方向键微调");
        th.appendChild(g);
        function freeze(){ if (!tb.style.width) tb.style.width = tb.offsetWidth + "px"; }
        function setW(w){ th.style.width = Math.max(60, w) + "px"; }
        g.addEventListener("mousedown", function(e){
          e.preventDefault(); freeze();
          var sx = e.clientX, sw = th.offsetWidth;
          function mv(ev){ setW(sw + ev.clientX - sx); }
          function up(){ document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); }
          document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
        });
        g.addEventListener("keydown", function(e){
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault(); freeze();
          setW(th.offsetWidth + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 10));
        });
      });
    });
  }
  init(document);
})();
</script>
</body>
</html>`
  };
}

module.exports = { renderMinutes, applyMapToText, applySpeakerMapDeep, verifyActionEvidence, evidenceBadge };
