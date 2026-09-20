/** 模态框（规范 17 章：role=dialog / 焦点圈闭 / Esc / 焦点归还） */
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** 宽版(设置类弹层) */
  wide?: boolean;
}

export function Dialog({ open, onClose, title, children, footer, wide }: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const first = overlay.querySelector<HTMLElement>("button,[href],input,select,textarea");
    first?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const list = Array.from(overlay.querySelectorAll<HTMLElement>("button,[href],input,select,textarea"))
        .filter((el) => !el.hasAttribute("disabled"));
      if (!list.length) return;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { lastEl.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { firstEl.focus(); e.preventDefault(); }
    };
    overlay.addEventListener("keydown", onKeyDown);
    return () => {
      overlay.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div ref={overlayRef} className="fixed inset-0 z-[500] grid place-items-center p-4"
         style={{ background: "rgb(20 14 32 / 50%)" }}
         role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}
         onMouseDown={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div className={cn("w-full rounded-[12px] border border-border bg-surface", wide ? "max-w-[720px]" : "max-w-[460px]")} style={{ boxShadow: "var(--shadow-md)" }}>
        <header className="flex items-center justify-between p-4 pb-0">
          <h3 className="m-0 text-base">{title}</h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="p-4 text-sm text-text-secondary">{children}</div>
        <footer className="flex justify-end gap-3 px-4 pb-4">{footer}</footer>
      </div>
    </div>
  );
}
