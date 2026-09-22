/**
 * 模态框(规范 17 章:role=dialog / 焦点圈闭 / Esc / 焦点归还)
 * R23:焦点初始化只在 open 变化时执行(onClose 走 ref,轮询重渲染不重置焦点);
 *      内容区最大视口高度+内部滚动;打开时锁定背景滚动
 */
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
  /** R23:多层弹窗时把本层降级(inert + aria-hidden),辅助技术只感知顶层弹窗 */
  suspended?: boolean;
}

export function Dialog({ open, onClose, title, children, footer, wide, suspended }: DialogProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const suspendedRef = useRef(!!suspended);
  useEffect(() => { onCloseRef.current = onClose; });   // 始终拿到最新回调,但不触发焦点重置
  useEffect(() => { suspendedRef.current = !!suspended; }, [suspended]);

  useEffect(() => {
    if (!open) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!suspendedRef.current) {
      triggerRef.current = document.activeElement as HTMLElement;   // 仅顶层记录/归还触发焦点
      overlay.querySelector<HTMLElement>("button,[href],input,select,textarea")?.focus();
      document.body.style.overflow = "hidden";
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (suspendedRef.current) return;   // R23:被顶层弹窗覆盖时不响应 Esc/Tab(顶层统一处理)
      if (e.key === "Escape") { onCloseRef.current(); return; }
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
      if (!suspendedRef.current) {
        document.body.style.overflow = "";
        triggerRef.current?.focus();
      }
    };
  }, [open]);

  if (!open) return null;
  return (
    <div ref={(el) => {
      overlayRef.current = el;
      // R23:suspended(被顶层弹窗覆盖)时对本层设置 inert/aria-hidden——
      // 键盘与读屏用户不会进入本层,Tab 焦点圈闭只作用于顶层。
      if (el) {
        (el as HTMLElement & { inert?: boolean }).inert = !!suspended;
        if (suspended) el.setAttribute("aria-hidden", "true");
        else el.removeAttribute("aria-hidden");
      }
    }} className="fixed inset-0 z-[500] grid place-items-center p-4"
         style={{ background: "rgb(20 14 32 / 50%)" }}
         role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}
         onMouseDown={(e) => { if (e.target === overlayRef.current) onCloseRef.current(); }}>
      <div className={cn("flex w-full flex-col rounded-[12px] border border-border bg-surface",
                         "max-h-[88vh]", wide ? "max-w-[720px]" : "max-w-[460px]")}
           style={{ boxShadow: "var(--shadow-md)" }}>
        <header className="flex shrink-0 items-center justify-between p-4 pb-0">
          <h3 className="m-0 text-base">{title}</h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCloseRef.current()} aria-label="关闭">✕</button>
        </header>
        <div className="overflow-y-auto p-4 text-sm text-text-secondary">{children}</div>
        {footer && <footer className="flex shrink-0 justify-end gap-3 px-4 pb-4">{footer}</footer>}
      </div>
    </div>
  );
}
