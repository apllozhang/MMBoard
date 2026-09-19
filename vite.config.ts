import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // 子路径部署（8095 Kit 站 /react/）必须相对资产根；禁止再用 CLI 临时参数修表象
  base: "./",
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
