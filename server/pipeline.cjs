/**
 * 会议纪要流水线 worker
 * import(已由上传完成) → extract(抽音轨) → transcribe(讯飞) → analyze(LLM) → render(ALE 模板)
 * 任务持久化: data/tasks.json;产物: data/outputs/<taskId>/
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { writeJsonAtomic, readJsonWithRecovery } = require("./persist.cjs");
const { transcribe } = require("./iflytek.cjs");
const localAsr = require("./local.cjs");
const { analyze } = require("./llm.cjs");
const { renderMinutes } = require("./minutes-template.cjs");

// 数据目录:默认随程序目录;隔离测试用 MMB_DATA_DIR 覆盖(生产不受影响)
const DATA = process.env.MMB_DATA_DIR || path.join(__dirname, "data");
const UPLOADS = path.join(DATA, "uploads");
const OUTPUTS = path.join(DATA, "outputs");
const TASKS_FILE = path.join(DATA, "tasks.json");
const QUOTA_FILE = path.join(DATA, "quota.json");   // 当日转写时长记账 {"YYYY-MM-DD": 秒}
[DATA, UPLOADS, OUTPUTS].forEach((d) => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, "[]");

const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma", ".amr"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".wmv", ".flv"]);

const hasFfmpeg = (() => {
  try { execFileSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

function loadTasks() { return readJsonWithRecovery(TASKS_FILE); }
function saveTasks(tasks) { writeJsonAtomic(TASKS_FILE, tasks); }

function newStep(key, label) { return { key, label, status: "pending", startedAt: null, finishedAt: null, note: "" }; }

function updateTask(taskId, runId, patch) {
  const tasks = loadTasks();
  const i = tasks.findIndex((t) => t.id === taskId);
  if (i < 0) return;
  if (tasks[i].runId !== runId) throw new RunSupersededError();
  tasks[i] = { ...tasks[i], ...patch, updatedAt: new Date().toISOString() };
  saveTasks(tasks);
}

/** 本地自然日(YYYY-MM-DD)。R22 复审:额度口径跟随用户时区,不再用 UTC 日期
 *  (中国时区 UTC+8,UTC 切日比本地晚 8 小时,跨日附近余量提示会算错一天)。 */
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 当日转写用量记账:真实转写成功后按音频时长累加(秒)。mock 不记。 */
function recordQuota(seconds) {
  const day = localDay();
  let q;
  try { q = readJsonWithRecovery(QUOTA_FILE); } catch { q = {}; }   // 损坏回退 .bak,皆坏按首日
  q[day] = Math.round(((q[day] || 0) + seconds) * 10) / 10;
  writeJsonAtomic(QUOTA_FILE, q);
  return q[day];
}

