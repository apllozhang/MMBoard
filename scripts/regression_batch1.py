# -*- coding: utf-8 -*-
"""MMBoard 回归测试(批次1+复审整改项)—— 可在全新 clone 运行(仅需 Python3 + Node)。
用法: python scripts/regression_batch1.py [port]
覆盖: R01 同名上传隔离 / R02 编号唯一性(回收制)/ R07 运行互斥 / R03 匿名与CSRF / 历史格式兼容。
隔离: MMB_DATA_DIR 指向临时目录; MMB_DEMO=1 显式演示模式(mock 转写); 不触碰任何真实数据。
"""
import json, os, shutil, socket, subprocess, sys, time, urllib.request, urllib.error, uuid, wave, math, struct, io

PORT = sys.argv[1] if len(sys.argv) > 1 else "8793"
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 仓库根(修复:原误算为 scripts/)
SRV = os.path.join(ROOT, "server", "server.cjs")
SECRET = os.path.join(ROOT, "server", "meeting.secret.json")
SECRET_BAK = SECRET + ".regression-bak"
TEST = os.path.join(ROOT, "_isolated_test")
ADMIN_USER, ADMIN_PASS = "admin", "mmboard2026"

def make_wav(seconds=2):
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i * 0.08))) for i in range(16000 * seconds)))
    w.close()
    return buf.getvalue()

def port_free(p):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", int(p))) != 0

def req(path, method="GET", body=None, cookie=None, csrf=True):
    h = {}
    if cookie: h["Cookie"] = cookie
    if body is not None or method not in ("GET", "HEAD"):
        # CSRF 中间件拦截所有非 GET(与是否带 body 无关;DELETE 也必须带头)
        h["Content-Type"] = "application/json"
        if csrf: h["X-Requested-With"] = "XMLHttpRequest"
    r = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8")), dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try: return e.code, json.loads(raw), dict(e.headers)
        except Exception: return e.code, {"raw": raw[:200]}, {}

def upload(name, content: bytes, cookie=None):
    b = "----rb" + uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + content + f"\r\n--{b}--\r\n".encode()
    h = {"Content-Type": f"multipart/form-data; boundary={b}", "X-Requested-With": "XMLHttpRequest"}
    if cookie: h["Cookie"] = cookie
    r = urllib.request.Request(BASE + "/api/tasks", data=body, method="POST", headers=h)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))

def login():
    c, j, h = req("/api/auth/login", "POST", {"username": ADMIN_USER, "password": ADMIN_PASS})
    assert c == 200, f"login failed: {c} {j}"
    return (h.get("Set-Cookie") or "").split(";")[0]

def start_server(data_dir):
    """启动隔离服务;校验进程存活与端口空闲,探测必须命中本进程(修复评审 2.3-3)"""
    assert port_free(PORT), f"port {PORT} busy — 疑似残留实例,先清理再跑"
    env = dict(os.environ, MMB_DATA_DIR=data_dir, PORT=PORT, MMB_DEMO="1", MMB_ADMIN_PASSWORD=ADMIN_PASS)
    os.makedirs(data_dir, exist_ok=True)
    logf = open(os.path.join(data_dir, "server.log"), "w", encoding="utf-8")
    p = subprocess.Popen(["node", SRV], env=env, stdout=logf, stderr=subprocess.STDOUT)
    for _ in range(30):
        time.sleep(1)
        if p.poll() is not None:
            raise RuntimeError(f"server exited during startup (code {p.returncode})")
        try:
            req("/api/auth/status"); return p
        except Exception: pass
    p.kill()
    raise RuntimeError("server not up")

shutil.rmtree(TEST, ignore_errors=True)
if os.path.exists(SECRET):
    os.rename(SECRET, SECRET_BAK)   # 隔离:隐藏真实密钥;MMB_DEMO=1 走 mock

def make_task(day, seq, stage="done", steps=None):
    return {"id": f"MT-{day}-{seq:03d}", "title": f"t{seq}", "fileName": f"f{seq}.wav", "sizeBytes": 1,
            "stage": stage, "steps": steps or [], "transcriptChars": 1, "minutesFile": "", "error": "",
            "createdAt": "2026-09-21T00:00:00Z", "updatedAt": "2026-09-21T00:00:00Z"}

