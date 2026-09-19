const fs = require("fs");
const { Client } = require("D:/AIWork/ZCode/WebUI/repo/kit/tools/node_modules/ssh2");
const s = JSON.parse(fs.readFileSync("D:/AIWork/ZCode/WebUI/repo/deploy.secret.json", "utf8"));

const UPLOAD_CJS = `
const fs = require("fs");
(async () => {
  const buf = fs.readFileSync("/tmp/test-meeting.mp4");
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "video/mp4" }), "test-meeting.mp4");
  const res = await fetch("http://127.0.0.1:8080/api/tasks", { method: "POST", body: fd });
  const j = await res.json();
  console.log("created:", j.id, j.stage);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
`;

function run(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("close", (code) => resolve({ code, out }));
      stream.on("data", (d) => { out += d; });
      stream.stderr.on("data", (d) => { out += d; });
    });
  });
}

function put(conn, local, remote) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remote);
      ws.on("close", resolve); ws.on("error", reject);
      fs.createReadStream(local).pipe(ws);
    });
  });
}

(async () => {
  fs.writeFileSync("deploy/_upload-test.cjs", UPLOAD_CJS);
  const conn = new Client();
  await new Promise((res, rej) => { conn.on("ready", res); conn.on("error", rej); conn.connect({ host: s.host, port: 22, username: s.user, password: s.password, readyTimeout: 20000 }); });
  console.log("connected");

  await put(conn, "deploy/_upload-test.cjs", "/home/alec/upload-test.cjs");
  let r = await run(conn, "docker cp /home/alec/upload-test.cjs ale-symphony-console:/tmp/upload-test.cjs");
  console.log("cp:", r.code);

  // 容器内生成带语音的测试视频(mpeg4 编码,音轨来自 volume 里已有会议音频)
  r = await run(conn, "docker exec ale-symphony-console ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=10 -i /app/server/data/uploads/test-en-meeting.wav -c:v mpeg4 -q:v 5 -c:a aac -shortest /tmp/test-meeting.mp4 2>&1 | tail -2");
  console.log("ffmpeg 生成视频:", r.out.trim().split("\n").pop());

  r = await run(conn, "docker exec ale-symphony-console node /tmp/upload-test.cjs");
  console.log("上传:", r.out.trim());

  await new Promise((res) => setTimeout(res, 50000));
  r = await run(conn, "curl -s http://127.0.0.1:8080/api/tasks | head -c 4000");
  const tasks = JSON.parse(r.out.slice(0, r.out.lastIndexOf("]") + 1));
  const t = tasks.find((x) => x.fileName === "test-meeting.mp4");
  if (!t) { console.log("未找到视频任务"); process.exit(1); }
  console.log(t.id, t.stage, "|", t.title, "| chars:", t.transcriptChars, "| err:", t.error.slice(0, 80));
  for (const st of t.steps) console.log("  ", st.key.padEnd(11), st.status.padEnd(8), st.note.slice(0, 50));
  conn.end();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
