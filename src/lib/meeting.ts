/**
 * 会议纪要任务数据层 —— 与后端 API(server/server.cjs)同源交互
 * 流水线: import → extract → transcribe → analyze → render(前端只读状态)
 */
export type Stage =
  | "queued" | "extracting" | "transcribing" | "analyzing" | "rendering"
  | "done" | "failed";

export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface Step {
  key: "import" | "extract" | "transcribe" | "analyze" | "render";
  label: string;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  note: string;
}

export interface MeetingTask {
  id: string;                 // MT-YYYYMMDD-NNN
  title: string;
  fileName: string;
  sizeBytes: number;
  stage: Stage;
  steps: Step[];
  transcriptChars: number;
  minutesFile: string;        // "MT-xxx/名称-v0.1-日期.html"
  error: string;
  createdAt: string;
  updatedAt: string;
  hasTranscript?: boolean;    // 转写文本已落盘(可只重跑分析)
  hasSource?: boolean;        // 源文件还在(可整条重跑)
}

export interface ServerMeta {
  ffmpeg: boolean;
  iflytekConfigured: boolean;
  llmConfigured: boolean;
  asrProvider?: "iflytek" | "local";   // 当前转写通道
  localAsrOnline?: boolean;            // 本地转写服务在线(仅 local 通道时有意义)
}

/** 阶段 → Badge tone(状态四色成对) */
export const STAGE_TONE: Record<Stage, "neutral" | "info" | "success" | "warning" | "danger"> = {
  queued: "neutral",
  extracting: "info",
  transcribing: "info",
  analyzing: "info",
  rendering: "info",
  done: "success",
  failed: "danger",
};

export const STEP_TONE: Record<StepStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  running: "info",
  done: "success",
  skipped: "warning",
  failed: "danger",
};

/** 401 = 会话过期:整页重载回登录门 */
function handle401(res: Response) {
  if (res.status === 401) {
    window.location.reload();
    throw new Error("unauthenticated");
  }
}

/** 非 GET 的 /api 请求必须带此头(服务端 CSRF 防护) */
const CSRF = { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  handle401(res);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: CSRF, body: JSON.stringify(body) });
  handle401(res);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchMeta = () => getJson<ServerMeta>("/api/meta");
export const fetchTasks = () => getJson<MeetingTask[]>("/api/tasks");
export const fetchTask = (id: string) => getJson<MeetingTask>(`/api/tasks/${encodeURIComponent(id)}`);

export async function uploadMeeting(file: File): Promise<MeetingTask> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/tasks", { method: "POST", body, headers: { "X-Requested-With": "XMLHttpRequest" } });
  handle401(res);
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  return res.json() as Promise<MeetingTask>;
}

export async function restartTask(id: string, scope: "analyze" | "all" = "all"): Promise<MeetingTask> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/restart`, {
    method: "POST",
    headers: CSRF,
    body: JSON.stringify({ scope }),
  });
  handle401(res);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<MeetingTask>;
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  handle401(res);
  if (!res.ok) throw new Error(`删除失败 HTTP ${res.status}`);
}

/** 整条重跑额度预览(本地估算:讯飞免费额度按每日 2 小时为基准) */
export interface RerunPreview {
  provider: "iflytek" | "local";   // 当前生效转写通道
  audioSeconds: number;
  estSeconds: number | null;       // 本地通道:预计转写耗时(秒)
  usedSeconds: number;
  dailySeconds: number;
  freeSeconds: number;
  enough: boolean;
  mock: boolean;
}

export async function fetchRerunPreview(id: string): Promise<RerunPreview> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/rerun-preview`);
  handle401(res);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<RerunPreview>;
}

/** 转写通道轻量切换(看板快捷开关;只动 asr,不碰模型列表) */
export async function patchAsrProvider(provider: "iflytek" | "local") {
  const res = await fetch("/api/settings/asr", {
    method: "PUT",
    headers: CSRF,
    body: JSON.stringify({ provider }),
  });
  handle401(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ ok: boolean; asr: { provider: string; localUrl: string } }>;
}

/* ── 流水线进度估算 ──
 * 步骤权重(转写/分析占大头);运行中步骤按已耗时/预计耗时推进,封顶 90% 等真实完成 */
const STEP_WEIGHT: Record<Step["key"], number> = { import: 3, extract: 7, transcribe: 60, analyze: 25, render: 5 };
const STEP_EST_SEC: Record<Step["key"], number> = { import: 5, extract: 30, transcribe: 240, analyze: 180, render: 10 };

export function taskProgress(t: MeetingTask): { pct: number; running: boolean } {
  if (t.stage === "done") return { pct: 100, running: false };
  let pct = t.stage === "queued" ? 1 : 0;
  const now = Date.now();
  for (const s of t.steps) {
    if (s.status === "done" || s.status === "skipped") pct += STEP_WEIGHT[s.key];
    else if (s.status === "running" && s.startedAt) {
      const frac = Math.min(0.9, (now - new Date(s.startedAt).getTime()) / (STEP_EST_SEC[s.key] * 1000));
      pct += STEP_WEIGHT[s.key] * frac;
    }
  }
  return { pct: Math.min(99, Math.round(pct)), running: t.stage !== "failed" };
}

/** 说话人标注:读取编号列表与已存映射 */
export async function fetchSpeakers(id: string): Promise<{ speakers: string[]; map: Record<string, string>; hasAnalysis: boolean }> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/speakers`);
  handle401(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ speakers: string[]; map: Record<string, string>; hasAnalysis: boolean }>;
}

/** 保存说话人映射;有可复用分析时服务端纯重渲染纪要 */
export async function saveSpeakers(id: string, map: Record<string, string>): Promise<{ ok: boolean; rerendered: boolean; message?: string }> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/speakers`, {
    method: "PUT",
    headers: CSRF,
    body: JSON.stringify({ map }),
  });
  handle401(res);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<{ ok: boolean; rerendered: boolean; message?: string }>;
}

/** 纪要下载(Attachment,浏览器直接落盘;无需打开新页) */
export const minutesDownloadUrl = (id: string) => `/api/tasks/${encodeURIComponent(id)}/minutes/download`;
/** 纪要在线查看(R04:受认证保护,不再走静态 /outputs) */
export const minutesOpenUrl = (id: string) => `/api/tasks/${encodeURIComponent(id)}/minutes`;
