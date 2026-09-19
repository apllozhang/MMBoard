import type { Config } from "tailwindcss";
import preset from "./tailwind.preset";

/**
 * 颜色/圆角/阴影/时长全部来自 tailwind.preset.js
 * （映射 shared/css/tokens.css —— 唯一色值来源，禁止在此写具体色值）。
 */
export default {
  presets: [preset],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
} satisfies Config;