function readQuota(day) {
  try { return JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"))[day] || 0; }
  catch { return 0; }
}

/** ffprobe 探测音频时长(秒) */
async function probeAudioSeconds(file) {
  const { stdout } = await execFileAsync("ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { windowsHide: true, timeout: 30000 });
  const s = parseFloat(String(stdout).trim());
  if (!isFinite(s) || s <= 0) throw new Error("ffprobe 未返回有效时长");
  return Math.round(s * 10) / 10;
}

function setStep(taskId, runId, key, status, note = "") {
  const tasks = loadTasks();
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return;
  if (t.runId !== runId) throw new RunSupersededError();
  const s = t.steps.find((x) => x.key === key);
  if (!s) return;
  s.status = status;
  s.note = note;
  if (status === "running") s.startedAt = new Date().toISOString();
  if (status === "done" || status === "skipped" || status === "failed") s.finishedAt = new Date().toISOString();
  saveTasks(tasks);
}

/** R08 全局串行任务队列:一次只跑一个任务(转写/分析是重资源操作);容量 10,超出拒绝 */
const taskQueue = [];
let queueDraining = false;
const QUEUE_CAPACITY = 10;

/** 入队;队列满抛错(调用方转 503) */
function enqueuePipeline(task, secret, opts = {}) {
  if (taskQueue.length >= QUEUE_CAPACITY) {
    throw new Error("任务队列已满(10 个),请等当前任务完成后再试");
  }
  taskQueue.push({ task, secret, opts });
  drainQueue();
}

const queueDepth = () => taskQueue.length;

function drainQueue() {
  if (queueDraining) return;
  const item = taskQueue.shift();
  if (!item) return;
  queueDraining = true;
  Promise.resolve(runPipeline(item.task, item.secret, item.opts))
    .catch((e) => console.error(`[${item.task.id}] 队列执行异常:`, e.message))
    .finally(() => { queueDraining = false; drainQueue(); });
}

/** R08 服务重启恢复:启动时把"运行中"任务标记为中断(队列未持久化,这些任务已失去执行者) */
function recoverInterruptedTasks() {
  const RUNNING = new Set(["queued", "extracting", "transcribing", "analyzing", "rendering"]);
  const tasks = loadTasks();
  let n = 0;
  for (const t of tasks) {
    if (!RUNNING.has(t.stage)) continue;
    t.stage = "failed";
    t.error = "服务重启,任务中断——请使用「重新跑」继续(已有转写文本的任务只会重跑分析)";
    for (const s of t.steps) {
      if (s.status === "running" || s.status === "pending") {
        s.status = "failed";
        s.note = "服务重启中断";
        s.finishedAt = new Date().toISOString();
      }
    }
    n += 1;
  }
  if (n) {
    saveTasks(tasks);
    console.log(`[pipeline] 启动恢复:标记 ${n} 个中断任务为 failed`);
  }
}

const STAGE_OF = { extract: "extracting", transcribe: "transcribing", analyze: "analyzing", render: "rendering" };

/** 正在流水线上运行的阶段(互斥判断用) */
const RUNNING_STAGES = new Set(["queued", "extracting", "transcribing", "analyzing", "rendering"]);

/** 旧运行实例被新实例取代时抛出;pipeline 捕获后静默退出,不得改写新实例状态 */
class RunSupersededError extends Error {
  constructor() { super("运行实例已被新实例取代,停止写入"); this.name = "RunSupersededError"; }
}

function checkRunAlive(taskId, runId) {
  const t = loadTasks().find((x) => x.id === taskId);
  if (!t || t.runId !== runId) throw new RunSupersededError();
}

/** createTask:storageKey 为 uploads 内唯一存储键;originalName 仅作展示与标题。
 *  R02 复审整改:uuid 为不可复用的产物目录键(task.dirKey),MT-展示编号单调递增不回收——
 *  删除产生的空号不再被复用,残留目录与并发创建都不会导致编号/目录共享。 */
function createTask(storageKey, originalName, sizeBytes) {
  const tasks = loadTasks();
  const d = new Date();
  const day = d.toISOString().slice(0, 10).replace(/-/g, "");
  let maxSeq = 0;   // 当日已用最大序号(现存任务 + 残留输出目录)
  for (const t of tasks) {
    const m = /^MT-\d{8}-(\d+)$/.exec(t.id || "");
    if (m && t.id.startsWith(`MT-${day}`)) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  }
  try {
    for (const dir of fs.readdirSync(OUTPUTS)) {
      const m = /^MT-\d{8}-(\d+)$/.exec(dir);
      if (m && dir.startsWith(`MT-${day}`)) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
  } catch { /* outputs 不存在时忽略 */ }
  const seq = maxSeq + 1;
  const uuid = randomUUID();
  const task = {
    id: `MT-${day}-${String(seq).padStart(3, "0")}`,   // 展示编号(单调分配,不复用)
    uuid,                                              // 内部主键
    dirKey: uuid,                                      // 产物目录键(不可复用;旧任务无此字段时回退 id)
    runId: randomUUID(),                               // 当前运行实例(重跑/互斥判定)
    title: originalName.replace(/\.[^.]+$/, ""),
    originalFileName: originalName,                    // 用户看到的原始文件名
    fileName: storageKey,                              // uploads 存储键(与原始名解耦,同名上传互不影响)
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

/** 产物目录:新任务用不可复用的 dirKey(uuid);存量旧任务回退展示编号 id(向后兼容) */
function taskDir(task) {
  return path.join(OUTPUTS, task.dirKey || task.id);
}

/** 异步执行流水线(不阻塞 HTTP)。opts.transcript 存在时复用已存转写文本,跳过 extract/transcribe(不耗讯飞额度)。
 *  每次 runId 对应一次执行;任何状态写入前都校验 runId,被新实例取代即静默退出,绝不覆盖新实例状态 */
async function runPipeline(task, secret, opts = {}) {
  const log = (...a) => console.log(`[${task.id}]`, ...a);
  try {
    let text, segments = null, hasSpeakers = false;

    if (opts.transcript) {
      /* ── 复用已有转写(import/extract/transcribe 不重跑) ── */
      text = String(opts.transcript.text || "");
      segments = Array.isArray(opts.transcript.segments) ? opts.transcript.segments : null;
      hasSpeakers = !!opts.transcript.hasSpeakers;
      if (text.length < 10) throw new Error("已存转写文本为空或过短,请整条重跑");
      setStep(task.id, task.runId, "import", "done", "复用已上传文件");
      setStep(task.id, task.runId, "extract", "skipped", "复用已有转写文本");
      setStep(task.id, task.runId, "transcribe", "skipped", `复用已有转写(${text.length} 字,未调用讯飞)`);
    } else {
      await runFromExtract(task, secret, log);
      return;
    }

    await analyzeAndRender(task, secret, log, { text, segments, hasSpeakers, transcriptionMode: task.transcriptionMode || "unknown" });
  } catch (e) {
    if (e instanceof RunSupersededError) { log("运行实例已被取代,本次执行退出"); return; }
    failTask(task, e);
  }
}

/** extract + transcribe 段(整条跑时执行) */
async function runFromExtract(task, secret, log) {
  try {
    const srcPath = path.join(UPLOADS, task.fileName);
    const ext = path.extname(task.fileName).toLowerCase();
    const isVideo = VIDEO_EXT.has(ext);
    const isAudio = AUDIO_EXT.has(ext);
    if (!isVideo && !isAudio) throw new Error(`不支持的文件类型: ${ext}(支持音频 mp3/wav/m4a/aac 等,视频 mp4/mov/mkv 等)`);

    /* ── extract ── */
    updateTask(task.id, task.runId, { stage: STAGE_OF.extract });
    setStep(task.id, task.runId, "import", "done");
    setStep(task.id, task.runId, "extract", "running");
    let audioPath = srcPath;
    if (isVideo && !hasFfmpeg) {
      setStep(task.id, task.runId, "extract", "failed", "服务器未安装 ffmpeg,无法从视频抽音轨;请改传音频文件或安装 ffmpeg");
      throw new Error("缺少 ffmpeg,视频文件无法处理");
    }
    if (isVideo || (hasFfmpeg && ext !== ".mp3")) {
      // 有 ffmpeg:统一转 16k 单声道 mp3(讯飞友好,省上传带宽)
      const outMp3 = path.join(UPLOADS, `${task.uuid}.mp3`);
      await new Promise((resolve, reject) => {
        execFile("ffmpeg", ["-y", "-i", srcPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", outMp3],
          { windowsHide: true, timeout: 30 * 60 * 1000 }, (err) => (err ? reject(err) : resolve()));
      });
      audioPath = outMp3;
      setStep(task.id, task.runId, "extract", "done", isVideo ? "已从视频抽取 16kHz 单声道音轨" : "已转 16kHz 单声道");
    } else {
      setStep(task.id, task.runId, "extract", "skipped", "纯音频直传(未安装 ffmpeg,跳过转码)");
    }

    /* ── transcribe(通道:本地 FunASR / 讯飞云) ── */
    updateTask(task.id, task.runId, { stage: "transcribing" });
    setStep(task.id, task.runId, "transcribe", "running");
    const useLocal = (secret.asr?.provider === "local");
    const { text, segments, hasSpeakers, mock: trMock } = useLocal
      ? await localAsr.transcribe(audioPath, secret.asr || {}, log)
      : await transcribe(audioPath, secret.iflytek || {}, log);
    checkRunAlive(task.id, task.runId);   // 长转写返回后:实例已被取代则不再写状态/落盘/调用 LLM
    if (!text || text.length < 10) throw new Error("转写结果为空或过短");
    // R06:转写模式入档(mock 数据不得伪装真实纪要)
    const transcriptionMode = useLocal ? "local" : (trMock ? "mock" : "iflytek");
    setStep(task.id, task.runId, "transcribe", "done", `${text.length} 字${useLocal ? "(本地)" : trMock ? "(mock)" : ""}`);
    updateTask(task.id, task.runId, { transcriptChars: text.length, transcriptionMode });

    /* 真实转写记账:仅讯飞通道(本地转写不耗额度)。失败不影响任务 */
    if (!trMock && !useLocal) {
      try {
        const secs = await probeAudioSeconds(audioPath);
        updateTask(task.id, task.runId, { audioSeconds: secs });
        recordQuota(secs);
      } catch (e) { log("额度记账失败(不影响任务):", e.message); }
    }

    /* 转写落盘:后续"重跑分析"可复用,不必重新转写(省讯飞额度) */
    try {
      const outDir = taskDir(task);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "transcript.json"),
        JSON.stringify({ text, segments: segments || [], hasSpeakers: !!hasSpeakers }, null, 2));
    } catch (e) { log("转写文本落盘失败(不影响本次任务):", e.message); }

    await analyzeAndRender(task, secret, log, { text, segments, hasSpeakers, transcriptionMode: useLocal ? "local" : (trMock ? "mock" : "iflytek") });
  } catch (e) {
    if (e instanceof RunSupersededError) { log("运行实例已被取代,本次执行退出"); return; }
    failTask(task, e);
  }
}

/** analyze + render 段(两种入口共用) */
async function analyzeAndRender(task, secret, log, { text, segments, hasSpeakers, transcriptionMode = "iflytek" }) {
  try {

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
    checkRunAlive(task.id, task.runId);   // 进入分析前再校验一次
    updateTask(task.id, task.runId, { stage: "analyzing" });
    setStep(task.id, task.runId, "analyze", "running");
    const analysis = await analyze(text, secret.llm || {}, log);
    checkRunAlive(task.id, task.runId);   // 长分析返回后:被取代则不写产物、不覆盖新实例状态
    setStep(task.id, task.runId, "analyze", "done", analysis.mock ? "mock(未配置 LLM)" : analysis.title || "");

    /* ── render ── */
    updateTask(task.id, task.runId, { stage: "rendering" });
    setStep(task.id, task.runId, "render", "running");
    const outDir = taskDir(task);
    fs.mkdirSync(outDir, { recursive: true });
    const { html, fileName } = renderMinutes({
      analysis,
      meta: { date: task.createdAt.slice(0, 10), fileName: task.originalFileName || task.fileName,
              transcriptChars: text.length, talkStats,
              transcriptionMode, analysisMode: analysis.mock ? "mock" : "real",
              uploadedAt: task.createdAt, generatedAt: new Date().toISOString(),
              meetingOccurredAt: null },
    });
    fs.writeFileSync(path.join(outDir, fileName), html, "utf8");
    // 说话人标注纯重渲染的依据:分析结果 + 发言统计 + 渲染元信息落盘
    fs.writeFileSync(path.join(outDir, "analysis.json"), JSON.stringify({
      analysis,
      talkStats,
      meta: { date: task.createdAt.slice(0, 10), fileName: task.originalFileName || task.fileName,
              transcriptChars: text.length, transcriptionMode, analysisMode: analysis.mock ? "mock" : "real",
              uploadedAt: task.createdAt },
    }, null, 2));
    setStep(task.id, task.runId, "render", "done", fileName);
    updateTask(task.id, task.runId, { stage: "done", title: analysis.title || task.title, minutesFile: `${task.dirKey || task.id}/${fileName}` });
    log("流水线完成 →", fileName);
  } catch (e) {
    if (e instanceof RunSupersededError) { log("运行实例已被取代,本次执行退出"); return; }
    failTask(task, e);
  }
}

/** 失败收尾:失败发生在哪一步,就把哪一步标 failed(此刻它正处于 running);旧实例失败不覆盖新实例 */
function failTask(task, e) {
  if (e instanceof RunSupersededError) return;
  console.error(`[${task.id}] 失败:`, e.message);
  const tasks = loadTasks();
  const t = tasks.find((x) => x.id === task.id);
  if (!t || t.runId !== task.runId) return;
  const cur = t.steps.find((s) => s.status === "running");
  if (cur) {
    cur.status = "failed";
    cur.note = e.message.slice(0, 200);
    cur.finishedAt = new Date().toISOString();
  }
  t.stage = "failed";
  t.error = e.message;
  t.updatedAt = new Date().toISOString();
  saveTasks(tasks);
}

module.exports = { createTask, loadTasks, saveTasks, runPipeline, enqueuePipeline, recoverInterruptedTasks, queueDepth, QUEUE_CAPACITY, taskDir, localDay, DATA, UPLOADS, OUTPUTS, TASKS_FILE, hasFfmpeg, probeAudioSeconds, readQuota, AUDIO_EXT, VIDEO_EXT };
