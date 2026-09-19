/** 表单字段容器：Label + 控件 + Help + Error（CMP-FORM，规范 form.md）
 *  ARIA 自动注入（R14）：经 cloneElement 把 aria-invalid / aria-describedby /
 *  aria-required / required 注入 child 控件——调用端无需手动传，杜绝 fieldAria
 *  定义了没人用的脱节（第二轮评估 R2-N3）。 */
import { cloneElement, isValidElement } from "react";
import { cn } from "@/lib/utils";

type InjectProps = {
  id?: string;
  "aria-invalid"?: boolean | "true" | undefined;
  "aria-describedby"?: string | undefined;
  "aria-required"?: boolean | "true" | undefined;
  required?: boolean | undefined;
};

export function Field({
  label, htmlFor, required, help, error, children, className,
}: {
  label: string; htmlFor?: string; required?: boolean;
  help?: string; error?: string; children: React.ReactNode; className?: string;
}) {
  const errId = error ? `${htmlFor}-error` : undefined;
  const helpId = help ? `${htmlFor}-help` : undefined;
  const describedby = [helpId, errId].filter(Boolean).join(" ") || undefined;

  const control = isValidElement<InjectProps>(children)
    ? cloneElement<InjectProps>(children, {
        id: children.props.id ?? htmlFor,
        "aria-invalid": error ? true : children.props["aria-invalid"],
        "aria-describedby": describedby ?? children.props["aria-describedby"],
        "aria-required": required ? true : children.props["aria-required"],
        required: required || children.props.required,
      })
    : children;

  return (
    <div className={cn("mb-4", className)}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-bold">
        {label} {required && <span className="text-[color:var(--status-danger-text)]" aria-hidden="true">*</span>}
      </label>
      {control}
      {help && <p id={helpId} className="mt-1.5 text-[13px] text-text-muted">{help}</p>}
      {error && <p id={errId} role="alert" className="mt-1.5 text-[13px] text-[color:var(--status-danger-text)]">{error}</p>}
    </div>
  );
}
