"""本地离线转写服务 —— MMBoard 本地通道(FunASR CPU,Paraformer + VAD + 标点 + CAM++ 说话人分离)

接口(MMBoard 后端调用):
  POST /tasks        上传音频(multipart 字段 file)→ {id}(异步转写,内部排队,一次跑一个)
  GET  /tasks/{id}   {status: queued|running|done|failed, result?: {text, segments, hasSpeakers}, error?, elapsedSec?}
  GET  /health       {ok, model, queued}

结果结构与 MMBoard iflytek.cjs 对齐:
  text      合并同说话人连续句 "[MM:SS] 说话人N: 内容"
  segments  [{start(ms), end(ms), text, speaker(数字字符串)}]
  hasSpeakers  转写句带说话人标签即为 true

R19 整改:
  · 转码(ffmpeg)与识别全部在单个 worker 线程内执行,async 路径只做流式落盘与入队,不阻塞事件循环
  · 队列有界(QUEUE_CAPACITY),满时返回 503
  · queued 与 running 状态分离,轮询方可区分"在排队"与"在识别"
  · 任务结果按 TTL 过期清理,残留临时文件一并巡检删除
"""
import glob
import os
import queue
import subprocess
import threading
import time
import uuid

os.environ.setdefault("MODELSCOPE_CACHE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"))

from fastapi import FastAPI, File, HTTPException, UploadFile
import uvicorn

APP_DIR = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(APP_DIR, "tmp")
MODELS = os.path.join(APP_DIR, "models")
os.makedirs(TMP, exist_ok=True)
os.makedirs(MODELS, exist_ok=True)

FFMPEG = r"D:\Tools\ffmpeg\bin\ffmpeg.exe"
if not os.path.exists(FFMPEG):
    FFMPEG = "ffmpeg"   # 回退 PATH

HOST = "0.0.0.0"
PORT = 8300

QUEUE_CAPACITY = int(os.environ.get("ASR_QUEUE_CAPACITY", 8))     # R19:排队上限,满则 503
MAX_UPLOAD_BYTES = int(os.environ.get("ASR_MAX_UPLOAD_BYTES", 2 * 1024**3))   # 与主服务 2GB 上限对齐
TASK_TTL_SEC = float(os.environ.get("ASR_TASK_TTL_SEC", 2 * 3600))            # R19:done/failed 结果保留时长(可注入便于测试)
TTL_SWEEP_SEC = float(os.environ.get("ASR_TTL_SWEEP_SEC", 600))               # 过期清理扫描周期(可注入便于测试)

app = FastAPI(title="local-asr")
TASKS = {}                 # id -> {status, result?, error?, elapsedSec?, finishedAt?}
Q: "queue.Queue" = queue.Queue(maxsize=QUEUE_CAPACITY)

_model = None
_model_status = "loading"  # loading | loaded | failed


