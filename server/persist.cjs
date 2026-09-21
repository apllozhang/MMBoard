/**
 * R09 统一持久化模块:全部状态 JSON 走同一原子写(.bak 回退)与容错读路径。
 * 主文件损坏 → 用 .bak 恢复主文件并隔离损坏副本(.corrupt);主备皆坏 → 抛明确错误。
 */
"use strict";
const fs = require("fs");

/** 原子写:临时文件 + rename;写前保留一份 .bak */
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak"); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
}

function isNotFound(e) { return e && e.code === "ENOENT"; }

/** 容错读:主文件损坏 → 用 .bak 恢复主文件并隔离损坏副本,返回备份数据;皆坏 → 抛明确错误。
 *  主文件不存在ENOENT 时原样抛出,由调用方决定首次初始化。 */
function readJsonWithRecovery(file) {
  let main;
  try { main = JSON.parse(fs.readFileSync(file, "utf8")); return main; }
  catch (mainErr) {
    if (isNotFound(mainErr)) throw mainErr;
    let bak;
    try { bak = JSON.parse(fs.readFileSync(file + ".bak", "utf8")); }
    catch (bakErr) {
      throw new Error(`${file} 与 ${file}.bak 均无法解析(数据不可自动恢复,请人工处理): main=${mainErr.message} bak=${bakErr.message}`);
    }
    try { fs.copyFileSync(file, file + ".corrupt"); } catch { /* 主文件可能不存在 */ }
    fs.writeFileSync(file, JSON.stringify(bak, null, 2));
    console.error(`[persist] ${file} 损坏,已用 .bak 恢复主文件,损坏副本隔离为 ${file}.corrupt:`, mainErr.message);
    return bak;
  }
}

module.exports = { writeJsonAtomic, readJsonWithRecovery };
