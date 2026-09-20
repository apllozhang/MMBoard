/**
 * 登录门(R03):未认证时整页替换为登录卡片;
 * LogoutButton 供已登录视图的顶栏使用
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, j };
}

export function AuthGate({ onLogin }: { onLogin: () => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError("");
    try {
      const { ok, j } = await postJson("/api/auth/login", { username, password });
      if (ok) {
        onLogin();
        return;
      }
      setError(j.error || t("auth.error"));
    } catch {
      setError(t("auth.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center p-4"
         style={{ background: "var(--color-canvas)" }}>
      <form onSubmit={submit}
            className="w-full max-w-[380px] rounded-[12px] border border-border bg-surface p-5"
            style={{ boxShadow: "var(--shadow-md)" }} aria-label={t("auth.loginTitle")}>
        <h1 className="m-0 text-[17px] text-heading">{t("auth.loginTitle")}</h1>
        <p className="m-0 mt-1 text-[12.5px] text-text-muted">{t("auth.loginDesc")}</p>
        <label className="mt-4 block text-[12px] text-text-muted">
          {t("auth.username")}
          <input className="mt-1 w-full rounded-[8px] border border-border bg-surface px-2.5 py-1.5 text-[13px]"
                 value={username} autoComplete="username" required
                 onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="mt-3 block text-[12px] text-text-muted">
          {t("auth.password")}
          <input className="mt-1 w-full rounded-[8px] border border-border bg-surface px-2.5 py-1.5 text-[13px]"
                 type="password" value={password} autoComplete="current-password" required
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p className="m-0 mt-3 rounded-[8px] border px-3 py-2 text-[12.5px]" role="alert"
             style={{ background: "var(--status-danger-bg)", color: "var(--status-danger-text)" }}>
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary mt-4 w-full" disabled={busy}>
          {busy ? t("auth.submitting") : t("auth.submit")}
        </button>
      </form>
    </div>
  );
}

export function LogoutButton() {
  const { t } = useTranslation();
  return (
    <button type="button" className="icon-btn" title={t("app.logout")} aria-label={t("app.logout")}
            onClick={async () => {
              await postJson("/api/auth/logout", {}).catch(() => undefined);
              window.location.reload();
            }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" x2="9" y1="12" y2="12" />
      </svg>
    </button>
  );
}
