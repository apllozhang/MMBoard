/** Switch / Radio / Checkbox（44px 热区，appearance 自绘）—— FORM 组件集 */
import { cn } from "@/lib/utils";

export function Switch({ checked, onChange, label, id }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; id?: string;
}) {
  return (
    <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2.5 text-sm">
      <button type="button" role="switch" id={id} aria-checked={checked}
              onClick={() => onChange(!checked)}
              className={cn("relative h-6 w-11 rounded-full border-0 transition-colors duration-fast",
                checked ? "" : "bg-[color:var(--color-border)]")}
              style={checked ? { background: "var(--color-action)" } : undefined}>
        <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-fast",
          checked ? "left-[22px]" : "left-0.5")} />
      </button>
      <span>{label}</span>
    </label>
  );
}

export function Radio({ name, value, checked, onChange, label }: {
  name: string; value: string; checked: boolean; onChange: (v: string) => void; label: string;
}) {
  return (
    <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-sm">
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} />
      <span>{label}</span>
    </label>
  );
}

export function Checkbox({ checked, onChange, label, id, ariaRequired, describedBy, invalid }: {
  checked: boolean; onChange: (v: boolean) => void; label: string;
  id?: string; ariaRequired?: boolean; describedBy?: string; invalid?: boolean;
}) {
  return (
    <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" id={id} checked={checked} onChange={(e) => onChange(e.target.checked)}
             aria-required={ariaRequired ? true : undefined}
             aria-describedby={describedBy}
             aria-invalid={invalid ? true : undefined} />
      <span>{label}</span>
    </label>
  );
}
