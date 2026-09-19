// ⚠️ 由 tokens/*.json 生成 — 禁止手改
export interface DesignToken { value: string; type: string; description?: string; }
export const semanticLight: Record<string, DesignToken>;
export const semanticDark: Record<string, DesignToken>;
export const primitives: Record<string, DesignToken>;
