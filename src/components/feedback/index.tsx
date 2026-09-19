/** 反馈组件集（CMP-FB）：Alert / Skeleton / EmptyState / Drawer / Progress */
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type AlertTone = "info" | "success" | "warning" | "danger";

const ALERT_BG: Record<AlertTone, string> = {
  info: "var(--status-info-bg)", success: "var(--status-success-bg)",
  warning: "var(--status-warning-bg)", danger: "var(--status-danger-bg)",
};
const ALERT_FG: Record<AlertTone, string> = {
  info: "var(--status-info-text)", success: "var(--status-success-text)",
  warning: "var(--status-warning-text)", danger: "var(--status-danger-text)",
};

/** 页面级常驻提示（区别于 Toast：不打断、不自动消失） */
export function Alert({ tone = "info", title, children }: { tone?: AlertTone; title?: string; children: React.ReactNode }) {
  return (
    <div role={tone === "danger" || tone === "warning" ? "alert" : "status"}
         className="mb-4 flex gap-2.5 rounded-[8px] border p-3 text-sm"
         style={{ background: ALERT_BG[tone], borderColor: ALERT_FG[tone], color: ALERT_FG[tone] }}>
      {title && <strong className="font-bold">{title}：</strong>}
      <div>{children}</div>
    </div>
  );
}

/** 内容占位（FB-SKELETON-001：aria-hidden） */
export function Skeleton({ w = "100%", h = 16, className }: { w?: number | string; h?: number; className?: string }) {
  return <span aria-hidden="true" className={cn("block animate-pulse rounded", className)}
               style={{ width: w, height: h, background: "var(--color-border-soft)" }} />;
}

/** 空状态：什么/为什么/下一步 */
export function EmptyState({ title, description, action }: {
  title: string; description?: string; action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="grid place-items-center gap-2 py-12 text-center">
      <p className="m-0 text-base font-bold text-text-primary">{title}</p>
      {description && <p className="m-0 text-sm text-text-muted">{description}</p>}
      {action && <button type="button" className="btn btn-primary mt-2" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}

/** 进度条（确定时长） */
export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}
           aria-label={label} className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-border-soft)]">
        <div className="h-full rounded-full transition-all duration-panel" style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: "var(--color-action)" }} />
      </div>
      <p className="mt-1 text-xs text-text-muted">{label} {Math.round(value)}%</p>
    </div>
  );
}

/** 右侧抽屉（FB-FOCUS-001：焦点圈闭 + Esc + 归还） */
export function Drawer({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const first = overlay.querySelector<HTMLElement>("button,[href],input,select,textarea");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const list = Array.from(overlay.querySelectorAll<HTMLElement>("button,[href],input,select,textarea")).filter((x) => !x.hasAttribute("disabled"));
      if (!list.length) return;
      if (e.shiftKey && document.activeElement === list[0]) { list[list.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === list[list.length - 1]) { list[0].focus(); e.preventDefault(); }
    };
    overlay.addEventListener("keydown", onKey);
    return () => { overlay.removeEventListener("keydown", onKey); trigger?.focus(); };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div ref={overlayRef} className="fixed inset-0 z-[500]" style={{ background: "rgb(20 14 32 / 50%)" }}
         role="dialog" aria-modal="true" aria-label={title}
         onMouseDown={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <aside className="absolute right-0 top-0 h-full w-[min(420px,100%)] overflow-y-auto bg-surface p-5"
             style={{ boxShadow: "var(--shadow-md)" }}>
        <header className="mb-3 flex items-center justify-between">
          <h3 className="m-0 text-base">{title}</h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        {children}
      </aside>
    </div>
  );
}
