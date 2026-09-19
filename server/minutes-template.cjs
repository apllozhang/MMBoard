/**
 * ALE 会议纪要模板生成器 —— docs/prompts/提示词样例.md「模板一(文档类)」的服务端实现
 * 硬约束:真实 Logo(亮暗 base64 内嵌,禁止仿制) · 全套令牌 CSS 变量 · 3px 主紫顶条 ·
 *         版本徽章与文件名一致 · 官方商标行 · 双主题+reduced-motion+焦点可见 · 320 无溢出
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "..", "public", "assets");
const logoB64 = (f) => `data:image/png;base64,${fs.readFileSync(path.join(ASSETS, f)).toString("base64")}`;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 生成纪要 HTML。返回 { html, fileName } */
function renderMinutes({ analysis, meta }) {
  const a = analysis;
  const date = meta.date;                          // YYYY-MM-DD
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

  const actionRows = (a.actions || []).map((x) => `
          <tr>
            <td>${esc(x.owner || "—")}</td>
            <td>${esc(x.item)}</td>
            <td>${esc(x.due || "—")}</td>
          </tr>`).join("\n");

  const risks = (a.risks || []).length
    ? `
      <section id="risks" class="sec">
        <h2 class="section-head">风险与待确认</h2>
        <ul class="list">
${(a.risks || []).map((r) => `          <li>${esc(r)}</li>`).join("\n")}
        </ul>
      </section>`
    : "";

  const mockTag = a.mock ? '<span class="badge-warn">模拟数据</span>' : "";

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

.hero{background:linear-gradient(135deg,var(--purple-deep),var(--purple) 55%,var(--purple-500));
  color:#fff;padding:48px 16px}
.hero .wrap{max-width:960px;margin:0 auto}
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
</style>
</head>
<body>
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
  <a href="#suggestions">建议</a>` : ""}
</nav>

<div class="hero">
  <div class="wrap">
    <h1>${esc(a.title || "会议纪要")}</h1>
    <p>${esc(a.summary || "")}</p>
    <div class="meta">
      <span>会议日期:${esc(meta.date)}</span>
      <span>来源:${esc(meta.fileName)}</span>
      <span>转写:${esc(String(meta.transcriptChars))} 字</span>
    </div>
  </div>
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
</body>
</html>`
  };
}

module.exports = { renderMinutes };
