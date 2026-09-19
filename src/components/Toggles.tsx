import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** 亮/暗主题切换（规范 14A.7：localStorage + .dark + ≤300ms 过渡） */
export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "light");

  const apply = (next: string, animate: boolean) => {
    const root = document.documentElement;
    if (animate) {
      root.classList.add("theme-transitioning");
      setTimeout(() => root.classList.remove("theme-transitioning"), 300);
    }
    root.classList.toggle("dark", next === "dark");
    localStorage.setItem("theme", next);
    setTheme(next);
  };

  return (
    <button type="button" className="icon-btn" aria-label={t("app.theme")}
            onClick={() => apply(theme === "dark" ? "light" : "dark", true)}>
      {theme === "dark" ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      )}
    </button>
  );
}

/** 语言切换（规范 14A.8：i18next + <html lang> 同步 + localStorage） */
export function LangToggle() {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const langs = [
    { code: "zh", label: "简体中文" },
    { code: "en", label: "English" },
  ];

  return (
    <div className="relative">
      <button type="button" className="icon-btn" aria-label={t("app.lang")} aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.9 5.6 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.6-3.9-9S9.5 5.6 12 3Z"/></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-[300] min-w-[150px] rounded-[8px] border border-border bg-surface p-1"
             style={{ boxShadow: "var(--shadow-md)" }} role="menu">
          {langs.map((l) => (
            <button key={l.code} type="button" role="menuitemradio"
                    aria-checked={i18n.language === l.code}
                    className={cn(
                      "flex w-full items-center justify-between rounded-[6px] px-3 py-2 text-[13px] hover:bg-tint",
                      i18n.language === l.code && "font-bold text-heading",
                    )}
                    onClick={() => { i18n.changeLanguage(l.code); setOpen(false); }}>
              <span>{l.label}</span>
              {i18n.language === l.code && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
