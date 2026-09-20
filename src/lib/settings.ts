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

export interface SettingsPayload {
  activeId: string | null;
  models: ModelEntry[];
  asr: AsrConfig;
  /** models 为空时,实际生效的是密钥文件里的配置(兼容既有部署) */
  fallback: { provider: string; baseUrl: string; model: string; apiKey: string } | null;
}

export interface TestResult {
  ok: boolean;
  ms?: number;
  message?: string;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchSettings = () => jsonFetch<SettingsPayload>("/api/settings");

export const saveSettings = (p: { activeId: string | null; models: ModelEntry[]; asr?: AsrConfig }) =>
  jsonFetch<{ ok: boolean; activeId: string; count: number }>("/api/settings", {
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
