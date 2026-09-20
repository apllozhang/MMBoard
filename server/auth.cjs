/**
 * 认证与会话(R03)——内网单工具的最小可靠实现:
 *  · 账号存数据卷 auth.json(username + salt + scrypt hash + sessionSecret),文件不存在则初始化默认账号
 *  · 会话为无状态签名 token(HMAC-SHA256,含过期时间与用户名),放 HttpOnly Cookie;
 *    改密后轮换 sessionSecret 使全部旧会话失效
 *  · 生产部署后请立即登录修改默认密码
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_USERNAME = "admin";
const DEFAULT_PASSWORD = "mmboard2026";   // 首次启动生成,登录后请修改

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}

function authPath(DATA) { return path.join(DATA, "auth.json"); }

/** 载入或初始化账号文件(数据卷内持久) */
function loadAuth(DATA) {
  const f = authPath(DATA);
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { console.error("[auth] auth.json 解析失败,重新初始化:", e.message); }
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const auth = {
    username: DEFAULT_USERNAME,
    salt,
    hash: hashPassword(DEFAULT_PASSWORD, salt),
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    defaultPassword: true,          // 提醒未改密
  };
  fs.writeFileSync(f, JSON.stringify(auth, null, 2));
  console.log(`[auth] 初始化账号 ${DEFAULT_USERNAME} / ${DEFAULT_PASSWORD}(登录后请立即修改密码)`);
  return auth;
}

function saveAuth(DATA, auth) { fs.writeFileSync(authPath(DATA), JSON.stringify(auth, null, 2)); }

function verifyPassword(auth, username, password) {
  const u = String(username || "");
  const p = String(password || "");
  if (u !== auth.username) return false;
  const a = Buffer.from(auth.hash, "hex");
  const b = crypto.scryptSync(p, auth.salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 签名 token:`<exp>.<userB64>.<hmac(exp:user)>` */
function issueToken(auth, username, ttlMs = 7 * 24 * 3600 * 1000) {
  const exp = Date.now() + ttlMs;
  const user = Buffer.from(String(username), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", auth.sessionSecret).update(`${exp}:${user}`).digest("hex");
  return `${exp}.${user}.${sig}`;
}

/** 校验通过返回 { username },否则 null */
function verifyToken(auth, token) {
  const s = String(token || "");
  const parts = s.split(".");
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

/** 已登出 token 黑名单(内存;服务重启后清空——无状态会话的务实折中) */
const revoked = new Set();
function revokeToken(token) { if (token) revoked.add(String(token)); }
function isRevoked(token) { return revoked.has(String(token)); }

function readSessionCookie(req) {
  const raw = req.headers.cookie || "";
  for (const pair of raw.split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k === "mt_session") return v.join("=");
  }
  return null;
}

module.exports = { loadAuth, saveAuth, hashPassword, verifyPassword, issueToken, verifyToken, readSessionCookie, revokeToken, isRevoked };