def fmt_ms(ms: int) -> str:
    s = int(ms // 1000)
    return f"{s // 60:02d}:{s % 60:02d}"


def merge_text(segs: list) -> str:
    """合并同说话人连续句,行首时间戳取该段第一句(与讯飞通道格式一致)"""
    lines, cur_spk, buf = [], None, []
    for seg in segs:
        if seg["speaker"] != cur_spk and buf:
            lines.append(f"[{fmt_ms(buf[0][1])}] 说话人{cur_spk}: " + "".join(b[0] for b in buf))
            buf = []
        cur_spk = seg["speaker"]
        buf.append((seg["text"], seg["start"]))
    if buf:
        lines.append(f"[{fmt_ms(buf[0][1])}] 说话人{cur_spk}: " + "".join(b[0] for b in buf))
    return "\n".join(lines)


def load_model():
    global _model, _model_status
    from funasr import AutoModel
    t0 = time.time()
    try:
        _model = AutoModel(
            model="paraformer-zh",
            vad_model="fsmn-vad",
            punc_model="ct-punc",
            spk_model="cam++",
            disable_update=True,
            disable_pbar=True,
        )
        _model_status = "loaded"
        print(f"[asr] model loaded in {time.time() - t0:.0f}s", flush=True)
    except Exception as e:
        _model_status = "failed"
        print(f"[asr] model load FAILED: {e}", flush=True)


def to_wav16k(src: str, tid: str) -> str:
    """统一转 16k 单声道 wav(模型友好;mp3 在 Windows 上 torchaudio 可能解不了)"""
    dst = os.path.join(TMP, f"{tid}.wav")
    r = subprocess.run([FFMPEG, "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", dst],
                       capture_output=True, timeout=30 * 60)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg 转码失败: " + r.stderr.decode("utf-8", "replace")[-200:])
    return dst


def _cleanup_files(tid: str, wav_path: str | None):
    for p in glob.glob(os.path.join(TMP, f"{tid}_orig.*")) + ([wav_path] if wav_path else []):
        try:
            os.remove(p)
        except OSError:
            pass


def worker():
    while True:
        tid, src = Q.get()
        wav_path = None
        try:
            TASKS[tid] = {"status": "running"}
            wav_path = to_wav16k(src, tid)      # R19:转码在 worker 线程内,不阻塞事件循环
            t0 = time.time()
            res = _model.generate(input=wav_path, batch_size_s=300)
            elapsed = round(time.time() - t0, 1)

            sentences = (res[0].get("sentence_info") or []) if res else []
            segs = []
            for s in sentences:
                spk = str(s.get("spk", s.get("speaker", ""))).replace("spk", "").strip() or "?"
                text = str(s.get("text", "")).strip()
                if not text:
                    continue
                segs.append({"start": int(s.get("start", 0)), "end": int(s.get("end", 0)),
                             "text": text, "speaker": spk})

            if not segs:
                full = str((res[0] or {}).get("text", "")).strip()
                if not full:
                    TASKS[tid] = {"status": "failed", "error": "转写结果为空", "elapsedSec": elapsed,
                                  "finishedAt": time.time()}
                    continue
                TASKS[tid] = {"status": "done", "elapsedSec": elapsed, "finishedAt": time.time(),
                              "result": {"text": full, "segments": [], "hasSpeakers": False}}
                continue

            speakers = {x["speaker"] for x in segs}
            TASKS[tid] = {"status": "done", "elapsedSec": elapsed, "finishedAt": time.time(),
                          "result": {"text": merge_text(segs), "segments": segs,
                                     "hasSpeakers": speakers != {"?"}}}
            print(f"[asr] {tid} done: {len(segs)} segs, {len(speakers)} speakers, {elapsed}s", flush=True)
        except Exception as e:
            TASKS[tid] = {"status": "failed", "error": str(e)[:300], "finishedAt": time.time()}
            print(f"[asr] {tid} FAILED: {e}", flush=True)
        finally:
            _cleanup_files(tid, wav_path)


def ttl_sweeper():
    """R19:周期清理过期结果与孤儿临时文件(TMP 内超过 TTL 未 touch 的文件兜底删除)"""
    while True:
        time.sleep(TTL_SWEEP_SEC)
        now = time.time()
        for tid in [k for k, v in TASKS.items()
                    if v.get("finishedAt") and now - v["finishedAt"] > TASK_TTL_SEC]:
            _cleanup_files(tid, os.path.join(TMP, f"{tid}.wav"))
            TASKS.pop(tid, None)
        try:
            for p in glob.glob(os.path.join(TMP, "*")):
                if now - os.path.getmtime(p) > TASK_TTL_SEC:
                    try:
                        os.remove(p)
                    except OSError:
                        pass
        except OSError:
            pass


threading.Thread(target=load_model, daemon=True).start()
threading.Thread(target=worker, daemon=True).start()
threading.Thread(target=ttl_sweeper, daemon=True).start()


@app.get("/health")
def health():
    return {"ok": _model_status == "loaded", "model": _model_status, "queued": Q.qsize()}


@app.post("/tasks")
async def submit(file: UploadFile = File(...)):
    if _model_status != "loaded":
        raise HTTPException(503, f"model not ready: {_model_status}")
    tid = f"LA-{time.strftime('%Y%m%d')}-{uuid.uuid4().hex[:8]}"
    ext = os.path.splitext(file.filename or "a.wav")[1].lower() or ".wav"
    src = os.path.join(TMP, f"{tid}_orig{ext}")
    size = 0
    try:
        with open(src, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:   # R19:超限即断,不在磁盘上留完整超限文件
                    raise HTTPException(413, "文件超过 2GB 上限")
                f.write(chunk)
    except HTTPException:
        _cleanup_files(tid, None)
        raise
    except Exception:
        _cleanup_files(tid, None)
        raise
    try:
        Q.put_nowait((tid, src))              # R19:有界队列,满即 503(文件不入队不占位)
    except queue.Full:
        _cleanup_files(tid, None)
        raise HTTPException(503, f"任务队列已满({QUEUE_CAPACITY}),请稍后再试") from None
    TASKS[tid] = {"status": "queued"}         # R19:排队与运行状态分离
    return {"id": tid, "queued": Q.qsize()}


@app.get("/tasks/{tid}")
def status(tid: str):
    t = TASKS.get(tid)
    if not t:
        raise HTTPException(404, "task not found")
    return t


if __name__ == "__main__":
    print(f"[asr] serving on http://{HOST}:{PORT} (models dir: {MODELS})", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
