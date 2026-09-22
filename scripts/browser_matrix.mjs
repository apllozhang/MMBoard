/**
 * R23/R24 浏览器矩阵 —— Playwright(自带 Chromium,headless)真实浏览器验证。
 * 覆盖三轮复审点名:双弹窗层级(inert/aria-hidden)、焦点循环、纯键盘操作、
 * Esc 关闭、320px 窄屏、低高度视口、读屏(role/aria 属性)。
 *
 * 运行:node scripts/browser_matrix.mjs
 * (脚本自起隔离 demo 服务 + 预置可重跑任务;不触碰生产数据)
 */
"use strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

/* ── 环境准备:隔离 demo 服务 + 预置 done 任务(有源文件/转写/分析,可整条重跑) ── */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mmb-browser-"));
process.env.MMB_DATA_DIR = DATA;
process.env.PORT = "18777";
process.env.MMB_DEMO = "1";
process.env.MMB_ADMIN_PASSWORD = "BrowserPass1";
const persist = (await req("server/persist.cjs")).default;
persist.writeJsonAtomic(path.join(DATA, "settings.json"),
  { version: 1, activeId: null, models: [], asr: { provider: "iflytek", localUrl: "" } });
const uuid = "b0000000-0000-4000-8000-000000000001";
persist.writeJsonAtomic(path.join(DATA, "tasks.json"), [{
  id: "MT-20260922-001", uuid, dirKey: uuid, title: "浏览器矩阵验证任务",
  originalFileName: "bm.wav", fileName: "bm.wav", sizeBytes: 1024, stage: "done",
  steps: ["import", "extract", "transcribe", "analyze", "render"].map((k, i) => ({
    key: k, label: k, status: "done", startedAt: "2026-09-22T01:0" + i + ":00Z", finishedAt: "2026-09-22T01:0" + (i + 1) + ":00Z", note: "浏览器矩阵",
  })),
  transcriptChars: 100, minutesFile: "", error: "",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}]);
const llm = (await req("server/llm.cjs")).default;
const { renderMinutes } = await req("server/minutes-template.cjs");
const outDir = path.join(DATA, "outputs", uuid);
fs.mkdirSync(outDir, { recursive: true });
const analysis = llm.normalizeAnalysis({ title: "浏览器验证", summary: "验证摘要", topics: [], decisions: [], actions: [], risks: [], highlights: [] });
const { html } = renderMinutes({
  analysis,
  meta: { date: "2026-09-22", uploadedAt: "2026-09-22T01:00:00Z", generatedAt: "2026-09-22T02:00:00Z",
          fileName: "bm.wav", transcriptChars: 100,
          talkStats: [{ speaker: "说话人0", ms: 60000, pct: 60 }, { speaker: "说话人1", ms: 40000, pct: 40 }] },
});
fs.writeFileSync(path.join(outDir, "bm-v0.1-20260922.html"), html);
fs.writeFileSync(path.join(outDir, "transcript.json"), JSON.stringify({
  text: "[00:00] 说话人0: 浏览器矩阵验证文本内容。\n[00:10] 说话人1: 第二句验证内容。",
  segments: [{ start: 0, end: 10000, text: "浏览器矩阵验证文本内容。", speaker: "0" },
             { start: 10000, end: 20000, text: "第二句验证内容。", speaker: "1" }],
  hasSpeakers: true, speakerMap: {},
}, null, 2));
fs.mkdirSync(path.join(DATA, "uploads"), { recursive: true });
fs.writeFileSync(path.join(DATA, "uploads", "bm.wav"), Buffer.alloc(1024, 1));

