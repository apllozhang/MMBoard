/**
 * 设置数据层 —— AI 模型管理(模仿 ZCode:多条目 + 激活其一 + 连通性测试)
 * 与后端 /api/settings 交互;apiKey 由后端打码返回,提交含 **** 的打码值表示"不修改"
 */
export interface ModelEntry {
  id: string;
  name: string;
  provider: "anthropic" | "openai";
  baseUrl: string;
  model: string;
  apiKey: string;      // 读:打码值;写:明文或打码(不修改)
}

export interface AsrConfig {
  /** 转写通道:iflytek 云端(耗额度) | local 本地 FunASR(免费,需工作机在线) */
  provider: "iflytek" | "local";
  localUrl: string;
}

/** 讯飞云转写参数(appId 明文;key/secret 打码回显,提交打码值=不修改) */
export interface IflytekConfig {
  appId: string;
  apiKey: string;
  apiSecret: string;
  /** 当前参数来自密钥文件回退(settings 内尚未保存过) */
  fromFallback?: boolean;
}

export interface SettingsPayload {
  /** R22:并发编辑保护版本号——保存时原样回传,服务端不匹配返回 409 */
  version: number;
  activeId: string | null;
  models: ModelEntry[];
  asr: AsrConfig;
  iflytek: IflytekConfig;
  /** models 为空时,实际生效的是密钥文件里的配置(兼容既有部署) */
  fallback: { provider: string; baseUrl: string; model: string; apiKey: string } | null;
}

/** 设置保存/测试的业务错误(服务端 4xx/409 的 message 用于界面提示) */
export class SettingsError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

export interface TestResult {
  ok: boolean;
  ms?: number;
  message?: string;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 401) {
    window.location.reload();
    throw new Error("unauthenticated");
  }
  if (!res.ok) {
    // R21:把服务端业务错误(400 参数问题 / 409 并发冲突)的明确信息带给界面,而非笼统 HTTP 码
    let message = `${url} → HTTP ${res.status}`;
    try { message = (await res.json())?.error || message; } catch { /* 非 JSON 响应保持默认 */ }
    throw new SettingsError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export const fetchSettings = () => jsonFetch<SettingsPayload>("/api/settings");

export const saveSettings = (p: { version?: number; activeId: string | null; models: ModelEntry[]; asr?: AsrConfig; iflytek?: IflytekConfig }) =>
  jsonFetch<{ ok: boolean; version: number; activeId: string; count: number }>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(p),
  });

/** 测试已保存条目(用存储里的明文密钥) */
export const testSavedModel = (id: string) =>
  jsonFetch<TestResult>("/api/settings/test", { method: "POST", body: JSON.stringify({ id }) });

/** 测试表单里的临时配置(要求已填明文 key) */
export const testDraftModel = (entry: Pick<ModelEntry, "provider" | "baseUrl" | "model" | "apiKey">) =>
  jsonFetch<TestResult>("/api/settings/test", { method: "POST", body: JSON.stringify({ entry }) });

/** 测试本地转写服务连通性 */
export const testAsrService = (localUrl: string) =>
  jsonFetch<TestResult & { message?: string }>("/api/settings/test-asr", {
    method: "POST",
    body: JSON.stringify({ localUrl }),
  });

/** 快捷预设(与 ZCode 类工具一致的"选厂商→填 Key"体验) */
export const MODEL_PRESETS: Array<Partial<ModelEntry> & { label: string }> = [
  { label: "GLM", name: "GLM-5.3-Flash", provider: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic", model: "GLM-5.3-Flash" },
  { label: "DeepSeek", name: "DeepSeek", provider: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
];

export const newModelId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
