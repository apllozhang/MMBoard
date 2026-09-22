/**
 * 认证与会话(R03,复审整改):
 *  · 账号存数据卷 auth.json;**首次初始化生成一次性随机密码,仅打印到启动日志一次**
 *  · auth.json 损坏 → 抛错拒绝服务(fail-closed),绝不静默恢复公开默认密码
 *  · 会话为无状态 HMAC token(含过期与用户名);改密轮换 sessionSecret 全端失效
 *  · 登出 token 入内存黑名单
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function authPath(DATA) { return path.join(DATA, "auth.json"); }
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}

function parseAuthFile(f) {
  const a = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!a.username || !a.salt || !a.hash || !a.sessionSecret) {
    throw new Error("auth.json 字段不完整");
  }
  return a;
}

/** 载入账号;文件缺失 → 一次性随机密码初始化;损坏 → 抛错(fail-closed) */
function loadAuth(DATA) {
  const f = authPath(DATA);
  if (fs.existsSync(f)) {
    try { return parseAuthFile(f); }
    catch (e) {
      // fail-closed:配置损坏绝不重建默认账号;损坏文件保留供人工恢复
      throw new Error(`认证配置损坏(${f}),服务拒绝启动。请从备份恢复或删除该文件后重新初始化: ${e.message}`);
    }
  }
  // R03 复审:支持环境注入(自动化测试/受控部署);未注入时用一次性随机密码(仅日志可见)
  const password = process.env.MMB_ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  const auth = {
    username: "admin",
    salt,
    hash: hashPassword(password, salt),
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    defaultPassword: true,
  };
  // 二轮复审 R03:首次初始化与 saveAuth 同一保护——临时文件 + rename 原子写,显式 0600(仅属主可读写)
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
  console.log("=".repeat(64));
  console.log(`[auth] 首次初始化账号: admin / ${password}`);
  console.log(`[auth] 请立即登录并修改密码(此密码仅本次启动日志可见)`);
  console.log("=".repeat(64));
  return auth;
}

function saveAuth(DATA, auth) {
  const tmp = authPath(DATA) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, authPath(DATA));
}

function verifyPassword(auth, username, password) {
  const u = String(username || "");
  const p = String(password || "");
  if (u !== auth.username) return false;
  const a = Buffer.from(auth.hash, "hex");
  const b = crypto.scryptSync(p, auth.salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** token:`<exp>.<userB64>.<hmac(exp:user)>` */
function issueToken(auth, username, ttlMs = 7 * 24 * 3600 * 1000) {
  const exp = Date.now() + ttlMs;
  const user = Buffer.from(String(username), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", auth.sessionSecret).update(`${exp}:${user}`).digest("hex");
  return `${exp}.${user}.${sig}`;
}

function verifyToken(auth, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [exp, user, sig] = parts;
  if (!/^\d+$/.test(exp) || !user) return null;
  const expect = crypto.createHmac("sha256", auth.sessionSecret).update(`${exp}:${user}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(exp) <= Date.now()) return null;
  try { return { username: Buffer.from(user, "base64url").toString("utf8") }; }
  catch { return null; }
}

/** 已登出 token 黑名单(内存;进程重启清空,token 自然到期) */
const revoked = new Set();
const revokeToken = (t) => { if (t) revoked.add(String(t)); };
const isRevoked = (t) => revoked.has(String(t));

function readSessionCookie(req) {
  for (const pair of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k === "mt_session") return v.join("=");
  }
  return null;
}

module.exports = { loadAuth, saveAuth, hashPassword, verifyPassword, issueToken, verifyToken, readSessionCookie, revokeToken, isRevoked };
