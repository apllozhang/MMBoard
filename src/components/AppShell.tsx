/** App Shell（CMP-SHELL）：工作台外壳——Topbar + Sidebar + Breadcrumb + PageHeader + Content */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface NavItem { label: string; href: string; current?: boolean }

export function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="面包屑" className="mb-3 flex flex-wrap items-center gap-1.5 text-[13px] text-text-muted">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true">/</span>}
          {it.href ? <a href={it.href} className="text-text-secondary">{it.label}</a>
                  : <span aria-current="page">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({ title, description, actions }: {
  title: string; description?: string; actions?: React.ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="m-0 text-[32px] leading-[1.2] max-md:text-[26px]">{title}</h1>
        {description && <p className="m-0 mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 pt-2">{actions}</div>}
    </header>
  );
}

/**
 * 工作台外壳。children = 页面内容；sidebar = 导航（≤980px 转抽屉）。
 * 键盘：抽屉焦点圈闭 + Esc；Skip link 由页面提供。
 */
export function AppShell({ logo, appTitle, nav, topbarExtra, sidebarExtra, breadcrumb, title, description, actions, children }: {
  logo?: { src: string; alt: string; whiteSrc?: string };
  appTitle?: string;
  nav?: NavItem[];
  /** 顶栏右侧插槽（版本徽章 / 全局标签），位于标题与工具按钮之间 */
  topbarExtra?: React.ReactNode;
  sidebarExtra?: React.ReactNode;
  breadcrumb?: Array<{ label: string; href?: string }>;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const drawerPanelRef = useRef<HTMLElement>(null);
  // 抽屉焦点管理（R15，复用 Drawer FB-FOCUS-001 模式）：打开聚焦首项、
  // Tab/Shift+Tab 圈闭、Esc 关闭、关闭后焦点归还触发按钮
  useEffect(() => {
    if (!drawer) return;
    const panel = drawerPanelRef.current;
    if (!panel) return;
    const trigger = document.activeElement as HTMLElement | null;
    const first = panel.querySelector<HTMLElement>("button,[href],input,select,textarea");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDrawer(false); return; }
      if (e.key !== "Tab") return;
      const list = Array.from(panel.querySelectorAll<HTMLElement>("button,[href],input,select,textarea"))
        .filter((x) => !x.hasAttribute("disabled"));
      if (!list.length) return;
      if (e.shiftKey && document.activeElement === list[0]) { list[list.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === list[list.length - 1]) { list[0].focus(); e.preventDefault(); }
    };
    panel.addEventListener("keydown", onKey);
    return () => { panel.removeEventListener("keydown", onKey); trigger?.focus(); };
  }, [drawer]);

  const sidebar = (
    <nav aria-label="主导航" className="flex flex-col gap-0.5">
      {nav?.map((n) => (
        <a key={n.href} href={n.href}
           aria-current={n.current ? "page" : undefined}
           className={cn("min-h-[44px] rounded-[8px] px-3 py-2.5 text-sm no-underline",
             n.current ? "font-bold text-heading" : "text-text-secondary hover:bg-tint")}
           style={n.current ? { background: "var(--color-purple-tint)", boxShadow: "inset 3px 0 0 var(--ale-purple-600)" } : undefined}>
          {n.label}
        </a>
      ))}
      {sidebarExtra}
    </nav>
  );

  return (
    <div className="min-h-screen">
      {/* Skip link（UI-CHECKLIST N3：第一个可聚焦元素，跳过导航直达主内容） */}
      <a className="fixed left-4 -top-20 z-[900] rounded-[8px] bg-[color:var(--ale-purple-700)] px-4 py-2 text-white no-underline focus:top-4"
         href="#main">跳到主要内容</a>

      {/* Topbar（内容型 3px 底条；工作台可用 .topbar--plain） */}
      <header className="topbar">
        <a href="#main" className="flex items-center gap-2.5 font-bold no-underline">
          {logo && (<>
            <img src={logo.src} alt={logo.alt} className="h-[34px] w-auto dark:hidden" />
            {logo.whiteSrc && <img src={logo.whiteSrc} alt="" className="hidden h-[34px] w-auto dark:block" />}
          </>)}
        </a>
        {appTitle && <span className="text-[15px] font-bold text-heading">{appTitle}</span>}
        {topbarExtra}
        <div className="ml-auto flex items-center gap-2">
          {/* 全局工具插槽（主题/语言由应用注入） */}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1440px]">
        {/* 桌面侧栏 */}
        <aside className="hidden w-[240px] shrink-0 p-3 md:block" style={{ borderRight: "1px solid var(--color-border)" }}>
          {sidebar}
          {sidebarExtra && <div className="mt-3">{sidebarExtra}</div>}
        </aside>

        {/* 主区 */}
        <div className="min-w-0 flex-1 p-4 md:p-6">
          {breadcrumb && <Breadcrumb items={breadcrumb} />}
          <PageHeader title={title} description={description} actions={actions} />
          <main id="main" tabIndex={-1}>{children}</main>
        </div>
      </div>

      {/* 移动抽屉 */}
      {drawer && (
        <div className="fixed inset-0 z-[500] md:hidden" style={{ background: "rgb(20 14 32 / 50%)" }}
             onClick={() => setDrawer(false)}>
          <aside ref={drawerPanelRef} role="dialog" aria-modal="true" aria-label="导航菜单"
                 className="h-full w-[260px] bg-surface p-3"
                 onClick={(e) => { e.stopPropagation(); if ((e.target as HTMLElement).closest("a")) setDrawer(false); }}
                 style={{ boxShadow: "var(--shadow-md)" }}>
            {sidebar}
          </aside>
        </div>
      )}
      <button type="button" className="fixed bottom-4 right-4 z-[400] grid h-12 w-12 place-items-center rounded-full text-white md:hidden"
              style={{ background: "var(--color-action)" }} aria-label="打开导航菜单"
              aria-expanded={drawer} onClick={() => setDrawer((v) => !v)}>
        ☰
      </button>
    </div>
  );
}
