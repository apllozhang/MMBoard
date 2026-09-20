/* 部署 symphony-console 到目标机 docker（独立容器,宿主端口 8096 → 容器 8080）
 * 模式与 deploy/kit/deploy-kit.js 一致:凭据读仓库根 deploy.secret.json(不入库),ssh2 + tar + docker 重建。
 * 用法:node deploy/deploy.js   (可 DEPLOY_HOST 覆盖目标机) */
"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;                       // symphony-console/deploy
const PROJ = path.join(HERE, "..");           // symphony-console/
const REPO = path.join(PROJ, "..", "repo");         // 规范仓库(凭据所在)

function loadSecret() {
  const cands = [
    path.join(REPO, "deploy.secret.json"),
    path.join(PROJ, "deploy.secret.json"),
  ];
  const f = cands.find((p) => fs.existsSync(p));
  if (!f) {
    console.error("[deploy] 缺少凭据文件 deploy.secret.json。复制 repo/deploy.secret.example.json 并填入 host/user/password。");
    process.exit(1);
  }
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const k of ["host", "user", "password"]) {
    if (!s[k]) { console.error(`[deploy] deploy.secret.json 缺字段: ${k}`); process.exit(1); }
  }
  return s;
}
const SECRET = loadSecret();

function requireSsh2() {
  const cands = [
    path.join(REPO, "kit", "tools", "node_modules", "ssh2"),
    path.join(HERE, "node_modules", "ssh2"),
    "ssh2",
  ];
  for (const p of cands) { try { return require(p); } catch (e) { /* 依次尝试 */ } }
  console.error("[deploy] 找不到 ssh2:在 repo/kit/tools 下 npm ci 后重试");
  process.exit(1);
}
const { Client } = requireSsh2();

const HOST = process.env.DEPLOY_HOST || SECRET.host;
const USER = SECRET.user;
const PASS = SECRET.password;
const PORT = process.env.DEPLOY_PORT || "8096";
const TAR = process.env.TAR_BIN || (process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar");
const TARGZ = path.join(HERE, "symphony.tgz");
const REMOTE_DIR = "/home/alec/ale-symphony-console";
const NAME = "ale-symphony-console";

function pack() {
  if (!fs.existsSync(path.join(PROJ, "dist", "index.html"))) {
    console.error("[deploy] 缺少 dist/,先在项目根执行 npm run build");
    process.exit(1);
  }
  execSync(`"${TAR}" -czf "${TARGZ}" -C "${PROJ}" dist public/assets server/package.json server/iflytek.cjs server/llm.cjs server/minutes-template.cjs server/pipeline.cjs server/local.cjs server/auth.cjs server/server.cjs server/node_modules deploy/Dockerfile`, { stdio: "inherit" });
  console.log("packed:", fs.statSync(TARGZ).size, "bytes");
}

function run(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("close", (code) => resolve({ code, out }));
      stream.on("data", (d) => { out += d; process.stdout.write(d); });
      stream.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    });
  });
}

function put(conn, local, remote) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remote);
      ws.on("close", resolve);
      ws.on("error", reject);
      fs.createReadStream(local).pipe(ws);
    });
  });
}

(async () => {
  pack();
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on("ready", resolve);
    conn.on("error", reject);
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
  });
  console.log("connected to", HOST);

  await run(conn, `docker rm -f ${NAME} >/dev/null 2>&1 || true`);
  await new Promise((r) => setTimeout(r, 800));
  const chk = await run(conn, `docker --version && (ss -tln | grep -q ':${PORT} ' && echo PORT_BUSY || echo PORT_FREE)`);
  if (chk.out.includes("PORT_BUSY")) { console.error(`port ${PORT} busy`); conn.end(); process.exit(2); }

  const steps = [
    `mkdir -p ${REMOTE_DIR}`,
    `cd ${REMOTE_DIR} && tar -xzf ~/symphony.tgz && mv deploy/Dockerfile .`,
    `cd ${REMOTE_DIR} && docker build -t ${NAME} . 2>&1 | tail -3`,
    `docker run -d --name ${NAME} -p ${PORT}:8080 -v /home/alec/ale-symphony-console-data:/app/server/data --restart unless-stopped ${NAME}`,
    // ASSET GATE:首页 / 版本真源 / Logo / 字体 CSS 全 200 才算部署成功
    `sleep 1 && for u in / /design-system.version.json /assets/ale-logo.png /fonts/noto.css; do code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${PORT}$u); echo "$code $u"; if [ "$code" != "200" ]; then echo "ASSET GATE FAILED: $u"; exit 1; fi; done`,
  ];
  await put(conn, TARGZ, `/home/alec/symphony.tgz`);
  console.log("uploaded");
  for (const s of steps) {
    const res = await run(conn, s);
    if (res.code !== 0) { console.error("step failed:", s); conn.end(); process.exit(1); }
  }
  console.log(`DEPLOY OK → http://${HOST}:${PORT}/`);
  conn.end();
})().catch((e) => { console.error("DEPLOY FAILED:", e.message); process.exit(1); });
