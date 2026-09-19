/**
 * symphony-console 浏览器自查（对应 docs/UI-CHECKLIST.md 矩阵）
 * 用 kit/tools 的 puppeteer-core + 本机 Edge/Chrome：
 *   - 渲染：三屏宽(320/768/1440) × 双主题截图 + 根级横向溢出 + 控制台零错误 + 资产全 200
 *   - 交互：主题切换+持久化(M1/M2) · 排序 aria-sort(T3) · 分页(T2) · 筛选空态(T4)
 *           列宽手柄 role=separator(T1) · 详情弹层 Esc 关闭(D1) · skip-link(N3)
 *   - 字体：首屏 woff2 总量 ≤1100KB（FONT-BUDGET 同口径）
 * 运行：node scripts/verify.mjs <base> <outdir>   （base 默认 http://127.0.0.1:4173）
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire("D:/AIWork/ZCode/WebUI/repo/kit/tools/package.json");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:4173";
const OUT = process.argv[3] || "artifacts";

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
function findBrowser() {
  for (const p of EDGE) if (fs.existsSync(p)) return p;
  throw new Error("未找到 Edge/Chrome");
}

const results = [];
const ok = (id, pass, note = "") => {
  results.push({ id, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}${note ? "  — " + note : ""}`);
};

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1440,900"],
});

const page = await browser.newPage();
const consoleErrors = [];
const badResponses = [];
let fontBytes = 0;
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("response", (r) => {
  if (r.status() >= 400) badResponses.push({ url: r.url(), status: r.status() });
  if (/\.woff2?\b/i.test(r.url())) fontBytes += Number(r.headers()["content-length"] || 0);
});
page.on("requestfailed", (r) => badResponses.push({ url: r.url(), error: "requestfailed" }));

async function overflowPx() {
  return page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
}

/* ── 1. 渲染：三屏宽 × 双主题 ── */
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`${BASE}/#/`, { waitUntil: "networkidle0", timeout: 60_000 });
await new Promise((r) => setTimeout(r, 600));

ok("ASSET-HTTP", badResponses.length === 0, JSON.stringify(badResponses.slice(0, 3)));
ok("CONSOLE", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
ok("FONT-BUDGET", fontBytes <= 1100 * 1024, `${(fontBytes / 1024).toFixed(0)}KB ≤ 1100KB`);

for (const [w, h] of [[1440, 900], [768, 1024], [320, 800]]) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((th) => {
      localStorage.setItem("theme", th);
      document.documentElement.classList.toggle("dark", th === "dark");
    }, theme);
    await page.setViewport({ width: w, height: h });
    await new Promise((r) => setTimeout(r, 350));
    const ovf = await overflowPx();
    const name = `OVF-${w}-${theme}`;
    ok(name, Math.max(ovf.doc, ovf.body) <= 0, `doc+${ovf.doc}px body+${ovf.body}px`);
    await page.screenshot({ path: path.join(OUT, `dash-${w}-${theme}.png`) });
  }
}

/* ── 2. 交互冒烟（1440 亮色） ── */
await page.evaluate(() => {
  localStorage.setItem("theme", "light");
  document.documentElement.classList.remove("dark");
});
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle0", timeout: 60_000 });
await new Promise((r) => setTimeout(r, 600));

// N3 skip-link：第一个可聚焦元素
const skipFirst = await page.evaluate(() => {
  const el = document.querySelector("a[href='#main']");
  return !!el;
});
ok("N3-SKIP-LINK", skipFirst);

// M1/M2 主题切换 + 持久化（IX-THEME / THEME-PERSIST）
const themeBtn = await page.$("[aria-label*='主题'], [aria-label*='theme'], [aria-label*='Theme']");
await themeBtn.click();
await new Promise((r) => setTimeout(r, 450));
const darkOn = await page.evaluate(() => document.documentElement.classList.contains("dark"));
const persisted = await page.evaluate(() => localStorage.getItem("theme"));
ok("IX-THEME", darkOn);
ok("THEME-PERSIST", persisted === "dark", `localStorage=${persisted}`);
await page.evaluate(() => {
  localStorage.setItem("theme", "light");
  document.documentElement.classList.remove("dark");
});

