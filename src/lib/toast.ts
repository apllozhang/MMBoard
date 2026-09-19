/** Toast（规范 16.3：role=status/alert，右侧底部区域） */
export function toast(type: "success" | "info" | "error", msg: string) {
  let region = document.getElementById("toast-region");
  if (!region) {
    region = document.createElement("div");
    region.id = "toast-region";
    region.setAttribute("aria-live", "polite");
    region.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:700;display:grid;gap:8px";
    document.body.appendChild(region);
  }
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = msg;
  el.style.borderLeft = "4px solid var(--status-" + type + "-graphic)";
  region.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 240ms ease";
    setTimeout(() => el.remove(), 260);
  }, 3200);
}
