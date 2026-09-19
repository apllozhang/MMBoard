/**
 * DataTable — 14A 数据表格功能包（规范 14/14A 章）的通用 TanStack Table 封装
 * 排序(aria-sort) · 列宽拖动(role=separator + 方向键) · 换行 · 分页(10/20/50+省略号)
 * 防抖搜索 · 可配置筛选 · 批量选择(可配批量操作) · 空态
 * 列定义由调用方传入（ColumnDef<T>），组件只负责交互行为。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Dialog } from "./Dialog";

export interface FilterConfig<T> {
  ariaLabel: string;
  options: Array<{ value: string; label: string }>;
  predicate: (row: T, value: string) => boolean;
}

export interface BatchAction<T> {
  label: string;
  danger?: boolean;
  confirm?: { title: string; body: string; okLabel: string; cancelLabel: string };
  onAction: (rows: T[]) => void;
}

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, any>[];
  searchPlaceholder: string;
  emptyText: string;
  selectAllLabel: string;
  filter?: FilterConfig<T>;
  batchActions?: BatchAction<T>[];
  /** R11：未拖动列宽时容器余量分配给该列（下限 240），默认第一个非 select 列 */
  flexColumnId?: string;
  initialSort?: SortingState;
}

const SortIcon = ({ state }: { state: "none" | "asc" | "desc" }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={state === "none" ? 2.4 : 2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {state === "none" && <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />}
    {state === "asc" && <path d="m17 11-5-5-5 5" />}
    {state === "desc" && <path d="m7 13 5 5 5-5" />}
  </svg>
);

const PgIcon = { first: "«", prev: "‹", next: "›", last: "»" };

function pageNumbers(current: number, total: number): Array<number | "…"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: Array<number | "…"> = [1];
  if (current > 3) pages.push("…");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
  if (current < total - 2) pages.push("…");
  pages.push(total);
  return pages;
}