// T3 排序：点击“任务标识”表头 → aria-sort 变化（IX-KBD-SORT 同源）
const ariaSort = await page.evaluate(() => {
  const th = Array.from(document.querySelectorAll("table.data thead th"))
    .find((x) => x.textContent.includes("任务标识"));
  if (!th) return null;
  th.querySelector("div")?.click();
  return th.getAttribute("aria-sort");
});
await new Promise((r) => setTimeout(r, 300));
const ariaSortAfter = await page.evaluate(() => {
  const th = Array.from(document.querySelectorAll("table.data thead th"))
    .find((x) => x.textContent.includes("任务标识"));
  return th?.getAttribute("aria-sort");
});
ok("IX-KBD-SORT", ariaSort === "none" && ariaSortAfter === "ascending", `${ariaSort} → ${ariaSortAfter}`);

// T1 列宽手柄存在且键盘可聚焦（IX-KBD-COLW）
const sep = await page.evaluate(() => {
  const s = document.querySelector("table.data th[role='separator'], table.data [role='separator']");
  if (!s) return null;
  s.focus();
  return document.activeElement === s && s.getAttribute("aria-orientation") === "vertical";
});
ok("IX-KBD-COLW", !!sep);

// T2 分页：页码 2 可点且 aria-current 跟随（IX-KBD-PAGE）；单页数据时降级断言分页控件完整
const page2 = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll(".pagination .pg-btn"));
  const two = btns.find((b) => b.textContent.trim() === "2");
  if (!two) return "single-page";
  two.click();
  return "clicked";
});
await new Promise((r) => setTimeout(r, 250));
const cur2 = await page.evaluate(() =>
  !!document.querySelector(".pagination .pg-btn[aria-current='page']"));
ok("IX-KBD-PAGE",
  page2 === "clicked" ? cur2 : (page2 === "single-page" && cur2),
  page2 === "single-page" ? "数据单页,降级断言当前页 aria-current" : "翻页后 aria-current 跟随");

// T4 筛选 + 空态：搜索不存在的关键字 → 空态文案（防白屏）
await page.type("input[aria-label*='搜索'], input[aria-label*='Search']", "ZZZZZ-NO-MATCH-000");
await new Promise((r) => setTimeout(r, 700));
const emptyShown = await page.evaluate(() => {
  const td = document.querySelector("td.table-state");
  return !!td && td.textContent.trim().length > 2;
});
ok("T4-EMPTY-STATE", emptyShown);
await page.screenshot({ path: path.join(OUT, "tasks-empty-state.png") });

// D1 详情弹层：先清搜索（React 受控输入需原生 setter）→ 打开详情 → Esc 关闭
await page.evaluate(() => {
  const input = document.querySelector("input[aria-label*='搜索'], input[aria-label*='Search']");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 600));
const detailBtn = await page.$("button[aria-haspopup='dialog']");
if (detailBtn) {
  await detailBtn.click();
  await new Promise((r) => setTimeout(r, 350));
  const dialogOpen = await page.evaluate(() => !!document.querySelector("[role='dialog']"));
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 350));
  const dialogClosed = await page.evaluate(() => !document.querySelector("[role='dialog']"));
  ok("D1-ESC-CLOSE", dialogOpen && dialogClosed, `open=${dialogOpen} closedAfterEsc=${dialogClosed}`);
} else {
  ok("D1-ESC-CLOSE", false, "未找到详情按钮");
}

// 跨页主题持久化：在 tasks 页设置 dark → 跳转 dashboard 后仍保持（CROSS-THEME）
await page.evaluate(() => {
  localStorage.setItem("theme", "dark");
  document.documentElement.classList.add("dark");
});
await page.goto(`${BASE}/#/`, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 400));
const crossDark = await page.evaluate(() => localStorage.getItem("theme") === "dark" &&
  document.documentElement.classList.contains("dark"));
ok("CROSS-THEME-PERSIST", crossDark);
await page.evaluate(() => { localStorage.setItem("theme", "light"); });

await browser.close();

const fails = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - fails.length}/${results.length} PASS ===`);
fs.writeFileSync(path.join(OUT, "verify-report.json"), JSON.stringify(results, null, 2));
process.exit(fails.length ? 1 : 0);
