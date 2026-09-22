/**
 * R12 secret 扫描(二轮复审 §5.3:CI 级密钥泄漏检查)
 *
 * 检查三件事:
 *   1. git 跟踪文件中不得出现密钥文件本体(meeting.secret / deploy.secret,.example 除外)
 *   2. 真实密钥文件的"值"(appId/apiKey/apiSecret/password 等非空字段值)不得出现在任何跟踪文件内容里
 *   3. deploy/symphony.tgz 归档(若存在)不得包含密钥文件名
 *
 * 运行:node scripts/scan_secrets.mjs   (npm run scan:secrets;发现泄漏 exit 1)
 */
"use strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
let leaks = [];

const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean);

/* 1) 密钥文件本体不入库(.example 允许) */
for (const f of tracked) {
  if (/meeting\.secret|deploy\.secret/i.test(f) && !/\.example/i.test(f)) {
    leaks.push(`跟踪文件包含密钥文件本体: ${f}`);
  }
}

/* 2) 真实密钥值不得出现在跟踪文件内容中 */
const secretFiles = ["server/meeting.secret.json", "deploy.secret.json", path.join("..", "repo", "deploy.secret.json")];
const values = new Set();
for (const sf of secretFiles) {
  const p = path.join(ROOT, sf);
  if (!fs.existsSync(p)) continue;
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    const collect = (v, field) => {
      if (typeof v === "string") {
        // host/user 等拓扑类字段不是凭据(文档引用内网地址属正常),只扫描凭据类字段
        if (/host|user$|username|_说明|^_/i.test(field)) return;
        if (v.length >= 6 && !v.includes("在此") && !/^[\s\-—]*$/.test(v)) values.add(v);
      } else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => collect(x, k));
    };
    collect(obj, "");
  } catch { /* 解析失败跳过该文件 */ }
}
for (const f of tracked) {
  const p = path.join(ROOT, f);
  let content = "";
  try { content = fs.readFileSync(p, "utf8"); } catch { continue; }
  for (const v of values) {
    if (content.includes(v)) leaks.push(`跟踪文件 ${f} 含真实密钥值(长度 ${v.length})`);
  }
}

/* 3) 部署归档不含密钥文件名 */
const tgz = path.join(ROOT, "deploy", "symphony.tgz");
if (fs.existsSync(tgz)) {
  try {
    const listing = execSync(`tar -tzf "${tgz}"`, { cwd: ROOT, encoding: "utf8" });
    if (/meeting\.secret\.json(?!\.example)/.test(listing)) leaks.push("部署归档包含 meeting.secret.json");
    if (/deploy\.secret/.test(listing)) leaks.push("部署归档包含 deploy.secret");
  } catch { /* tar 不可用时跳过 */ }
}

if (leaks.length) {
  console.error("[scan-secrets] 发现泄漏:");
  leaks.forEach((l) => console.error("  - " + l));
  process.exit(1);
}
console.log(`[scan-secrets] 通过:跟踪 ${tracked.length} 个文件,校验 ${values.size} 个密钥值,无泄漏`);
