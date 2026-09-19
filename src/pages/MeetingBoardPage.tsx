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
import { toast } from "@/lib/toast";
import {
  fetchMeta, fetchTasks, restartTask, uploadMeeting,
  STAGE_TONE, STEP_TONE, type MeetingTask, type ServerMeta, type Stage,
} from "@/lib/meeting";

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
  const [detail, setDetail] = useState<MeetingTask | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  const locale = i18n.language === "en" ? "en-US" : "zh-CN";
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  const load = useCallback(() => {
    fetchTasks().then((x) => { setTasks(x); setError(false); }).catch(() => setError(true));
  }, []);

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => setMeta(null));
    load();
    pollRef.current = window.setInterval(load, 10_000);   // 流水线进行中看板 10s 轮询
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
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

  const onRestart = async (id: string) => {
    try {
      await restartTask(id);
      toast("success", t("board.restarted"));
      setDetail(null);
      load();
    } catch (e) {
      toast("error", (e as Error).message);
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
      id: "actions", size: 150, enableSorting: false, enableResizing: false,
      header: () => <span className="sr-only">{t("board.col.actions")}</span>,
      cell: (c) => {
        const row = c.row.original;
        return (
          <div className="flex gap-1.5">
            <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="dialog"
                    onClick={() => setDetail(row)}>
              {t("board.detail")}
            </button>
            {row.stage === "done" && row.minutesFile && (
              <a className="btn btn-primary btn-sm" href={`/outputs/${row.minutesFile}`} target="_blank"
                 rel="noreferrer">
                {t("board.openMinutes")}
              </a>
            )}
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
          <div className="mt-3 flex flex-wrap gap-2">
            {metaBadge(meta.iflytekConfigured, t("board.asrOn"), t("board.asrOff"))}
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

      {/* 流水线时间线弹层(D1-D5 由 Dialog 组件统一实现) */}
      <Dialog open={detail !== null} onClose={() => setDetail(null)}
              title={`${t("board.detailTitle")} · ${detail?.id ?? ""}`}
              footer={
                <>
                  <button className="btn btn-secondary" onClick={() => setDetail(null)}>{t("table.cancel")}</button>
                  {detail && detail.stage === "failed" && (
                    <button className="btn btn-primary" onClick={() => onRestart(detail.id)}>{t("board.restart")}</button>
                  )}
                </>
              }>
        {detail && (
          <div>
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
          </div>
        )}
      </Dialog>
    </AppShell>
  );
}
