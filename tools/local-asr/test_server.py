# -*- coding: utf-8 -*-
"""local-asr server.py 运行期行为测试(二轮复审 R19:不再只做源码字符串断言)。

方式:向 sys.modules 注入 funasr stub(免真实模型与 2.5GB 权重),server.py 代码路径
(上传/排队/worker 转码/状态机/TTL/限流)全部真实执行;HTTP 层用 fastapi TestClient。
运行:python tools/local-asr/test_server.py   (需 pip install fastapi uvicorn httpx)
"""
import io
import os
import sys
import time
import types
import wave
import struct
import math
import threading

# ── funasr stub:generate 固定返回双说话人句段;延迟/失败可由 stub 状态控制 ──
stub_state = {"delay": 0.0, "fail": False, "loaded": True, "calls": 0}


class _StubAutoModel:
    def __init__(self, *a, **k):
        pass

    def generate(self, input=None, batch_size_s=300):
        stub_state["calls"] += 1
        if stub_state["delay"]:
            time.sleep(stub_state["delay"])
        if stub_state["fail"]:
            raise RuntimeError("stub transcribe failure")
        return [{
            "sentence_info": [
                {"start": 0, "end": 2000, "text": "大家好,开始开会。", "spk": "spk0"},
                {"start": 2000, "end": 4000, "text": "好的,议题第一项。", "spk": "spk1"},
            ],
            "text": "大家好,开始开会。好的,议题第一项。",
        }]


funasr_stub = types.ModuleType("funasr")
funasr_stub.AutoModel = _StubAutoModel
sys.modules.setdefault("funasr", funasr_stub)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["ASR_TASK_TTL_SEC"] = "2"          # 短 TTL 便于验证过期清理
os.environ["ASR_TTL_SWEEP_SEC"] = "0.5"       # 扫描周期同步缩短
os.environ["ASR_QUEUE_CAPACITY"] = "3"

import server as asr_server                    # noqa: E402
from fastapi.testclient import TestClient      # noqa: E402

PASS, FAIL = 0, 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def make_wav(seconds=1):
    n = 16000 * seconds
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(i * 0.05))) for i in range(n)))
    w.close()
    return buf.getvalue()


client = TestClient(asr_server.app)

# ── 健康检查(运行期形状) ──
r = client.get("/health")
j0 = r.json()
check("health 返回 ok/model/queued 形状", r.status_code == 200 and isinstance(j0.get("ok"), bool)
      and isinstance(j0.get("queued"), int) and isinstance(j0.get("model"), str), r.text[:120])
time.sleep(0.3)   # 等 stub load 线程完成
r = client.get("/health")
check("模型加载完成后 ok=true", r.json().get("ok") is True, r.text[:120])

# ── 提交 → queued → running → done 全状态机 ──
stub_state["delay"] = 1.0
r = client.post("/tasks", files={"file": ("a.wav", make_wav(1), "audio/wav")})
check("提交返回 id", r.status_code == 200 and "id" in r.json(), r.text[:120])
tid = r.json()["id"]
r = client.get(f"/tasks/{tid}")
check("提交后即有状态条目(queued/running)", r.json().get("status") in ("queued", "running"), r.text[:120])
deadline = time.time() + 15
final = None
while time.time() < deadline:
    j = client.get(f"/tasks/{tid}").json()
    if j.get("status") in ("done", "failed"):
        final = j
        break
    time.sleep(0.2)
check("异步转写完成 done", final and final["status"] == "done", str(final)[:150])
check("结果文本/说话人分段正确", final and "说话人0" in final["result"]["text"]
      and "大家好" in final["result"]["text"] and final["result"]["hasSpeakers"] is True)
time.sleep(2.8)   # TTL=2s,扫描周期 0.5s → 过期条目被清理
check("TTL 过期后 404", client.get(f"/tasks/{tid}").status_code == 404)

# ── 模型未就绪 503 ──
asr_server._model_status = "loading"
r = client.post("/tasks", files={"file": ("b.wav", make_wav(1), "audio/wav")})
check("模型未就绪提交 → 503", r.status_code == 503, r.text[:120])
asr_server._model_status = "loaded"

# ── 队列容量 3:并发提交 8 个(worker 消费中),溢出请求必须 503 ──
stub_state["delay"] = 2.0
codes = []
def _submit(i):
    rr = client.post("/tasks", files={"file": (f"c{i}.wav", make_wav(1), "audio/wav")})
    codes.append(rr.status_code)
threads = [threading.Thread(target=_submit, args=(i,)) for i in range(8)]
for th in threads: th.start()
for th in threads: th.join()
check("队列容量内提交成功、溢出 503", codes.count(200) >= 2 and codes.count(503) >= 1, str(codes))
# 等队列排空
deadline = time.time() + 25
while time.time() < deadline and asr_server.Q.qsize() > 0:
    time.sleep(0.3)
time.sleep(2)

# ── worker 内转码失败 → failed 状态(坏音频) ──
stub_state["delay"] = 0.0
r = client.post("/tasks", files={"file": ("bad.wav", b"not-a-wav-at-all", "audio/wav")})
check("坏音频提交被接受(转码在 worker 内)", r.status_code == 200, r.text[:120])
bad_id = r.json()["id"]
deadline = time.time() + 10
bad = None
while time.time() < deadline:
    bad = client.get(f"/tasks/{bad_id}").json()
    if bad.get("status") in ("done", "failed"):
        break
    time.sleep(0.2)
check("坏音频最终 failed 且带错误信息", bad and bad["status"] == "failed" and bad.get("error"), str(bad)[:120])

print(f"\n===== local-asr 运行期测试:{PASS} 通过,{FAIL} 失败 =====")
sys.exit(1 if FAIL else 0)
