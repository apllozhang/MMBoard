/**
 * 设置 · AI 模型管理（模仿 ZCode 的模型管理方式：多条目 / 激活其一 / 连通性测试）
 * 齿轮按钮位于页头工具区（语言、主题切换旁）；apiKey 打码显示，未修改则保留原值
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/Dialog";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  fetchSettings, saveSettings, testSavedModel, testDraftModel,
  MODEL_PRESETS, newModelId,
  type ModelEntry, type SettingsPayload,
} from "@/lib/settings";

const EMPTY_DRAFT = { id: "", name: "", provider: "openai" as const, baseUrl: "", model: "", apiKey: "" };

const PROVIDERS: Array<{ value: ModelEntry["provider"]; label: string }> = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
];

function providerLabel(p: ModelEntry["provider"]) {
  return p === "anthropic" ? "Anthropic" : "OpenAI 兼容";
}

export function SettingsButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="icon-btn" aria-label={t("settings.open")} title={t("settings.open")}
              aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      {open && <ModelSettingsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ModelSettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<ModelEntry | null>(null);
  const [busy, setBusy] = useState(false);          // 保存/测试进行中
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pendingDel, setPendingDel] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchSettings().then(setPayload).catch(() => toast("error", t("settings.loadError")));
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const persist = async (next: { activeId: string | null; models: ModelEntry[] }, okMsg?: string) => {
    setBusy(true);
    try {
      const r = await saveSettings(next);
      setPayload((p) => (p ? { ...p, activeId: r.activeId, models: next.models } : p));
      if (okMsg) toast("success", okMsg);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startAdd = (preset?: Partial<ModelEntry>) => {
    setDraft({ ...EMPTY_DRAFT, id: newModelId(), ...(preset || {}) });
  };
  const startEdit = (m: ModelEntry) => setDraft({ ...m });

  const saveDraft = () => {
    if (!draft || !payload) return;
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim() || !draft.apiKey.trim()) {
      toast("error", t("settings.required"));
      return;
    }
    const exists = payload.models.some((m) => m.id === draft.id);
    const models = exists ? payload.models.map((m) => (m.id === draft.id ? draft : m)) : [...payload.models, draft];
    const activeId = payload.activeId || draft.id;   // 首个模型自动激活
    persist({ activeId, models }, t("settings.saved")).then(() => setDraft(null));
  };

  const testRow = async (m: ModelEntry) => {
    setTestingId(m.id);
    try {
      const r = await testSavedModel(m.id);
      toast(r.ok ? "success" : "error", r.ok ? `${t("settings.testOk")} · ${r.ms}ms` : `${t("settings.testFail")} · ${r.message || ""}`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setTestingId(null);
    }
  };
  const testDraftForm = async () => {
    if (!draft) return;
    setTestingId(draft.id);
    try {
      const known = payload?.models.some((m) => m.id === draft.id);
      const masked = draft.apiKey.includes("****");
      if (masked) {
        if (!known) { toast("error", t("settings.needKey")); return; }
        const r = await testSavedModel(draft.id);       // 未改密钥 → 测已存条目
        toast(r.ok ? "success" : "error", r.ok ? `${t("settings.testOk")} · ${r.ms}ms` : `${t("settings.testFail")} · ${r.message || ""}`);
      } else {
        const r = await testDraftModel({ provider: draft.provider, baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey });
        toast(r.ok ? "success" : "error", r.ok ? `${t("settings.testOk")} · ${r.ms}ms` : `${t("settings.testFail")} · ${r.message || ""}`);
      }
    } finally {
      setTestingId(null);
    }
  };

  const removeRow = async (id: string) => {
    if (!payload) return;
    const models = payload.models.filter((m) => m.id !== id);
    const activeId = payload.activeId === id ? (models[0]?.id || null) : payload.activeId;
    setPendingDel(null);
    await persist({ activeId, models }, t("settings.deleted"));
  };

  const inputCls = "w-full rounded-[8px] border border-border bg-surface px-2.5 py-1.5 text-[13px]";

  return (
    <Dialog open onClose={onClose} wide title={t("settings.title")}
            footer={<button type="button" className="btn btn-secondary" onClick={onClose}>{t("settings.close")}</button>}>
      <p className="m-0 mb-3 text-[13px] text-text-muted">{t("settings.desc")}</p>

      {payload?.fallback && (
        <div className="mb-3 rounded-[8px] border px-3 py-2 text-[12.5px]"
             style={{ background: "var(--status-info-bg)", color: "var(--status-info-text)" }}>
          {t("settings.fallbackNote", { model: payload.fallback.model })}
        </div>
      )}

      {/* 模型列表 */}
      {payload && payload.models.length > 0 ? (
        <ul className="m-0 mb-3 list-none p-0">
          {payload.models.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 border-b py-2.5"
                style={{ borderColor: "var(--color-border-soft)" }}>
              <label className="flex items-center gap-1.5 text-[12px] text-text-muted">
                <input type="radio" name="activeModel" checked={payload.activeId === m.id}
                       disabled={busy} onChange={() => persist({ activeId: m.id, models: payload.models }, t("settings.saved"))}
                       aria-label={t("settings.use")} />
                {payload.activeId === m.id ? t("settings.current") : ""}
              </label>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <b className="text-[13.5px]">{m.name}</b>
                  <span className="rounded-full border px-2 py-0.5 text-[11px] text-text-muted"
                        style={{ borderColor: "var(--color-border)" }}>{providerLabel(m.provider)}</span>
                </div>
                <div className="truncate text-[12px] text-text-muted">{m.model} · {m.baseUrl}</div>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy || testingId === m.id}
                      onClick={() => testRow(m)}>
                {testingId === m.id ? t("settings.testing") : t("settings.test")}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => startEdit(m)}>
                {t("settings.edit")}
              </button>
              {pendingDel === m.id ? (
                <button type="button" className="btn btn-sm" disabled={busy}
                        style={{ background: "var(--status-danger-text)", color: "#fff" }}
                        onClick={() => removeRow(m.id)}>
                  {t("settings.confirm")}
                </button>
              ) : (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                        style={{ color: "var(--status-danger-text)" }} onClick={() => setPendingDel(m.id)}
                        onBlur={() => setPendingDel((v) => (v === m.id ? null : v))}>
                  {t("settings.del")}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 mb-3 rounded-[8px] border border-dashed px-3 py-4 text-center text-[13px] text-text-muted"
           style={{ borderColor: "var(--color-border)" }}>{t("settings.empty")}</p>
      )}

      {/* 编辑表单 */}
      {draft && (
        <div className="mb-3 rounded-[10px] border p-3" style={{ borderColor: "var(--color-border)", background: "var(--color-purple-tint)" }}>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="text-[12px] text-text-muted">{t("settings.name")}
              <input className={cn(inputCls, "mt-0.5")} value={draft.name}
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="text-[12px] text-text-muted">{t("settings.provider")}
              <select className={cn(inputCls, "mt-0.5")} value={draft.provider}
                      onChange={(e) => setDraft({ ...draft, provider: e.target.value as ModelEntry["provider"] })}>
                {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
            <label className="text-[12px] text-text-muted sm:col-span-2">{t("settings.baseUrl")}
              <input className={cn(inputCls, "mt-0.5")} value={draft.baseUrl} placeholder="https://..."
                     onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
            </label>
            <label className="text-[12px] text-text-muted">{t("settings.model")}
              <input className={cn(inputCls, "mt-0.5")} value={draft.model}
                     onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
            </label>
            <label className="text-[12px] text-text-muted">{t("settings.apiKey")}
              <input className={cn(inputCls, "mt-0.5")} type="password" value={draft.apiKey} autoComplete="off"
                     onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
            </label>
          </div>
          <p className="m-0 mt-1.5 text-[11.5px] text-text-muted">{t("settings.keyHint")}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={saveDraft}>{t("settings.save")}</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || testingId === draft.id} onClick={testDraftForm}>
              {testingId === draft.id ? t("settings.testing") : t("settings.test")}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDraft(null)}>{t("settings.cancel")}</button>
          </div>
        </div>
      )}

      {/* 添加 + 预设 */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !!draft} onClick={() => startAdd()}>
          ＋ {t("settings.add")}
        </button>
        <span className="text-[12px] text-text-muted">{t("settings.preset")}:</span>
        {MODEL_PRESETS.map((p) => (
          <button key={p.label} type="button" className="btn btn-secondary btn-sm" disabled={busy || !!draft}
                  onClick={() => startAdd(p)}>{p.label}</button>
        ))}
      </div>
    </Dialog>
  );
}
