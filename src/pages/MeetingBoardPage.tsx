/**
 * 会议纪要看板 —— 首页单页
 * 上传(拖拽/选择) → 状态四色卡 → 任务 14A 表格 → 流水线时间线弹层(详情/重跑/纪要链接)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ColumnDef } from "@tanstack/react-table";
import { AppShell } from "@/components/AppShell";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/Badge";
import { Dialog } from "@/components/Dialog";
import { VersionBadge } from "@/components/VersionBadge";
import { ThemeToggle, LangToggle } from "@/components/Toggles";
import { SettingsButton } from "@/components/ModelSettings";
import { toast } from "@/lib/toast";
import {
  fetchMeta, fetchTasks, restartTask, uploadMeeting, deleteTask, minutesDownloadUrl, minutesOpenUrl, fetchRerunPreview,
  patchAsrProvider, taskProgress,
  STAGE_TONE, STEP_TONE, type MeetingTask, type ServerMeta, type Stage, type RerunPreview,
} from "@/lib/meeting";
import { LogoutButton } from "@/components/AuthGate";
import { SpeakerLabels } from "@/components/SpeakerLabels";

const STAGES: Stage[] = ["queued", "extracting", "transcribing", "analyzing", "rendering", "done", "failed"];

function StatCard({ tone, value, label, hint }: {
  tone: "neutral" | "info" | "success" | "danger";
  value: number; label: string; hint: string;
}) {
  const color = `var(--status-${tone}-text)`;
  const bg = tone === "neutral" ? "var(--status-neutral-bg)" : `var(--status-${tone}-bg)`;
  return (
    <div className="card" style={{ background: bg, borderColor: "transparent" }}>
      <div className="text-[28px] font-bold leading-none tabular-nums" style={{ color }}>{value}</div>
      <div className="mt-2 text-sm font-bold" style={{ color }}>{label}</div>
      <div className="mt-0.5 text-xs" style={{ color }}>{hint}</div>
    </div>
  );
}

export default function MeetingBoardPage() {
  const { t, i18n } = useTranslation();
  const [tasks, setTasks] = useState<MeetingTask[]>([]);
  const [meta, setMeta] = useState<ServerMeta | null>(null);
  const [error, setError] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MeetingTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [rerunPreview, setRerunPreview] = useState<RerunPreview | null>(null);
  const [rerunError, setRerunError] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);   // R20:上一轮轮询未完成则跳过,防请求堆积

  // R20:详情只存 taskId,内容从最新任务列表派生——弹窗随轮询实时更新
  const detail = useMemo(() => tasks.find((x) => x.id === detailId) ?? null, [tasks, detailId]);

  const locale = i18n.language === "en" ? "en-US" : "zh-CN";
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  const load = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    fetchTasks()
      .then((x) => { setTasks(x); setError(false); })
      .catch(() => setError(true))
      .finally(() => { inFlightRef.current = false; });
  }, []);

  useEffect(() => {
    const refreshMeta = () => fetchMeta().then(setMeta).catch(() => setMeta(null));
    refreshMeta();
    load();
    pollRef.current = window.setInterval(load, 10_000);   // 流水线进行中看板 10s 轮询
    // R21:设置页保存(asr/讯飞参数/模型)后立即刷新通道状态,不等下一轮轮询
    window.addEventListener("mmb-settings-changed", refreshMeta);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      window.removeEventListener("mmb-settings-changed", refreshMeta);
    };
  }, [load]);

  const onUpload = async (file: File) => {
    setUploading(true);
    try {
      await uploadMeeting(file);
      toast("success", t("board.uploaded"));
      load();
      // 上传后 30 秒内快轮询,让流水线进度尽快可见
      let n = 0;
      const fast = window.setInterval(() => { load(); if (++n >= 15) window.clearInterval(fast); }, 2000);
    } catch (e) {
      toast("error", `${t("board.uploadFailed")}: ${(e as Error).message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const counts = useMemo(() => {
    const processing = tasks.filter((x) => !["done", "failed", "queued"].includes(x.stage)).length;
    return {
      queued: tasks.filter((x) => x.stage === "queued").length + processing,
      done: tasks.filter((x) => x.stage === "done").length,
      failed: tasks.filter((x) => x.stage === "failed").length,
    };
  }, [tasks]);

  const onRestart = async (id: string, scope: "analyze" | "all" = "all") => {
    setRestarting(true);
    try {
      await restartTask(id, scope);
      toast("success", t("board.restarted"));
      setDetailId(null);
      setRerunPreview(null);
      load();
      // 重跑期间快轮询,让进度尽快可见
      let n = 0;
      const fast = window.setInterval(() => { load(); if (++n >= 15) window.clearInterval(fast); }, 2000);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setRestarting(false);
    }
  };

  /** 整条重跑前先取额度预览,弹确认层(重新跑分析不耗转写额度,保持直接执行) */
  const askRerunAll = async (task: MeetingTask) => {
    setRerunError("");
    setRerunPreview(null);
    try {
      const p = await fetchRerunPreview(task.id);
      setRerunPreview(p);
    } catch (e) {
      setRerunError((e as Error).message);
    }
  };

  const fmtDur = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return m > 0 ? t("board.durMinSec", { m, s: sec }) : t("board.durSec", { s: sec });
  };

  /** 看板快捷切换转写通道(设置页里仍可配置本地服务地址) */
  const [switchingAsr, setSwitchingAsr] = useState(false);
  const onSwitchAsr = async (p: "iflytek" | "local") => {
    if (meta?.asrProvider === p || switchingAsr) return;
    setSwitchingAsr(true);
    try {
      if (!meta) return;
      const r = await patchAsrProvider(p, meta.settingsVersion ?? 0);
      toast("success", p === "local" ? t("board.asrSwitchedLocal") : t("board.asrSwitchedIflytek"));
      setMeta((m) => (m ? { ...m, settingsVersion: r.version, asrProvider: (r.asr.provider === "local" ? "local" : "iflytek") } : m));
      fetchMeta().then(setMeta).catch(() => undefined);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSwitchingAsr(false);
    }
  };

  /** 转写通道分段切换控件(当前通道高亮;本地离线时带警示点) */
  const asrSwitch = meta && (
    <div className="inline-flex items-center gap-2">
      <div role="group" aria-label={t("board.asrSwitch")}
           className="inline-flex overflow-hidden rounded-full border" style={{ borderColor: "var(--color-border)" }}>
        {([["iflytek", t("board.asrIflytekShort")], ["local", t("board.asrLocalShort")]] as const).map(([v, label]) => {
          const active = meta.asrProvider === v;
          return (
            <button key={v} type="button" disabled={switchingAsr}
                    aria-pressed={active}
                    title={v === "local" && meta.localAsrOnline === false ? t("board.asrLocalOff") : undefined}
                    onClick={() => onSwitchAsr(v)}
                    className="relative px-3 py-1 text-xs font-semibold transition-colors"
                    style={active
                      ? { background: "var(--color-action)", color: "#fff" }
                      : { background: "transparent", color: "var(--color-text-secondary)" }}>
              {v === "local" && meta.localAsrOnline === false && (
                <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
                      style={{ background: "var(--status-warning-text)" }} />
              )}
              {label}
            </button>
          );
        })}
      </div>
      {meta.asrProvider === "local" && (
        <span className="text-xs font-semibold"
              style={{ color: meta.localAsrOnline ? "var(--status-success-text)" : "var(--status-warning-text)" }}>
          {meta.localAsrOnline ? t("board.asrLocalOn") : t("board.asrLocalOff")}
        </span>
      )}
    </div>
  );

  /** 任务进度条(百分比 + 当前阶段;失败红条停在已完成处) */
  const progressBar = (row: MeetingTask) => {
    const { pct, running } = taskProgress(row);
    const failed = row.stage === "failed";
    return (
      <div className="flex items-center gap-2" aria-label={`${t("board.col.progress")} ${pct}%`}>
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full" style={{ background: "var(--color-border-soft)" }}>
          <div className="h-full rounded-full transition-all duration-500"
               style={{ width: `${pct}%`,
                        background: failed ? "var(--status-danger-text)" : "var(--color-action)" }} />
        </div>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums"
              style={{ color: failed ? "var(--status-danger-text)" : "var(--color-text-secondary)" }}>
          {failed ? t("stage.failed") : `${pct}%`}
        </span>
        <span className="sr-only">{running ? t(`stage.${row.stage}`) : ""}</span>
      </div>
    );
  };

  const onDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteTask(pendingDelete.id);
      toast("success", t("board.deleted"));
      setPendingDelete(null);
      setDetailId(null);
      load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const columns = useMemo<ColumnDef<MeetingTask, any>[]>(() => [
    {
      accessorKey: "id", size: 150,
      header: () => t("board.col.id"),
      cell: (c) => <span className="mono font-semibold text-action break-words">{c.getValue<string>()}</span>,
    },
    {
      accessorKey: "title", size: 260,
      header: () => t("board.col.title"),
      cell: (c) => <span className="break-words">{c.getValue<string>()}</span>,
    },
    {
      accessorKey: "stage", size: 110,
      header: () => t("board.col.stage"),
      cell: (c) => {
        const s = c.getValue<Stage>();
        return <Badge tone={STAGE_TONE[s]}>{t(`stage.${s}`)}</Badge>;
      },
    },
    {
      id: "progress", size: 160, enableSorting: false,
      header: () => t("board.col.progress"),
      cell: (c) => progressBar(c.row.original),
    },
    {
      accessorKey: "transcriptChars", size: 110,
      header: () => t("board.col.chars"),
      cell: (c) => <span className="block text-right tabular-nums">{c.getValue<number>().toLocaleString()}</span>,
    },
    {
      accessorKey: "createdAt", size: 130,
      header: () => t("board.col.createdAt"),
      cell: (c) => <span className="whitespace-nowrap text-text-muted">{fmtTime(c.getValue<string>())}</span>,
    },
    {
      id: "actions", size: 190, enableSorting: false, enableResizing: false,
      header: () => <span className="sr-only">{t("board.col.actions")}</span>,
      cell: (c) => {
        const row = c.row.original;
        const hasMinutes = row.stage === "done" && row.minutesFile;
        return (
          <div className="flex items-center gap-1.5">
            <button type="button" className="btn btn-secondary btn-sm whitespace-nowrap" aria-haspopup="dialog"
                    onClick={() => setDetailId(row.id)}>
              {t("board.detail")}
            </button>
            {hasMinutes && (
              <a className="btn btn-primary btn-sm whitespace-nowrap" href={minutesOpenUrl(row.id)} target="_blank"
                 rel="noreferrer">
                {t("board.openMinutes")}
              </a>
            )}
            {hasMinutes && (
              <a className="inline-grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[8px] border transition-colors hover:border-[var(--color-action)]"
                 style={{ borderColor: "var(--color-border)", color: "var(--color-action)" }}
                 href={minutesDownloadUrl(row.id)} download
                 title={t("board.download")} aria-label={`${t("board.download")} ${row.id}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" x2="12" y1="15" y2="3" />
                </svg>
              </a>
            )}
            <button type="button"
                    className="inline-grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[8px] border transition-colors hover:border-[var(--status-danger-graphic)]"
                    style={{ borderColor: "var(--color-border)", color: "var(--status-danger-text)" }}
                    title={t("board.delete")} aria-label={`${t("board.delete")} ${row.id}`}
                    aria-haspopup="dialog" onClick={() => setPendingDelete(row)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, locale]);

  const metaBadge = (ok: boolean | undefined, on: string, off: string) => (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
          style={{ background: ok ? "var(--status-success-bg)" : "var(--status-warning-bg)",
                   color: ok ? "var(--status-success-text)" : "var(--status-warning-text)" }}>
      {ok ? on : off}
    </span>
  );

  return (
    <AppShell
      appTitle={t("app.title")}
      logo={{ src: "assets/ale-logo.png", alt: "Alcatel-Lucent Enterprise", whiteSrc: "assets/ale-logo-white.png" }}
      topbarExtra={<VersionBadge />}
      nav={[{ label: t("nav.board"), href: "#/", current: true }]}
      breadcrumb={[{ label: t("board.title") }]}
      title={t("board.title")}
      description={t("board.subtitle")}
      actions={
        <>
          <LangToggle />
          <ThemeToggle />
          <SettingsButton />
          <LogoutButton />
        </>
      }
    >
      {error && (
        <div className="mb-4 rounded-[8px] border px-3 py-2 text-[13px]"
             style={{ background: "var(--status-danger-bg)", color: "var(--status-danger-text)" }}
             role="alert">
          {t("board.loadError")}
        </div>
      )}

      {/* 上传区(拖拽 + 选择文件,label 显式绑定 F1) */}
      <div className="card"
           onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
           onDragLeave={() => setDragOver(false)}
           onDrop={(e) => {
             e.preventDefault();
             setDragOver(false);
             const f = e.dataTransfer.files?.[0];
             if (f && !uploading) onUpload(f);
           }}
           style={dragOver ? { borderColor: "var(--ale-purple-500)", boxShadow: "var(--ring-soft)" } : undefined}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-[220px] flex-1">
            <h2 className="m-0 text-[15px]">{t("board.uploadTitle")}</h2>
            <p className="m-0 mt-1 text-[13px] text-text-muted">
              {t("board.uploadHint")}
              {meta && !meta.ffmpeg && ` ${t("board.noFfmpeg")}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" id="meeting-file" className="sr-only"
                   accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.mp4,.mov,.mkv"
                   disabled={uploading}
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
            <label htmlFor="meeting-file"
                   className="btn btn-primary"
                   style={uploading ? { opacity: 0.55, pointerEvents: "none" } : undefined}>
              {uploading ? t("board.uploading") : t("board.pickFile")}
            </label>
          </div>
        </div>
        {meta && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {asrSwitch}
            {metaBadge(meta.llmConfigured, t("board.llmOn"), t("board.llmOff"))}
            {metaBadge(meta.ffmpeg, t("board.ffmpegOn"), t("board.ffmpegOff"))}
          </div>
        )}
      </div>

      {/* 状态卡 */}
      <div className="mt-4 grid gap-3"
           style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))" }}>
        <StatCard tone="info" value={counts.queued} label={t("board.inProgress")} hint={t("board.inProgressHint")} />
        <StatCard tone="success" value={counts.done} label={t("board.doneCount")} hint={t("board.doneHint")} />
        <StatCard tone="danger" value={counts.failed} label={t("board.failedCount")} hint={t("board.failedHint")} />
      </div>

      {/* 任务表 */}
      <section className="mt-6" aria-labelledby="tasks-head">
        <h2 id="tasks-head" className="mb-2 text-[15px]">{t("board.tasksTitle")}</h2>
        <DataTable
          data={tasks}
          columns={columns}
          searchPlaceholder={t("board.search")}
          emptyText={t("board.empty")}
          selectAllLabel={t("table.selectAll")}
          flexColumnId="title"
          initialSort={[{ id: "createdAt", desc: true }]}
        />
      </section>

      {/* 删除二次确认弹层 */}
      <Dialog open={pendingDelete !== null} onClose={() => (deleting ? undefined : setPendingDelete(null))}
              title={t("board.deleteTitle")}
              footer={
                <>
                  <button className="btn btn-secondary" disabled={deleting}
                          onClick={() => setPendingDelete(null)}>{t("table.cancel")}</button>
                  <button className="btn btn-primary" disabled={deleting}
                          style={{ background: "var(--status-danger-text)" }}
                          onClick={onDelete}>
                    {deleting ? t("board.deleting") : t("board.confirmDelete")}
                  </button>
                </>
              }>
        {pendingDelete && (
          <div>
            <p className="m-0 text-[14px]" style={{ color: "var(--status-danger-text)" }}>
              {t("board.deleteWarning")}
            </p>
            <p className="mt-2 text-[13px] text-text-muted">
              {t("board.deleteText", { id: pendingDelete.id, title: pendingDelete.title })}
            </p>
          </div>
        )}
      </Dialog>

      {/* 流水线时间线弹层(D1-D5 由 Dialog 组件统一实现);R23:重跑确认弹层打开时本层 suspended */}
      <Dialog open={detail !== null} onClose={() => setDetailId(null)}
              suspended={rerunPreview !== null || rerunError !== ""}
              title={`${t("board.detailTitle")} · ${detail?.id ?? ""}`}
              footer={
                <>
                  <button className="btn btn-secondary" onClick={() => setDetailId(null)}>{t("table.cancel")}</button>
                  {detail && (detail.stage === "done" || detail.stage === "failed") && detail.hasSource !== false && (
                    <button className={`btn ${detail.hasTranscript ? "btn-secondary" : "btn-primary"}`}
                            title={t("board.rerunAllTip")}
                            onClick={() => askRerunAll(detail)}>
                      {t("board.rerunAll")}
                    </button>
                  )}
                  {detail && (detail.stage === "done" || detail.stage === "failed") && detail.hasTranscript && (
                    <button className="btn btn-primary" title={t("board.rerunAnalyzeTip")}
                            onClick={() => onRestart(detail.id, "analyze")}>
                      {t("board.rerunAnalyze")}
                    </button>
                  )}
                </>
              }>
        {detail && (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full" style={{ background: "var(--color-border-soft)" }}>
                <div className="h-full rounded-full transition-all duration-500"
                     style={{ width: `${taskProgress(detail).pct}%`,
                              background: detail.stage === "failed" ? "var(--status-danger-text)" : "var(--color-action)" }} />
              </div>
              <span className="text-xs font-semibold tabular-nums"
                    style={{ color: detail.stage === "failed" ? "var(--status-danger-text)" : "var(--color-action)" }}>
                {detail.stage === "failed" ? t("stage.failed") : `${taskProgress(detail).pct}%`}
              </span>
            </div>
            <ol className="m-0 flex list-none flex-col gap-0 p-0">
              {detail.steps.map((s, i) => (
                <li key={s.key} className="flex gap-3 py-2"
                    style={{ borderBottom: i < detail.steps.length - 1 ? "1px solid var(--color-border-soft)" : "none" }}>
                  <span aria-hidden="true"
                        className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold"
                        style={{ background: `var(--status-${STEP_TONE[s.status] === "neutral" ? "neutral" : STEP_TONE[s.status]}-bg)`,
                                 color: `var(--status-${STEP_TONE[s.status] === "neutral" ? "neutral" : STEP_TONE[s.status]}-text)` }}>
                    {s.status === "done" ? "✓" : s.status === "failed" ? "✕" : s.status === "skipped" ? "–" : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[13px] font-bold text-heading">{s.label}</span>
                      <Badge tone={STEP_TONE[s.status]}>{t(`step.${s.status}`)}</Badge>
                      {s.finishedAt && <span className="text-xs text-text-muted">{fmtTime(s.finishedAt)}</span>}
                    </div>
                    {s.note && <div className="mt-0.5 break-words text-xs text-text-muted">{s.note}</div>}
                  </div>
                </li>
              ))}
            </ol>
            {detail.error && (
              <div className="mt-3 rounded-[8px] border px-3 py-2 text-[13px]"
                   style={{ background: "var(--status-danger-bg)", color: "var(--status-danger-text)" }}
                   role="alert">
                {detail.error}
              </div>
            )}
            {detail.hasTranscript && (detail.stage === "done" || detail.stage === "failed") && (
              <SpeakerLabels taskId={detail.id} onRerendered={load} />
            )}
          </div>
        )}
      </Dialog>

      {/* 整条重跑确认弹层(额度余量提示,本地估算;置于详情弹层之后保证叠层在上) */}
      <Dialog open={rerunPreview !== null || rerunError !== ""}
              onClose={() => (restarting ? undefined : (setRerunPreview(null), setRerunError("")))}
              title={t("board.rerunAllTitle")}
              footer={
                <>
                  <button className="btn btn-secondary" disabled={restarting}
                          onClick={() => { setRerunPreview(null); setRerunError(""); }}>{t("table.cancel")}</button>
                  {rerunPreview && (
                    <button className="btn btn-primary" disabled={restarting}
                            onClick={() => detail && onRestart(detail.id, "all")}>
                      {restarting ? t("board.restarting") : t("board.rerunAllConfirm")}
                    </button>
                  )}
                </>
              }>
        {rerunError && (
          <p className="m-0 text-[14px]" style={{ color: "var(--status-danger-text)" }} role="alert">
            {t("board.rerunPreviewFail")}: {rerunError}
          </p>
        )}
        {rerunPreview && detail && (
          <div>
            {rerunPreview.provider === "local" ? (
              <>
                <p className="m-0 rounded-[8px] border px-3 py-2 text-[13px]"
                   style={{ background: "var(--status-success-bg)", color: "var(--status-success-text)" }}>
                  {t("board.rerunLocalNote")}
                </p>
                <p className="mt-2 text-[13px] text-text-muted">
                  {t("board.rerunAllText", { id: detail.id, title: detail.title })}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
                  <span>{t("board.rerunAudio")}: <b className="tabular-nums">{fmtDur(rerunPreview.audioSeconds)}</b></span>
                  {rerunPreview.estSeconds != null && (
                    <span>{t("board.rerunEstTranscribe")}: <b className="tabular-nums">≈ {fmtDur(rerunPreview.estSeconds)}</b></span>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="m-0 text-[14px]" style={{ color: "var(--status-danger-text)" }}>
                  {t("board.rerunAllWarning")}
                </p>
                <p className="mt-2 text-[13px] text-text-muted">
                  {t("board.rerunAllText", { id: detail.id, title: detail.title })}
                </p>
                {rerunPreview.mock ? (
                  <p className="mt-3 rounded-[8px] border px-3 py-2 text-[13px]"
                     style={{ background: "var(--status-warning-bg)", color: "var(--status-warning-text)" }}>
                    {t("board.rerunMock")}
                  </p>
                ) : (
                  <div className="mt-3">
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
                      <span>{t("board.rerunAudio")}: <b className="tabular-nums">{fmtDur(rerunPreview.audioSeconds)}</b></span>
                      <span>{t("board.rerunUsed")}: <b className="tabular-nums">{fmtDur(rerunPreview.usedSeconds)}</b></span>
                      <span>{t("board.rerunFree")}: <b className="tabular-nums"
                            style={{ color: rerunPreview.enough ? "var(--status-success-text)" : "var(--status-danger-text)" }}>
                        {fmtDur(rerunPreview.freeSeconds)}</b></span>
                    </div>
                    {!rerunPreview.enough && (
                      <p className="mt-2 rounded-[8px] border px-3 py-2 text-[13px]"
                         style={{ background: "var(--status-danger-bg)", color: "var(--status-danger-text)" }}
                         role="alert">
                        {t("board.rerunNotEnough")}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-text-muted">{t("board.rerunEstimateNote")}</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Dialog>
    </AppShell>
  );
}
