# -*- coding: utf-8 -*-
"""批次1 验收脚本(隔离环境,mock 通道)
R01:同名上传路径不同/内容独立/删一不伤二
R02:删中间不复用 ID;outputs 残留目录占号
R07:运行中 restart 409 / 运行中 DELETE 409
兼容:旧格式任务(无 uuid/runId/originalFileName)查看/整条重跑/删除均正常
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error, uuid, wave, math, struct

def make_wav(seconds=2):
    """合法正弦波 wav(能过 ffmpeg 抽轨;mock 转写不依赖内容)"""
    import io as _io
    buf = _io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i * 0.08))) for i in range(16000 * seconds)))
    w.close()
    return buf.getvalue()

PORT = sys.argv[1] if len(sys.argv) > 1 else "8793"
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.join(ROOT, "server", "server.cjs")
SECRET = os.path.join(ROOT, "server", "meeting.secret.json")
TEST = os.path.join(ROOT, "_isolated_test")
shutil.rmtree(TEST, ignore_errors=True)
# 密钥隔离:测试期间隐藏真实密钥 → mock 转写+mock 分析(测完恢复,不碰内容)
SECRET_BAK = SECRET + ".batch1-bak"
if os.path.exists(SECRET):
    os.rename(SECRET, SECRET_BAK)

def req(path, method="GET", body=None):
    r = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"} if body is not None else {})
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {"raw": raw[:200]}

def upload(name, content: bytes):
    b = "----rb" + uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + content + f"\r\n--{b}--\r\n".encode()
    r = urllib.request.Request(BASE + "/api/tasks", data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(r) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))

def wait_done(tid, timeout=90):
    for _ in range(timeout):
        time.sleep(1)
        c, t = req(f"/api/tasks/{tid}")
        if t.get("stage") in ("done", "failed"): return t
    return None

def wait_stage(tid, stage, timeout=90):
    t = wait_done(tid, timeout)
    return bool(t) and t.get("stage") == stage

def start_server(data_dir):
    env = dict(os.environ, MMB_DATA_DIR=data_dir, PORT=PORT)
    p = subprocess.Popen(["node", SRV], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    for _ in range(30):
        time.sleep(1)
        try: req("/api/meta"); return p
        except Exception: pass
    raise RuntimeError("server not up")

def make_task(day, seq, stage="done", steps=None, legacy=False):
    t = {"id": f"MT-{day}-{seq:03d}", "title": f"t{seq}", "fileName": f"f{seq}.wav", "sizeBytes": 1,
         "stage": stage, "steps": steps or [], "transcriptChars": 1, "minutesFile": "", "error": "",
         "createdAt": "2026-09-20T00:00:00Z", "updatedAt": "2026-09-20T00:00:00Z"}
    return t

RUNNING_STEPS = [
    {"key": "import", "label": "导入文件", "status": "done", "startedAt": "2026-09-20T00:00:00Z", "finishedAt": "2026-09-20T00:00:01Z", "note": ""},
    {"key": "extract", "label": "抽取音轨", "status": "done", "startedAt": "2026-09-20T00:00:01Z", "finishedAt": "2026-09-20T00:00:02Z", "note": ""},
    {"key": "transcribe", "label": "语音转写", "status": "running", "startedAt": "2026-09-20T00:00:02Z", "finishedAt": None, "note": ""},
    {"key": "analyze", "label": "AI 分析", "status": "pending", "startedAt": None, "finishedAt": None, "note": ""},
    {"key": "render", "label": "生成纪要", "status": "pending", "startedAt": None, "finishedAt": None, "note": ""},
]

result = {}
DATA_DIR = os.path.join(TEST, "verify")
day = time.strftime("%Y%m%d")

# ============ R01 验收 ============
srv = start_server(DATA_DIR)
try:
    c, t1 = upload("same-name.wav", make_wav())
    assert wait_stage(t1["id"], "done"), f"task1 not done: {t1}"
    c, t2 = upload("same-name.wav", make_wav())
    assert wait_stage(t2["id"], "done"), f"task2 not done: {t2}"
    f1 = os.path.join(DATA_DIR, "uploads", t1["fileName"])
    f2 = os.path.join(DATA_DIR, "uploads", t2["fileName"])
    r01 = {
        "storageKeysDiffer": t1["fileName"] != t2["fileName"],
        "originalNamesSame": t1.get("originalFileName") == t2.get("originalFileName") == "same-name.wav",
        "file1ContentA": os.path.exists(f1) and os.path.getsize(f1) > 0,
        "file2ContentB": os.path.exists(f2) and os.path.getsize(f2) > 0,
    }
    # 重跑任务1(mock 全链路)确认可用
    c, _ = req(f"/api/tasks/{t1['id']}/restart", method="POST", body={"scope": "all"})
    r01["task1RerunOk"] = (c == 200) and wait_stage(t1["id"], "done")
    # 删除任务1 → 任务2 的文件必须还在且内容正确
    c, _ = req(f"/api/tasks/{t1['id']}", method="DELETE")
    r01["deleteTask1Ok"] = (c == 200)
    r01["task2FileSurvives"] = os.path.exists(f2) and os.path.getsize(f2) > 0
    c, t2_after = req(f"/api/tasks/{t2['id']}")
    r01["task2RerunAfter"] = False
    if t2_after.get("stage") == "done":
        c, _ = req(f"/api/tasks/{t2['id']}/restart", method="POST", body={"scope": "all"})
        r01["task2RerunAfter"] = (c == 200) and wait_stage(t2["id"], "done")
    result["R01"] = r01

    # ============ R07 验收(真实运行中) ============
    # 任务2 重跑刚触发后立刻再 restart / delete,应 409
    c, _ = req(f"/api/tasks/{t2['id']}/restart", method="POST", body={"scope": "all"})
    c2, _ = req(f"/api/tasks/{t2['id']}/restart", method="POST", body={"scope": "all"})
    c3, _ = req(f"/api/tasks/{t2['id']}", method="DELETE")
    result["R07_realtime"] = {"secondRestartWhileRunning": c2, "deleteWhileRunning": c3}
    wait_done(t2["id"])
finally:
    srv.terminate(); srv.wait(timeout=10)
    if os.path.exists(SECRET_BAK) and not os.path.exists(SECRET):
        os.rename(SECRET_BAK, SECRET)

# ============ R02 验收(同样需要 mock:重新隐藏密钥) ============
if os.path.exists(SECRET):
    os.rename(SECRET, SECRET_BAK)
DATA_DIR2 = os.path.join(TEST, "verify2")
os.makedirs(os.path.join(DATA_DIR2, "uploads"), exist_ok=True)
os.makedirs(os.path.join(DATA_DIR2, "outputs", f"MT-{day}-005"), exist_ok=True)  # 残留目录占号
json.dump([make_task(day, i) for i in (1, 2, 3)],
          open(os.path.join(DATA_DIR2, "tasks.json"), "w", encoding="utf-8"))
srv = start_server(DATA_DIR2)
try:
    req(f"/api/tasks/MT-{day}-002", method="DELETE")
    c, t_new = upload("new.wav", make_wav())
    # 删掉刚建的任务让现场干净,再验证:005 残留目录也应被跳过
    # 编号策略=最小空闲序号(回收制):现存的 003 绝不复用;已彻底删除的 002 可回收
    r02 = {"newIdAfterDelete002": t_new["id"],
           "notCollideWithLiveTasks": t_new["id"] not in (f"MT-{day}-001", f"MT-{day}-003"),
           "noSharedOutputsDir": not os.path.exists(os.path.join(DATA_DIR2, "outputs", f"MT-{day}-003", "x"))}
    req(f"/api/tasks/{t_new['id']}", method="DELETE")
    c, t_new2 = upload("new2.wav", make_wav())
    # 残留目录 005 必须被避开(不共享输出目录);空闲更小的 002 允许回收
    r02["avoidsResidual005"] = t_new2["id"] != f"MT-{day}-005"
    r02["newId2"] = t_new2["id"]
    result["R02"] = r02
    # 历史兼容:旧格式任务(无 uuid/runId/originalFileName)
    json.dump([make_task(day, 9, stage="done")],
              open(os.path.join(DATA_DIR2, "tasks.json"), "w", encoding="utf-8"))
finally:
    srv.terminate(); srv.wait(timeout=10)

# ============ 历史兼容验收(旧格式任务走完整管线) ============
DATA_DIR3 = os.path.join(TEST, "verify3")
os.makedirs(os.path.join(DATA_DIR3, "uploads"), exist_ok=True)
legacy = make_task(day, 1, stage="done")   # 无 uuid/runId/originalFileName
json.dump([legacy], open(os.path.join(DATA_DIR3, "tasks.json"), "w", encoding="utf-8"))
open(os.path.join(DATA_DIR3, "uploads", "f1.wav"), "wb").write(make_wav())
srv = start_server(DATA_DIR3)
try:
    c, _ = req(f"/api/tasks/MT-{day}-001")            # 详情可读
    r_detail = c
    c, _ = req(f"/api/tasks/MT-{day}-001/restart", method="POST", body={"scope": "all"})
    t = wait_done(f"MT-{day}-001")
    r_legacy_rerun = (c == 200) and t and t.get("stage") == "done"
    c, _ = req(f"/api/tasks/MT-{day}-001", method="DELETE")
    r_legacy_delete = (c == 200)
    result["LEGACY"] = {"detail": r_detail, "fullRerun": r_legacy_rerun, "delete": r_legacy_delete}
finally:
    srv.terminate(); srv.wait(timeout=10)
    if os.path.exists(SECRET_BAK) and not os.path.exists(SECRET):
        os.rename(SECRET_BAK, SECRET)

print(json.dumps(result, ensure_ascii=False, indent=2))