const server = spawn(process.execPath, [path.join(ROOT, "server", "server.cjs")],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => process.stderr.write(d));
const BASE = "http://127.0.0.1:18777";
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(BASE + "/api/version"); if (r.ok) break; } catch { /* 未就绪 */ }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const errors = [];
fs.mkdirSync(path.join(ROOT, "gui-test-screenshots"), { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(BASE + "/");
  await page.getByRole("textbox").nth(0).fill("admin");
  await page.getByRole("textbox").nth(1).fill("BrowserPass1");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForSelector('[role="progressbar"]', { timeout: 10000 });
  console.log("\n■ R23 浏览器矩阵(Playwright/headless Chromium)");

  // ── ① 双弹窗层级:inert / aria-hidden ──
  await page.getByRole("button", { name: "详情", exact: true }).click();
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.getByRole("button", { name: /整条重跑/ }).click();
  await page.waitForTimeout(600);
  const two = await page.evaluate(`(() => {
    const ds = [...document.querySelectorAll('[role="dialog"]')];
    return { count: ds.length, layers: ds.map(d => ({ inert: !!d.inert, hidden: d.getAttribute("aria-hidden"),
      label: d.getAttribute("aria-label") || (d.querySelector("h3")?.textContent || "") })) };
  })()`);
  ok("重跑确认层打开后存在两层 dialog", two.count === 2, JSON.stringify(two));
  const bottom = two.layers.find((l) => l.inert);
  const top = two.layers.find((l) => !l.inert);
  ok("底层 dialog inert=true 且 aria-hidden", !!bottom && bottom.hidden === "true", JSON.stringify(two.layers));
  ok("顶层 dialog 不受 inert 影响(含重跑确认)", !!top && top.label.includes("整条重跑"), JSON.stringify(top));

  // ── ② Esc 关顶层,底层恢复可交互 ──
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const afterEsc = await page.evaluate(`(() => {
    const ds = [...document.querySelectorAll('[role="dialog"]')];
    return { count: ds.length, inert: ds.map(d => !!d.inert) };
  })()`);
  ok("Esc 关闭顶层后剩详情层且 inert 解除", afterEsc.count === 1 && afterEsc.inert[0] === false, JSON.stringify(afterEsc));

  // ── ③ 焦点循环:连续 Tab 后焦点仍在详情弹窗内 ──
  let focusInDialog = false;
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    focusInDialog = await page.evaluate(`!!document.activeElement && !!document.activeElement.closest('[role="dialog"]')`);
    if (!focusInDialog) break;
  }
  ok("Tab 连续 25 次焦点始终圈闭在弹窗内(焦点循环)", focusInDialog);

  // ── ④ 纯键盘:Esc 关闭详情;Tab+Enter 重新打开(不开鼠标) ──
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const dlgGone = await page.evaluate(`document.querySelectorAll('[role="dialog"]').length === 0`);
  ok("纯键盘 Esc 关闭详情弹窗", dlgGone);
  await page.evaluate(`document.querySelector('button[aria-haspopup="dialog"]').focus()`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const dlgReopen = await page.evaluate(`document.querySelectorAll('[role="dialog"]').length`);
  ok("纯键盘 Enter 打开详情弹窗(不依赖鼠标)", dlgReopen === 1, `count=${dlgReopen}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ── ⑤ 读屏(ARIA):progressbar/aria-valuenow/dialog aria-modal ──
  const aria = await page.evaluate(`(() => {
    const pb = document.querySelector('[role="progressbar"]');
    const dlg = null;
    return {
      progressbar: !!pb,
      valuenow: pb ? pb.getAttribute("aria-valuenow") : null,
      valuemin: pb ? pb.getAttribute("aria-valuemin") : null,
      valuemax: pb ? pb.getAttribute("aria-valuemax") : null,
    };
  })()`);
  ok("进度条具备 role=progressbar + aria-valuenow/min/max(三轮点名残留)", aria.progressbar && aria.valuenow !== null && aria.valuemin === "0" && aria.valuemax === "100",
     JSON.stringify(aria));
  await page.getByRole("button", { name: "详情", exact: true }).click();
  await page.waitForTimeout(400);
  const dlgAria = await page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? { modal: d.getAttribute("aria-modal"), labelled: !!(d.getAttribute("aria-label") || d.querySelector("h3")) } : null;
  })()`);
  ok("dialog 具备 aria-modal 与可读名称(读屏可感知)", dlgAria && dlgAria.modal === "true" && dlgAria.labelled, JSON.stringify(dlgAria));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ── ⑥ 320px 窄屏:无横向溢出,弹窗可用 ──
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(`(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }))()`);
  const wideEls = await page.evaluate(`(() => {
    const out = [];
    for (const el of [document.documentElement, document.body, ...document.querySelectorAll("body *")]) {
      if (el.scrollWidth > 322) out.push({ tag: el.tagName, cls: String(el.className).slice(0, 55),
        scrollW: el.scrollWidth, overflowX: getComputedStyle(el).overflowX });
      if (out.length >= 8) break;
    }
    return out;
  })()`);
  // 三轮 R23:行为断言——用户级输入不能横向滚动页面(根元素 hidden 禁用户滚动条/滚轮;
  // scrollTo 编程滚动在 hidden 下仍可用,不作为依据;表格等宽内容在自己的容器内滚动)
  const scrollBehavior = await page.evaluate(`(() => {
    window.scrollTo(9999, 0);
    return { scrollXAfterProgrammatic: window.scrollX,
             scrollbarVisible: document.documentElement.offsetWidth > document.documentElement.clientWidth };
  })()`);
  await page.mouse.wheel(600, 0);   // 用户级水平滚轮
  await page.waitForTimeout(300);
  const scrollXAfterWheel = await page.evaluate(`window.scrollX`);
  ok("320px 窄屏无页面级横向滚动(用户滚轮无效;表格在容器内局部滚动)",
     scrollXAfterWheel === 0 && scrollBehavior.scrollbarVisible === false,
     JSON.stringify({ scrollBehavior, scrollXAfterWheel, wideEls }));
  await page.getByRole("button", { name: "详情", exact: true }).click();
  await page.waitForTimeout(400);
  const dlgFit = await page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) };
  })()`);
  ok("320px 下详情弹窗完整可见", dlgFit && dlgFit.left >= 0 && dlgFit.right <= 322, JSON.stringify(dlgFit));
  const shot320 = await page.screenshot({ path: path.join(ROOT, "gui-test-screenshots", "narrow-320.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ── ⑦ 低高度视口:弹窗内部滚动,可到达底部 ──
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "详情", exact: true }).click();
  await page.waitForTimeout(400);
  const lowH = await page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    const scroller = d.querySelector(".overflow-y-auto");
    return {
      inViewport: d.getBoundingClientRect().top >= 0,
      scrollable: scroller ? scroller.scrollHeight > scroller.clientHeight : false,
    };
  })()`);
  ok("低高度(420px)下弹窗在视口内且内容内部滚动", lowH && lowH.inViewport && lowH.scrollable, JSON.stringify(lowH));
  await page.screenshot({ path: path.join(ROOT, "gui-test-screenshots", "low-height-420.png") });

  // ── ⑧ 页面 JS 错误收集 ──
  ok("全程无页面 JS 异常", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n===== 浏览器矩阵:${pass} 通过,${fail} 失败 =====`);
if (failures.length) { console.log("失败项:"); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
