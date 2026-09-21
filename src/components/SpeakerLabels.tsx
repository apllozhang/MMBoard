/**
 * 说话人手动标注(R15 人工确认):详情弹窗内的可展开区块。
 * 保存映射后,若任务有可复用的分析结果则纯重渲染纪要(秒级、零额度);否则提示先重跑分析。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchSpeakers, saveSpeakers } from "@/lib/meeting";
import { toast } from "@/lib/toast";

export function SpeakerLabels({ taskId, onRerendered }: { taskId: string; onRerendered?: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [speakers, setSpeakers] = useState<string[] | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [hasAnalysis, setHasAnalysis] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const j = await fetchSpeakers(taskId);
      setSpeakers(j.speakers);
      setMap(j.map || {});
      setHasAnalysis(j.hasAnalysis);
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const filled = Object.fromEntries(Object.entries(map).filter(([, v]) => v.trim()));
    setBusy(true);
    setMessage(null);
    try {
      const j = await saveSpeakers(taskId, filled);
      if (j.rerendered) {
        setMessage({ ok: true, text: t("board.spkSavedRerendered") });
        onRerendered?.();
      } else {
        setMessage({ ok: true, text: t("board.spkSavedNoAnalysis") });
      }
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-[8px] border p-3" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-bold text-heading">{t("board.spkTitle")}</span>
        <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => { if (!open && speakers === null) load(); setOpen(!open); }}>
          {open ? t("board.spkCollapse") : t("board.spkExpand")}
        </button>
      </div>
      {open && (
        <div className="mt-2">
          {busy && <p className="m-0 text-[12px] text-text-muted">{t("board.spkLoading")}</p>}
          {speakers !== null && speakers.length === 0 && (
            <p className="m-0 text-[12px] text-text-muted">{t("board.spkNone")}</p>
          )}
          {speakers !== null && speakers.length > 0 && (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {speakers.map((sp) => (
                  <label key={sp} className="text-[12px] text-text-muted">
                    说话人{sp}
                    <input className="mt-0.5 w-full rounded-[8px] border border-border bg-surface px-2.5 py-1.5 text-[13px]"
                           placeholder={t("board.spkPlaceholder")} autoComplete="off"
                           value={map[sp] || ""} onChange={(e) => setMap({ ...map, [sp]: e.target.value })} />
                  </label>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                        onClick={save}>{t("board.spkSave")}</button>
                <span className="text-[11.5px] text-text-muted">{t("board.spkHint")}</span>
              </div>
            </>
          )}
          {message && (
            <p className="m-0 mt-2 rounded-[8px] border px-3 py-2 text-[12.5px]" role="status"
               style={{ background: message.ok ? "var(--status-success-bg)" : "var(--status-danger-bg)",
                        color: message.ok ? "var(--status-success-text)" : "var(--status-danger-text)" }}>
              {message.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
