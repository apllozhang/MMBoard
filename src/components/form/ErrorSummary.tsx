/** 提交失败错误摘要（FORM-SUM-001）：role=alert + 锚点跳转字段 */
import { useEffect, useRef } from "react";

export function ErrorSummary({ errors, onGone }: { errors: Array<{ id: string; label: string; message: string }>; onGone?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (errors.length && ref.current) ref.current.focus();
  }, [errors.length]);
  if (!errors.length) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert"
         className="mb-4 rounded-[8px] border p-3"
         style={{ borderColor: "var(--status-danger-graphic)", background: "var(--status-danger-bg)" }}>
      <p className="m-0 mb-2 text-sm font-bold" style={{ color: "var(--status-danger-text)" }}>
        表单有 {errors.length} 处错误，请修正后重新提交：
      </p>
      <ul className="m-0 list-disc pl-5 text-[13px]">
        {errors.map((e) => (
          <li key={e.id}>
            <a href={`#${e.id}`} className="underline" style={{ color: "var(--status-danger-text)" }}
               onClick={() => { document.getElementById(e.id)?.focus(); onGone?.(); }}>
              {e.label}
            </a>
            ：{e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
