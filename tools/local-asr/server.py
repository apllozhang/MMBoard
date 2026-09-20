"""本地离线转写服务 —— MMBoard 本地通道(FunASR CPU,Paraformer + VAD + 标点 + CAM++ 说话人分离)

接口(MMBoard 后端调用):
  POST /tasks        上传音频(multipart 字段 file)→ {id}(异步转写,内部排队,一次跑一个)
  GET  /tasks/{id}   {status: running|done|failed, result?: {text, segments, hasSpeakers}, error?, elapsedSec?}
  GET  /health       {ok, model, queued}

结果结构与 MMBoard iflytek.cjs 对齐:
  text      合并同说话人连续句 "[MM:SS] 说话人N: 内容"
  segments  [{start(ms), end(ms), text, speaker(数字字符串)}]
  hasSpeakers  转写句带说话人标签即为 true
"""
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

app = FastAPI(title="local-asr")
TASKS = {}                 # id -> {status, result?, error?, elapsedSec?}
Q: "queue.Queue" = queue.Queue()

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


def worker():
    while True:
        tid, wav_path = Q.get()
        try:
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
                    TASKS[tid] = {"status": "failed", "error": "转写结果为空", "elapsedSec": elapsed}
                    continue
                TASKS[tid] = {"status": "done", "elapsedSec": elapsed,
                              "result": {"text": full, "segments": [], "hasSpeakers": False}}
                continue

            speakers = {x["speaker"] for x in segs}
            TASKS[tid] = {"status": "done", "elapsedSec": elapsed,
                          "result": {"text": merge_text(segs), "segments": segs,
                                     "hasSpeakers": speakers != {"?"}}}
            print(f"[asr] {tid} done: {len(segs)} segs, {len(speakers)} speakers, {elapsed}s", flush=True)
        except Exception as e:
            TASKS[tid] = {"status": "failed", "error": str(e)[:300]}
            print(f"[asr] {tid} FAILED: {e}", flush=True)
        finally:
            import glob
            for p in glob.glob(os.path.join(TMP, f"{tid}_orig.*")) + [wav_path]:
                try:
                    os.remove(p)
                except OSError:
                    pass


threading.Thread(target=load_model, daemon=True).start()
threading.Thread(target=worker, daemon=True).start()


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
    with open(src, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            f.write(chunk)
    try:
        wav = to_wav16k(src, tid)
    except Exception as e:
        try:
            os.remove(src)
        except OSError:
            pass
        raise HTTPException(400, str(e)) from e
    TASKS[tid] = {"status": "running"}
    Q.put((tid, wav))
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
