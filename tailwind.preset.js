/**
 * ⚠️ 由 tokens/*.json 生成（npm run tokens:build）— 禁止手改色值
 * 颜色/圆角/阴影/时长全部映射 tokens.css 的 CSS 变量
 */
/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      colors: {
        canvas: "var(--color-canvas)",
        surface: "var(--color-surface)",
        "text-primary": "var(--color-text-primary)",
        "text-secondary": "var(--color-text-secondary)",
        "text-muted": "var(--color-text-muted)",
        border: "var(--color-border)",
        "border-soft": "var(--color-border-soft)",
        action: { DEFAULT: "var(--color-action)", hover: "var(--color-action-hover)" },
        tint: "var(--color-purple-tint)",
        heading: "var(--color-heading-accent)",
        link: "var(--color-link)",
        "on-action": "var(--color-on-action)",
        "on-tint": "var(--color-on-tint)",
        status: {
          "neutral-text": "var(--status-neutral-text)", "neutral-bg": "var(--status-neutral-bg)",
          "info-text": "var(--status-info-text)", "info-bg": "var(--status-info-bg)",
          "success-text": "var(--status-success-text)", "success-bg": "var(--status-success-bg)",
          "warning-text": "var(--status-warning-text)", "warning-bg": "var(--status-warning-bg)",
          "danger-text": "var(--status-danger-text)", "danger-bg": "var(--status-danger-bg)",
        },
      },
      borderRadius: { sm: "8px", DEFAULT: "8px", md: "12px", lg: "16px" },
      boxShadow: { sm: "var(--shadow-sm)", md: "var(--shadow-md)", hover: "var(--shadow-hover)" },
      transitionDuration: { fast: "var(--motion-fast)", panel: "var(--motion-panel)", enter: "var(--motion-enter)" },
      fontFamily: {
        sans: ["Trebuchet MS", "Noto Sans SC", "PingFang SC", "sans-serif"],
        mono: ["SFMono-Regular", "Consolas", "Liberation Mono", "Noto Sans SC", "monospace"],
      },
      maxWidth: { content: "var(--content-max)", reading: "var(--reading-max)" },
    },
  },
};