RUNNING_STEPS = [
    {"key": "import", "label": "导入文件", "status": "done", "startedAt": "x", "finishedAt": "x", "note": ""},
    {"key": "extract", "label": "抽取音轨", "status": "done", "startedAt": "x", "finishedAt": "x", "note": ""},
    {"key": "transcribe", "label": "语音转写", "status": "running", "startedAt": "x", "finishedAt": None, "note": ""},
    {"key": "analyze", "label": "AI 分析", "status": "pending", "startedAt": None, "finishedAt": None, "note": ""},
    {"key": "render", "label": "生成纪要", "status": "pending", "startedAt": None, "finishedAt": None, "note": ""},
]

def wait_stage(tid, stage, timeout=90, cookie=None):
    for _ in range(timeout):
        time.sleep(1)
        c, t, _ = req(f"/api/tasks/{tid}", cookie=cookie)
        if t.get("stage") in ("done", "failed"): return t.get("stage") == stage
    return False

result, failures = {}, []
def check(name, cond):
    result.setdefault("asserts", {})[name] = bool(cond)
    if not cond: failures.append(name)

DATA_DIR = os.path.join(TEST, "verify")
day = time.strftime("%Y%m%d")

# ── R03 前置:匿名与 CSRF ──
srv = start_server(DATA_DIR)
try:
    c, _, _ = req("/api/tasks")
    check("R03_anon_tasks_401", c == 401)
    c, j, h = req("/api/auth/login", "POST", {"username": ADMIN_USER, "password": ADMIN_PASS})
    cookie = (h.get("Set-Cookie") or "").split(";")[0]
    print("DEBUG login:", c, j, "| setcookie:", (h.get("Set-Cookie") or "NONE")[:60])
    check("R03_login_ok", c == 200)
    c, _, _ = req("/api/auth/login", "POST", {"username": ADMIN_USER, "password": "wrong"})
    check("R03_wrong_pass_401", c == 401)

    # ── R01 ──
    print("DEBUG cookie:", cookie[:50])
    st, j2, _ = req("/api/auth/status", cookie=cookie)
    print("DEBUG status:", st, j2)
    c, t1 = upload("same-name.wav", make_wav(), cookie)
    print("DEBUG upload1:", c, json.dumps(t1, ensure_ascii=False)[:160])
    assert c == 201 and "id" in t1, f"task1 upload failed: {t1}"
    assert wait_stage(t1["id"], "done", cookie=cookie), f"task1 not done: {t1}"
    c, t2 = upload("same-name.wav", make_wav(), cookie)
    assert wait_stage(t2["id"], "done", cookie=cookie), f"task2 {t2}"
    f1 = os.path.join(DATA_DIR, "uploads", t1["fileName"])
    f2 = os.path.join(DATA_DIR, "uploads", t2["fileName"])
    check("R01_storageKeysDiffer", t1["fileName"] != t2["fileName"])
    check("R01_originalNamesSame", t1.get("originalFileName") == t2.get("originalFileName") == "same-name.wav")
    check("R01_bothFilesExist", os.path.exists(f1) and os.path.exists(f2))
    c, _, _h = req(f"/api/tasks/{t1['id']}", method="DELETE", cookie=cookie)
    check("R01_deleteOk", c == 200)
    check("R01_task2Survives", os.path.exists(f2) and os.path.getsize(f2) > 0)
    c, t2b, _ = req(f"/api/tasks/{t2['id']}", cookie=cookie)
    check("R01_task2Rerun", t2b.get("stage") == "done")

    # ── R07(运行中互斥,真实时序) ──
    c, _, _h = req(f"/api/tasks/{t2['id']}/restart", method="POST", body={"scope": "all"}, cookie=cookie)
    c2, _, _ = req(f"/api/tasks/{t2['id']}/restart", method="POST", body={"scope": "all"}, cookie=cookie)
    c3, _, _ = req(f"/api/tasks/{t2['id']}", method="DELETE", cookie=cookie)
    check("R07_secondRestart_409", c2 == 409)
    check("R07_deleteWhileRunning_409", c3 == 409)
    # R03 CSRF:无 X-Requested-With → 403
    c4, _, _ = req(f"/api/tasks/{t2['id']}/restart", method="POST", body={"scope": "all"}, cookie=cookie, csrf=False)
    check("R03_csrf_403", c4 == 403)
    wait_stage(t2["id"], "done", cookie=cookie)
