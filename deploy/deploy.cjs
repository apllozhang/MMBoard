/* 部署 symphony-console 到目标机 docker(独立容器,宿主端口默认 8099 → 容器 8080)
 *
 * R11 流程(先候选后切换,旧服务全程可用):
 *   1. 本地打包(tar 清单:dist/public/server 代码/vendor/ Dockerfile;不含任何密钥)
 *   2. 上传解压 → docker build 候选镜像 :cand(退出码可靠,不用管道)
 *   3. 起候选容器(临时端口、不挂数据卷)→ /api/version + /api/auth/status 健康检查
 *   4. 候选健康才切换:停删旧容器 → 用候选镜像按生产参数(端口+数据卷+restart)起正式容器 → 再验
 *      切换失败自动用旧镜像回滚;旧镜像保留供手工回退
 * 用法:node deploy/deploy.cjs   (DEPLOY_HOST/DEPLOY_PORT 可覆盖;凭据 deploy.secret.json 不入库)
 */
"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;                       // symphony-console/deploy
const PROJ = path.join(HERE, "..");           // symphony-console/
const REPO = path.join(PROJ, "..", "repo");   // 规范仓库(凭据所在)

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
const PORT = process.env.DEPLOY_PORT || "8099";
const CAND_PORT = process.env.DEPLOY_CAND_PORT || "18099";
const DATA_VOL = process.env.DEPLOY_DATA_VOL || "/home/alec/ale-symphony-console-data";
const TAR = process.env.TAR_BIN || (process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar");
const TARGZ = path.join(HERE, "symphony.tgz");
const REMOTE_DIR = "/home/alec/ale-symphony-console";
const NAME = "ale-symphony-console";
const IMAGE_CAND = `${NAME}:cand`;

/** 当前提交号(部署一致性核对用) */
function gitCommit() {
  try { return execSync("git rev-parse --short HEAD", { cwd: PROJ }).toString().trim(); }
  catch { return "unknown"; }
}

function pack() {
  if (!fs.existsSync(path.join(PROJ, "dist", "index.html"))) {
    console.error("[deploy] 缺少 dist/,先在项目根执行 npm run build");
    process.exit(1);
  }
  // R10 清单:server 代码(含 local/auth)、vendor、Dockerfile;不含 meeting.secret.json(R12,密钥在数据卷)
  execSync(`"${TAR}" -czf "${TARGZ}" -C "${PROJ}" dist public/assets vendor vendor/echarts.min.js server/package.json server/iflytek.cjs server/llm.cjs server/minutes-template.cjs server/pipeline.cjs server/local.cjs server/auth.cjs server/persist.cjs server/server.cjs server/node_modules deploy/Dockerfile`, { stdio: "inherit" });
  console.log("packed:", fs.statSync(TARGZ).size, "bytes");
}

/** 远程执行,拒绝管道掩盖:构建等关键命令直接看退出码 */
function run(conn, cmd, quiet = false) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("close", (code) => resolve({ code, out }));
      stream.on("data", (d) => { out += d.toString(); if (!quiet) process.stdout.write(d); });
      stream.stderr.on("data", (d) => { out += d.toString(); if (!quiet) process.stderr.write(d); });
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
  const COMMIT = gitCommit();
  const BUILD_TIME = new Date().toISOString();
  console.log(`[deploy] commit=${COMMIT} builtAt=${BUILD_TIME}`);
  pack();

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on("ready", resolve);
    conn.on("error", reject);
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
  });
  console.log("connected to", HOST);

  // ── 1. 上传 + 解压(旧容器未动) ──
  await put(conn, TARGZ, "/home/alec/symphony.tgz");
  console.log("uploaded");
  for (const s of [
    `rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}`,
    `cd ${REMOTE_DIR} && tar -xzf /home/alec/symphony.tgz && mv deploy/Dockerfile .`,
  ]) {
    const r = await run(conn, s, true);
    if (r.code !== 0) { console.error("[deploy] unpack failed"); conn.end(); process.exit(1); }
  }

  // ── 2. 构建候选镜像(退出码可靠)——标签含 commit,另取不可变 imageID 用于运行与回滚 ──
  const build = await run(conn, `cd ${REMOTE_DIR} && docker build --build-arg GIT_COMMIT=${COMMIT} --build-arg BUILD_TIME="${BUILD_TIME}" -t ${IMAGE_CAND} .`, true);
  if (build.code !== 0) {
    console.error("[deploy] image build FAILED — 旧容器保持不动");
    conn.end(); process.exit(1);
  }
  const imageId = (await run(conn, `docker inspect --format '{{.Id}}' ${IMAGE_CAND}`, true)).out.trim();
  if (!imageId.startsWith("sha256:")) { console.error("[deploy] cannot resolve image ID"); conn.end(); process.exit(1); }
  console.log("[deploy] candidate built:", imageId.slice(0, 24));

  // ── 3. 候选容器(临时端口,挂生产数据卷验证真实兼容) ──
  await run(conn, `docker rm -f ${NAME}-cand >/dev/null 2>&1 || true`, true);
  const runCand = await run(conn, `docker run -d --name ${NAME}-cand -p ${CAND_PORT}:8080 -v ${DATA_VOL}:/app/server/data ${imageId}`);
  if (runCand.code !== 0) { console.error("[deploy] candidate start FAILED — 旧容器保持不动"); conn.end(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 4000));
  // R11:两个健康项分别断言 2xx(curl -f,不拼接 includes)
  const h1 = await run(conn, `curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:${CAND_PORT}/api/version`, true);
  const h2 = await run(conn, `curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:${CAND_PORT}/api/auth/status`, true);
  const verBody = await run(conn, `curl -sf http://127.0.0.1:${CAND_PORT}/api/version`, true);
  if (h1.code !== 0 || !/^2\d\d$/.test(h1.out.trim()) || h2.code !== 0 || !/^2\d\d$/.test(h2.out.trim()) || !verBody.out.includes(`"commit":"${COMMIT}"`)) {
    console.error(`[deploy] candidate health FAILED (version=${h1.out.trim()} status=${h2.out.trim()}) — 删除候选,旧容器保持不动`);
    await run(conn, `docker rm -f ${NAME}-cand >/dev/null 2>&1 || true`, true);
    conn.end(); process.exit(1);
  }
  console.log("[deploy] candidate healthy");

  // ── 4. 切换(记录旧镜像供回滚;切换后正式容器健康失败则回滚) ──
  // 旧容器运行镜像的不可变 ID(回滚依据;不依赖可变标签)
  const oldImageId = (await run(conn, `docker inspect --format '{{.Image}}' ${NAME}`, true)).out.trim();
  console.log("[deploy] rollback image ID:", oldImageId.slice(0, 24));
  await run(conn, `docker stop ${NAME} >/dev/null 2>&1 || true`, true);
  await run(conn, `docker rm ${NAME} >/dev/null 2>&1 || true`, true);
  const runProd = await run(conn, `docker run -d --name ${NAME} -p ${PORT}:8080 -v ${DATA_VOL}:/app/server/data --restart unless-stopped ${imageId}`);
  if (runProd.code !== 0) {
    console.error("[deploy] prod start FAILED — 回滚到旧镜像 ID");
    await run(conn, `docker run -d --name ${NAME} -p ${PORT}:8080 -v ${DATA_VOL}:/app/server/data --restart unless-stopped ${oldImageId}`, true);
    conn.end(); process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000));
  const prodHealth = await run(conn, `curl -sf http://127.0.0.1:${PORT}/api/version`, true);
  if (prodHealth.code !== 0 || !prodHealth.out.includes(`"commit":"${COMMIT}"`)) {
    console.error("[deploy] prod health/version FAILED — 回滚到旧镜像 ID");
    await run(conn, `docker rm -f ${NAME} >/dev/null 2>&1 || true`, true);
    await run(conn, `docker run -d --name ${NAME} -p ${PORT}:8080 -v ${DATA_VOL}:/app/server/data --restart unless-stopped ${oldImageId}`, true);
    conn.end(); process.exit(1);
  }
  console.log("[deploy] prod healthy, version:", prodHealth.out.trim());
  await run(conn, `docker rm -f ${NAME}-cand >/dev/null 2>&1 || true`, true);
  console.log(`DEPLOY OK → http://${HOST}:${PORT}/ (commit ${COMMIT})`);
  conn.end();
})().catch((e) => { console.error("DEPLOY FAILED:", e.message); process.exit(1); });