export function DataTable<T extends { id: string | number }>({
  data, columns, searchPlaceholder, emptyText, selectAllLabel,
  filter, batchActions, flexColumnId, initialSort,
}: DataTableProps<T>) {
  const { t } = useTranslation();
  const [globalFilter, setGlobalFilter] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filterValue, setFilterValue] = useState("all");
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);
  const [selection, setSelection] = useState<Set<string | number>>(new Set());
  const [pendingBatch, setPendingBatch] = useState<BatchAction<T> | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setDebounced(globalFilter);
      table.setPageIndex(0);
    }, 300);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilter]);

  const filtered = useMemo(() => {
    let rows = data;
    if (filter && filterValue !== "all") rows = rows.filter((r) => filter.predicate(r, filterValue));
    if (debounced) {
      const q = debounced.toLowerCase();
      rows = rows.filter((r) => JSON.stringify(Object.values(r as object)).toLowerCase().includes(q));
    }
    return rows;
  }, [data, filter, filterValue, debounced]);

  // R11：未进入精确模式时，容器余量分配给 flexColumnId 列（下限 240），
  // 消除宽屏 filler 空白列；拖动后走 Σ列宽精确模式（F14 不回归）
  const [userSized, setUserSized] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth));
    ro.observe(el);
    setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const flexId = flexColumnId ?? columns.find((c) => c.id !== "select")?.id ?? "";
  const fixedCols = 44 + columns.filter((c) => c.id !== flexId).reduce((s, c) => s + (c.size ?? 150), 0);
  const FLEX_MIN = 240;
  const flexW = userSized ? FLEX_MIN : Math.max(FLEX_MIN, wrapW - fixedCols);
  const colW = (id: string, size: number) => (!userSized && id === flexId ? flexW : size);

  const withSelect = useMemo<ColumnDef<T, any>[]>(() => [
    {
      id: "select",
      size: 44,
      enableSorting: false,
      enableResizing: false,
      header: () => {
        const pageRows = table.getRowModel().rows;
        const allSel = pageRows.length > 0 && pageRows.every((r) => selection.has(r.original.id));
        return (
          <input type="checkbox" checked={allSel} aria-label={selectAllLabel}
                 className="w-4 h-4 cursor-pointer"
                 onChange={() => setSelection((prev) => {
                   const next = new Set(prev);
                   pageRows.forEach((r) => (allSel ? next.delete(r.original.id) : next.add(r.original.id)));
                   return next;
                 })} />
        );
      },
      cell: ({ row }) => (
        <input type="checkbox" checked={selection.has(row.original.id)}
               aria-label={String(row.original.id)}
               className="w-4 h-4 cursor-pointer"
               onClick={(e) => e.stopPropagation()}
               onChange={() => setSelection((prev) => {
                 const next = new Set(prev);
                 next.has(row.original.id) ? next.delete(row.original.id) : next.add(row.original.id);
                 return next;
               })} />
      ),
    },
    ...columns,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [columns, selection, selectAllLabel]);

  const table = useReactTable({
    data: filtered,
    columns: withSelect,
    state: { sorting, globalFilter: debounced },
    onSortingChange: setSorting,
    onGlobalFilterChange: setDebounced,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    columnResizeMode: "onChange",
    initialState: { pagination: { pageSize: 10 } },
  });

  const totalPages = table.getPageCount();
  const totalRows = table.getFilteredRowModel().rows.length;
  const selectedRows = filtered.filter((r) => selection.has(r.id));

  return (
    <div className="flex flex-col gap-4">
      {/* 工具栏：防抖搜索 + 状态筛选（14A.5） */}
      <div className="flex flex-wrap items-center gap-2">
        <input className="input max-w-[320px] flex-1" type="text"
               placeholder={searchPlaceholder} value={globalFilter}
               aria-label={searchPlaceholder}
               onChange={(e) => setGlobalFilter(e.target.value)} />
        {filter && (
          <select className="input w-auto min-w-[130px]" value={filterValue} aria-label={filter.ariaLabel}
                  onChange={(e) => { setFilterValue(e.target.value); table.setPageIndex(0); }}>
            <option value="all">{filter.ariaLabel}</option>
            {filter.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </div>

      {/* 批量操作条（14A.6） */}
      {selectedRows.length > 0 && batchActions && batchActions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[8px] border px-3 py-2 text-[13px]"
             style={{ background: "var(--color-purple-tint)", borderColor: "var(--ale-purple-40)" }}>
          <span className="font-bold text-heading">
            {t("table.selected", { count: selectedRows.length })}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => setSelection(new Set())}>
            {t("table.clearSelection")}
          </button>
          {batchActions.map((a) => (
            <button key={a.label}
                    className={a.danger ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"}
                    onClick={() => (a.confirm ? setPendingBatch(a) : a.onAction(selectedRows))}>
              {a.label}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-[12px] border border-border bg-surface" style={{ boxShadow: "var(--shadow-sm)" }}>
        <div className="overflow-x-auto" ref={wrapRef}>
          {/* 宽度模式：userSized=false 填满容器（余量给 flex 列，R11）；拖动后精确像素（Σ列宽 + filler 兜底，只有目标列变，F14） */}
          <table className="data w-full"
                 style={userSized
                   ? { width: table.getTotalSize(), minWidth: 0 }
                   : { minWidth: "100%" }}>
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header, i) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted(); // false | "asc" | "desc"
                    const col = header.column;
                    return (
                      <th key={header.id} className="relative select-none"
                          style={{ width: colW(header.column.id, header.getSize()) }}
                          aria-sort={canSort ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}>
                        <div className={cn("flex items-center gap-1", canSort && "cursor-pointer")}
                             onClick={canSort ? col.getToggleSortingHandler() : undefined}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {canSort && (
                            <button type="button" className="sort-btn"
                                    aria-label={t("table.sortAsc", { col: header.id })}
                                    onClick={(e) => { e.stopPropagation(); col.getToggleSortingHandler()?.(e); }}>
                              <SortIcon state={sorted || "none"} />
                            </button>
                          )}
                        </div>
                        {/* 列宽手柄：role=separator + 方向键（14A.2） */}
                        {header.column.getCanResize() && i < hg.headers.length - 1 && (
                          <div role="separator" tabIndex={0} aria-orientation="vertical"
                               aria-label={t("table.resize", { col: header.id, px: header.getSize() })}
                               className="col-resizer"
                               onMouseDown={(e) => {
                                 e.preventDefault();
                                 setUserSized(true);
                                 (e.target as HTMLElement).classList.add("active");
                                 header.getResizeHandler()?.(e as unknown as React.MouseEvent);
                                 const onUp = () => {
                                   document.querySelectorAll(".col-resizer.active").forEach((el) => el.classList.remove("active"));
                                   document.removeEventListener("mouseup", onUp);
                                 };
                                 document.addEventListener("mouseup", onUp);
                               }}
                               onTouchStart={header.getResizeHandler()}
                               onKeyDown={(e) => {
                                 setUserSized(true);
                                 const step = e.shiftKey ? 1 : 10;
                                 const cur = table.getState().columnSizing[header.column.id] ?? header.getSize();
                                 if (e.key === "ArrowLeft") table.setColumnSizing((prev) => ({ ...prev, [header.column.id]: Math.max(50, (prev[header.column.id] ?? cur) - step) }));
                                 else if (e.key === "ArrowRight") table.setColumnSizing((prev) => ({ ...prev, [header.column.id]: Math.max(50, (prev[header.column.id] ?? cur) + step) }));
                                 else return;
                                 e.preventDefault();
                               }} />
                        )}
                      </th>
                    );
                  })}
                  {userSized && <th className="filler" aria-hidden="true" />}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr><td colSpan={withSelect.length + 1} className="table-state">{emptyText}</td></tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} aria-selected={selection.has(row.original.id)}
                      className={selection.has(row.original.id) ? "selected" : ""}
                      style={selection.has(row.original.id) ? { background: "var(--color-purple-tint)" } : undefined}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 text-[13px] border-b"
                          style={{ width: colW(cell.column.id, cell.column.getSize()), borderColor: "var(--color-border-soft)" }}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                    {userSized && <td className="filler border-b" style={{ borderColor: "var(--color-border-soft)" }} />}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 分页（14A.4） */}
        <div className="pagination">
          <div className="pg-left">
            <span>{t("table.perPage")}</span>
            <select className="input" style={{ minHeight: 32, width: 70, padding: ".2rem .6rem" }}
                    aria-label={t("table.perPage")}
                    value={table.getState().pagination.pageSize}
                    onChange={(e) => { table.setPageSize(Number(e.target.value)); table.setPageIndex(0); }}>
              {[10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>{t("table.range", {
              start: totalRows > 0 ? table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1 : 0,
              end: Math.min((table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize, totalRows),
              total: totalRows.toLocaleString(),
            })}</span>
          </div>
          <div className="pg-right">
            <button className="pg-btn" disabled={!table.getCanPreviousPage()} aria-label="首页"
                    onClick={() => table.setPageIndex(0)}>{PgIcon.first}</button>
            <button className="pg-btn" disabled={!table.getCanPreviousPage()} aria-label="上一页"
                    onClick={() => table.previousPage()}>{PgIcon.prev}</button>
            {pageNumbers(table.getState().pagination.pageIndex + 1, Math.max(1, totalPages)).map((p, i) =>
              p === "…" ? (
                <span key={`e${i}`} className="pg-ellipsis">…</span>
              ) : (
                <button key={p} className="pg-btn" aria-current={table.getState().pagination.pageIndex + 1 === p ? "page" : undefined}
                        onClick={() => table.setPageIndex(p - 1)}>{p}</button>
              ),
            )}
            <button className="pg-btn" disabled={!table.getCanNextPage()} aria-label="下一页"
                    onClick={() => table.nextPage()}>{PgIcon.next}</button>
            <button className="pg-btn" disabled={!table.getCanNextPage()} aria-label="末页"
                    onClick={() => table.setPageIndex(totalPages - 1)}>{PgIcon.last}</button>
          </div>
        </div>
      </div>

      {/* 批量操作危险确认（规范 17 章） */}
      <Dialog open={pendingBatch !== null} onClose={() => setPendingBatch(null)}
              title={pendingBatch?.confirm?.title ?? ""}
              footer={
                <>
                  <button className="btn btn-secondary" onClick={() => setPendingBatch(null)}>
                    {pendingBatch?.confirm?.cancelLabel ?? t("table.cancel")}
                  </button>
                  <button className={pendingBatch?.danger ? "btn btn-danger" : "btn btn-primary"}
                          onClick={() => {
                            if (pendingBatch) pendingBatch.onAction(selectedRows);
                            setSelection(new Set());
                            setPendingBatch(null);
                          }}>
                    {pendingBatch?.confirm?.okLabel ?? t("table.deleteOk")}
                  </button>
                </>
              }>
        {pendingBatch?.confirm?.body}
      </Dialog>
    </div>
  );
}
