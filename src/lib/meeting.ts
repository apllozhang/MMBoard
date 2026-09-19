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
}

export interface ServerMeta {
  ffmpeg: boolean;
  iflytekConfigured: boolean;
  llmConfigured: boolean;
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

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchMeta = () => getJson<ServerMeta>("/api/meta");
export const fetchTasks = () => getJson<MeetingTask[]>("/api/tasks");
export const fetchTask = (id: string) => getJson<MeetingTask>(`/api/tasks/${encodeURIComponent(id)}`);

export async function uploadMeeting(file: File): Promise<MeetingTask> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/tasks", { method: "POST", body });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  return res.json() as Promise<MeetingTask>;
}

export async function restartTask(id: string): Promise<MeetingTask> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/restart`, { method: "POST" });
  if (!res.ok) throw new Error(`重跑失败 HTTP ${res.status}`);
  return res.json() as Promise<MeetingTask>;
}