finally:
    srv.terminate(); srv.wait(timeout=10)
    if os.path.exists(SECRET_BAK) and not os.path.exists(SECRET):
        os.rename(SECRET_BAK, SECRET)

# ── R02:编号唯一性 ──
if os.path.exists(SECRET):
    os.rename(SECRET, SECRET_BAK)
DATA2 = os.path.join(TEST, "verify2")
os.makedirs(os.path.join(DATA2, "uploads"), exist_ok=True)
os.makedirs(os.path.join(DATA2, "outputs", f"MT-{day}-005"), exist_ok=True)
json.dump([{"id": f"MT-{day}-{i:03d}", "title": f"t{i}", "fileName": f"f{i}.wav", "sizeBytes": 1,
            "stage": "done", "steps": [], "transcriptChars": 1, "minutesFile": "", "error": "",
            "createdAt": "x", "updatedAt": "x"} for i in (1, 2, 3)],
           open(os.path.join(DATA2, "tasks.json"), "w", encoding="utf-8"))
srv = start_server(DATA2)
try:
    cookie = login()
    c, _, _h = req(f"/api/tasks/MT-{day}-002", method="DELETE", cookie=cookie)
    c, t_new = upload("new.wav", make_wav(), cookie)
    # 口径(与实现一致):回收制——已彻底删除的 002 可回收;现存 003 与残留 005 绝不复用
    check("R02_notCollideLive003", t_new["id"] != f"MT-{day}-003")
    check("R02_avoidsResidual005", t_new["id"] != f"MT-{day}-005")
    check("R02_noSharedOutputsDir", not os.path.exists(os.path.join(DATA2, "outputs", t_new["id"], "stale-probe")))
    req(f"/api/tasks/{t_new['id']}", method="DELETE", cookie=cookie)
    c, t_new2 = upload("new2.wav", make_wav(), cookie)
    check("R02_uniqueAcrossCreates", t_new2["id"] != t_new["id"] and t_new2["id"] != f"MT-{day}-005")
    # 历史兼容
    json.dump([make_task(day, 9, stage="done")], open(os.path.join(DATA2, "tasks.json"), "w", encoding="utf-8"))
finally:
    srv.terminate(); srv.wait(timeout=10)
    if os.path.exists(SECRET_BAK) and not os.path.exists(SECRET):
        os.rename(SECRET_BAK, SECRET)

# ── 历史兼容 ──
if os.path.exists(SECRET):
    os.rename(SECRET, SECRET_BAK)   # 第三段同样隔离真实密钥(MMB_DEMO=1 下 demo 优先,理论不外呼;双保险)
DATA3 = os.path.join(TEST, "verify3")
os.makedirs(os.path.join(DATA3, "uploads"), exist_ok=True)
json.dump([make_task(day, 1, stage="done")], open(os.path.join(DATA3, "tasks.json"), "w", encoding="utf-8"))
open(os.path.join(DATA3, "uploads", "f1.wav"), "wb").write(make_wav())
srv = start_server(DATA3)
try:
    cookie = login()
    c, _, _ = req(f"/api/tasks/MT-{day}-001", cookie=cookie)
    check("LEGACY_detail", c == 200)
    c, _, _h = req(f"/api/tasks/MT-{day}-001/restart", method="POST", body={"scope": "all"}, cookie=cookie)
    check("LEGACY_fullRerun", c == 200 and wait_stage(f"MT-{day}-001", "done", cookie=cookie))
    c, _, _ = req(f"/api/tasks/MT-{day}-001", method="DELETE", cookie=cookie)
    check("LEGACY_delete", c == 200)
finally:
    srv.terminate(); srv.wait(timeout=10)
    if os.path.exists(SECRET_BAK) and not os.path.exists(SECRET):
        os.rename(SECRET_BAK, SECRET)

shutil.rmtree(TEST, ignore_errors=True)
result["FAILED"] = failures
print(json.dumps(result, ensure_ascii=False, indent=2))
sys.exit(1 if failures else 0)
