/**
 * R25 性能基线 —— 100 / 1,000 / 10,000 任务三档,可重复执行,输出 JSON 基线。
 *
 * 指标(报告 5.R25 要求):GET /api/tasks 延迟分位数(p50/p95/p99)、响应体大小、
 * event-loop lag(均值/p99)、RSS/heap、tasks.json 全量写耗时(写放大)。
 *
 * 运行:node scripts/perf_baseline.cjs   (隔离数据目录 + 随机端口,不触碰真实数据)
 * 输出:perf-baseline.json(仓库根,入库留档)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { monitorEventLoopDelay, performance } = require("perf_hooks");

const ROOT = path.join(__dirname, "..");
const SIZES = (process.argv[2] || "100,1000,10000").split(",").map(Number);
const REQ_PER_SIZE = 200;

process.env.MMB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mmb-perf-"));
process.env.PORT = String(19000 + Math.floor(Math.random() * 2000));
process.env.MMB_ADMIN_PASSWORD = "PerfPass-1";
const DATA = process.env.MMB_DATA_DIR;

/* 生成接近真实形态的任务记录(5 步、时长字段、说话人映射等) */
function makeTask(day, seq) {
  const t = (i) => new Date(Date.UTC(2026, 8, 1 + (seq % 20), 10, i)).toISOString();
  return {
    id: `MT-${day}-${String(seq).padStart(3, "0")}`,
    uuid: `${seq}".pad`.padEnd(36, "0").slice(0, 36),
    runId: `run${seq}`.padEnd(36, "1").slice(0, 36),
    title: `性能基线会议任务 ${seq}`,
    originalFileName: `meeting-${seq}.mp3`,
    fileName: `perf-${seq}.mp3`,
    sizeBytes: 5_000_000 + seq,
    stage: "done",
    steps: ["import", "extract", "transcribe", "analyze", "render"].map((k, i) => ({
      key: k, label: "x", status: "done", startedAt: t(i), finishedAt: t(i + 1), note: "",
    })),
    transcriptChars: 12_000 + seq % 8000,
    minutesFile: `MT-${day}-${String(seq).padStart(3, "0")}/minutes.html`,
    speakerMap: { "0": "张三", "1": "李四" },
    error: "",
    createdAt: t(0), updatedAt: t(5),
  };
}

const delayHist = monitorEventLoopDelay({ resolution: 10 });
delayHist.enable();

console.log(`启动服务 :${process.env.PORT}(数据目录 ${DATA})`);
require(path.join(ROOT, "server", "server.cjs"));
const pipeline = require(path.join(ROOT, "server", "pipeline.cjs"));
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

(async () => {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + "/api/version")).ok) break; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const r = await fetch(BASE + "/api/auth/login", { method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ username: "admin", password: "PerfPass-1" }) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  if (r.status !== 200) throw new Error("login failed");

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const results = [];
  for (const n of SIZES) {
    // 写入 N 条任务(覆盖式),删除遗留 outputs 目录引用的物理文件不受影响(只测 API/持久化路径)
    const tasks = Array.from({ length: n }, (_, i) => makeTask(day, i + 1));
    pipeline.saveTasks(tasks);
    const fileKB = +(fs.statSync(pipeline.TASKS_FILE).size / 1024).toFixed(1);

    // 预热 5 次(不计入采样)
    for (let i = 0; i < 5; i++) await fetch(BASE + "/api/tasks", { headers: { Cookie: cookie } });

    delayHist.reset();   // 采样窗口 = 本档压测期(histogram 全程保持 enable)
    const lat = [];
    let bodyBytes = 0;
    for (let i = 0; i < REQ_PER_SIZE; i++) {
      const t0 = performance.now();
      const resp = await fetch(BASE + "/api/tasks", { headers: { Cookie: cookie } });
      const buf = await resp.arrayBuffer();
      lat.push(+(performance.now() - t0).toFixed(2));
      bodyBytes += buf.byteLength;
    }
    const mem = process.memoryUsage();

    // 写放大:全量保存 20 次取均值
    let writeMs = 0;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      pipeline.saveTasks(tasks);
      writeMs += performance.now() - t0;
    }

    const row = {
      tasks: n,
      tasksFileKB: fileKB,
      api: {
        p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99),
        mean: +(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(2),
        bodyKB: +(bodyBytes / REQ_PER_SIZE / 1024).toFixed(1),
      },
      eventLoopLagMs: { mean: +(delayHist.mean / 1e6).toFixed(3), p99: +(delayHist.percentile(99) / 1e6).toFixed(3) },
      memoryMB: { rss: +(mem.rss / 1048576).toFixed(1), heapUsed: +(mem.heapUsed / 1048576).toFixed(1) },
      saveTasksWriteMs: +(writeMs / 20).toFixed(2),
    };
    results.push(row);
    console.log(`[${n} 任务] GET /api/tasks p50=${row.api.p50}ms p95=${row.api.p95}ms p99=${row.api.p99}ms 响应=${row.api.bodyKB}KB | lag均值=${row.eventLoopLagMs.mean}ms | 全量写=${row.saveTasksWriteMs}ms | tasks.json=${fileKB}KB`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.type()} ${os.arch()} (${os.cpus().length} cores)`,
    note: "GET /api/tasks 全量返回 + 每条文件存在性检查;JSON 整文件写。基线冻结后再评估分页/摘要/增量事件。",
    results,
  };
  fs.writeFileSync(path.join(ROOT, "perf-baseline.json"), JSON.stringify(out, null, 2));
  console.log("\n已写入 perf-baseline.json");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
