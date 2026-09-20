/**
 * 会议纪要流水线 worker
 * import(已由上传完成) → extract(抽音轨) → transcribe(讯飞) → analyze(LLM) → render(ALE 模板)
 * 任务持久化: data/tasks.json;产物: data/outputs/<taskId>/
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const { transcribe } = require("./iflytek.cjs");
const { analyze } = require("./llm.cjs");
const { renderMinutes } = require("./minutes-template.cjs");

const DATA = path.join(__dirname, "data");
const UPLOADS = path.join(DATA, "uploads");
const OUTPUTS = path.join(DATA, "outputs");
const TASKS_FILE = path.join(DATA, "tasks.json");
[DATA, UPLOADS, OUTPUTS].forEach((d) => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, "[]");

const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma", ".amr"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".wmv", ".flv"]);

const hasFfmpeg = (() => {
  try { execFileSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

function loadTasks() { return JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); }
function saveTasks(tasks) { fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2)); }

function newStep(key, label) { return { key, label, status: "pending", startedAt: null, finishedAt: null, note: "" }; }

function createTask(fileName, sizeBytes) {
  const tasks = loadTasks();
  const d = new Date();
  const day = d.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = tasks.filter((t) => t.id.startsWith(`MT-${day}`)).length + 1;
  const task = {
    id: `MT-${day}-${String(seq).padStart(3, "0")}`,
    title: fileName.replace(/\.[^.]+$/, ""),
    fileName,
    sizeBytes,
    stage: "queued",
    steps: [
      newStep("import", "导入文件"),
      newStep("extract", "抽取音轨"),
      newStep("transcribe", "语音转写"),
      newStep("analyze", "AI 分析"),
      newStep("render", "生成纪要"),
    ],
    transcriptChars: 0,
    minutesFile: "",
    error: "",
    createdAt: d.toISOString(),
    updatedAt: d.toISOString(),
  };
  tasks.unshift(task);
  saveTasks(tasks);
  return task;
}

function updateTask(taskId, patch) {
  const tasks = loadTasks();
  const i = tasks.findIndex((t) => t.id === taskId);
  if (i < 0) return;
  tasks[i] = { ...tasks[i], ...patch, updatedAt: new Date().toISOString() };
  saveTasks(tasks);
}

function setStep(taskId, key, status, note = "") {
  const tasks = loadTasks();
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return;
  const s = t.steps.find((x) => x.key === key);
  if (!s) return;
  s.status = status;
  s.note = note;
  if (status === "running") s.startedAt = new Date().toISOString();
  if (status === "done" || status === "skipped" || status === "failed") s.finishedAt = new Date().toISOString();
  saveTasks(tasks);
}

const STAGE_OF = { extract: "extracting", transcribe: "transcribing", analyze: "analyzing", render: "rendering" };

/** 异步执行流水线(不阻塞 HTTP) */
async function runPipeline(task, secret) {
  const log = (...a) => console.log(`[${task.id}]`, ...a);
  try {
    const srcPath = path.join(UPLOADS, task.fileName);
    const ext = path.extname(task.fileName).toLowerCase();
    const isVideo = VIDEO_EXT.has(ext);
    const isAudio = AUDIO_EXT.has(ext);
    if (!isVideo && !isAudio) throw new Error(`不支持的文件类型: ${ext}(支持音频 mp3/wav/m4a/aac 等,视频 mp4/mov/mkv 等)`);

    /* ── extract ── */
    updateTask(task.id, { stage: STAGE_OF.extract });
    setStep(task.id, "import", "done");
    setStep(task.id, "extract", "running");
    let audioPath = srcPath;
    if (isVideo && !hasFfmpeg) {
      setStep(task.id, "extract", "failed", "服务器未安装 ffmpeg,无法从视频抽音轨;请改传音频文件或安装 ffmpeg");
      throw new Error("缺少 ffmpeg,视频文件无法处理");
    }
    if (isVideo || (hasFfmpeg && ext !== ".mp3")) {
      // 有 ffmpeg:统一转 16k 单声道 mp3(讯飞友好,省上传带宽)
      const outMp3 = path.join(UPLOADS, `${task.id}.mp3`);
      await new Promise((resolve, reject) => {
        execFile("ffmpeg", ["-y", "-i", srcPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", outMp3],
          { windowsHide: true, timeout: 30 * 60 * 1000 }, (err) => (err ? reject(err) : resolve()));
      });
      audioPath = outMp3;
      setStep(task.id, "extract", "done", isVideo ? "已从视频抽取 16kHz 单声道音轨" : "已转 16kHz 单声道");
    } else {
      setStep(task.id, "extract", "skipped", "纯音频直传(未安装 ffmpeg,跳过转码)");
    }

    /* ── transcribe ── */
    updateTask(task.id, { stage: "transcribing" });
    setStep(task.id, "transcribe", "running");
    const { text, segments, hasSpeakers, mock: trMock } = await transcribe(audioPath, secret.iflytek || {}, log);
    if (!text || text.length < 10) throw new Error("转写结果为空或过短");
    setStep(task.id, "transcribe", "done", `${text.length} 字${trMock ? "(mock)" : ""}`);
    updateTask(task.id, { transcriptChars: text.length });

    /* 说话人发言时长统计(真实数据:来自讯飞时间戳分段) */
    let talkStats = [];
    if (segments && segments.length && hasSpeakers) {
      const acc = new Map();
      for (const s of segments) {
        const sp = s.speaker || "?";
        acc.set(sp, (acc.get(sp) || 0) + Math.max(0, (s.end || 0) - (s.start || 0)));
      }
      const total = [...acc.values()].reduce((a, b) => a + b, 0) || 1;
      talkStats = [...acc.entries()]
        .map(([speaker, ms]) => ({ speaker: `说话人${speaker}`, ms, pct: Math.round((ms / total) * 1000) / 10 }))
        .sort((a, b) => b.ms - a.ms);
    }

    /* ── analyze ── */
    updateTask(task.id, { stage: "analyzing" });
    setStep(task.id, "analyze", "running");
    const analysis = await analyze(text, secret.llm || {}, log);
    setStep(task.id, "analyze", "done", analysis.mock ? "mock(未配置 LLM)" : analysis.title || "");

    /* ── render ── */
    updateTask(task.id, { stage: "rendering" });
    setStep(task.id, "render", "running");
    const outDir = path.join(OUTPUTS, task.id);
    fs.mkdirSync(outDir, { recursive: true });
    const { html, fileName } = renderMinutes({
      analysis,
      meta: { date: task.createdAt.slice(0, 10), fileName: task.fileName, transcriptChars: text.length, talkStats },
    });
    fs.writeFileSync(path.join(outDir, fileName), html, "utf8");
    setStep(task.id, "render", "done", fileName);
    updateTask(task.id, { stage: "done", title: analysis.title || task.title, minutesFile: `${task.id}/${fileName}` });
    log("流水线完成 →", fileName);
  } catch (e) {
    console.error(`[${task.id}] 失败:`, e.message);
    // 失败发生在哪一步,就把哪一步标 failed(此刻它正处于 running)
    const tasks = loadTasks();
    const t = tasks.find((x) => x.id === task.id);
    if (t) {
      const cur = t.steps.find((s) => s.status === "running");
      if (cur) {
        cur.status = "failed";
        cur.note = e.message.slice(0, 200);
        cur.finishedAt = new Date().toISOString();
      }
      saveTasks(tasks);
    }
    updateTask(task.id, { stage: "failed", error: e.message });
  }
}

module.exports = { createTask, loadTasks, runPipeline, UPLOADS, OUTPUTS, TASKS_FILE, hasFfmpeg };
