/**
 * VersionBadge — 顶栏版本徽章（UI-CHECKLIST N5/B3）
 * 运行时读取 public/design-system.version.json 真源渲染；迭代只改 JSON，无需动组件。
 */
import { useEffect, useState } from "react";

interface VersionInfo {
  version: string;
  released: string;
  short: string;
}

export function VersionBadge() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("./design-system.version.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: VersionInfo) => { if (alive) setInfo(j); })
      .catch(() => { /* 徽章缺失时不渲染占位，避免破版式 */ });
    return () => { alive = false; };
  }, []);
  if (!info) return null;
  return (
    <span className="ver-badge"
          title={`${info.version} · ${info.released}`}>
      {info.short} · {info.released}
    </span>
  );
}
