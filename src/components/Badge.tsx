/** 状态徽章（规范 15 章：圆点 + 文字，tone 语义 API） */
import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "text-[color:var(--status-neutral-text)] bg-[color:var(--status-neutral-bg)]",
  info: "text-[color:var(--status-info-text)] bg-[color:var(--status-info-bg)]",
  success: "text-[color:var(--status-success-text)] bg-[color:var(--status-success-bg)]",
  warning: "text-[color:var(--status-warning-text)] bg-[color:var(--status-warning-bg)]",
  danger: "text-[color:var(--status-danger-text)] bg-[color:var(--status-danger-bg)]",
};

export function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return <span className={cn("badge", TONE_CLASS[tone])}>{children}</span>;
}
