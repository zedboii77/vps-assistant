#!/usr/bin/env python3
"""
VPS Assistant — a small dedicated chat agent web UI for VPS management,
powered by any OpenRouter chat model (default: stealth/ox-alpha).

Pure Python stdlib. Run:  python3 server.py

Environment:
  VPSA_PORT          HTTP port              (default 8095)
  VPSA_HOST          bind address           (default 127.0.0.1)
  VPSA_DATA_DIR      state directory        (default <script_dir>/data)
  VPSA_MODEL         OpenRouter model slug  (default stealth/ox-alpha)
  OPENROUTER_API_KEY optional pre-set key   (otherwise entered in Settings UI)

Architecture notes:
  - Chats persist server-side as JSON files under DATA_DIR/chats/.
  - Agent turns run as detached background tasks: if the browser disconnects,
    the task keeps running and its events can be replayed/re-attached via
    GET /chat/stream?task=<id>&from=<n>.
  - Stop is cooperative: it takes effect between agent steps (a shell command
    already running is allowed to finish, bounded by its own timeout).
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("VPSA_PORT", "8095"))
HOST = os.environ.get("VPSA_HOST", "127.0.0.1")
DATA_DIR = os.environ.get("VPSA_DATA_DIR", os.path.join(SCRIPT_DIR, "data"))
MODEL = os.environ.get("VPSA_MODEL", "stealth/ox-alpha")
REASONING_EFFORT = os.environ.get("VPSA_REASONING", "high")
OR_API_URL = "https://openrouter.ai/api/v1/chat/completions"

MAX_STEPS = 12                 # agent tool-loop iterations per user turn
MAX_TOOL_OUTPUT = 8000         # chars of tool output fed back to the model
MAX_HISTORY = 60               # messages sent to the model per request
COOKIE_NAME = "vpsa_sess"
SESSION_TTL = 14 * 24 * 3600   # seconds

os.makedirs(DATA_DIR, exist_ok=True)
AUTH_FILE = os.path.join(DATA_DIR, "auth.json")
KEY_FILE = os.path.join(DATA_DIR, "openrouter_key")
SECRET_FILE = os.path.join(DATA_DIR, "session_secret")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
CHATS_DIR = os.path.join(DATA_DIR, "chats")
SOUL_FILE = os.path.join(SCRIPT_DIR, "SOUL.md")
os.makedirs(CHATS_DIR, exist_ok=True)

for _p in (AUTH_FILE, KEY_FILE, SECRET_FILE, SETTINGS_FILE):
    if not os.path.exists(_p):
        with open(_p, "w") as f:
            pass
    os.chmod(_p, 0o600)


def _session_secret() -> bytes:
    with open(SECRET_FILE, "r+") as f:
        s = f.read().strip()
        if not s:
            s = secrets.token_hex(32)
            f.write(s)
    return s.encode()


SESSION_SECRET = _session_secret()

# ---------------------------------------------------------------- helpers

def hash_password(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode()).hexdigest()


def load_auth() -> dict | None:
    try:
        with open(AUTH_FILE) as f:
            d = json.load(f)
        return d if d.get("hash") else None
    except Exception:
        return None


def save_auth(password: str) -> None:
    salt = secrets.token_hex(16)
    with open(AUTH_FILE, "w") as f:
        json.dump({"salt": salt, "hash": hash_password(password, salt)}, f)


def make_token() -> str:
    exp = str(int(time.time()) + SESSION_TTL)
    sig = hmac.new(SESSION_SECRET, exp.encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def check_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    want = hmac.new(SESSION_SECRET, exp.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, want):
        return False
    return int(exp) > time.time()


def get_api_key() -> str | None:
    env = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if env:
        return env
    try:
        with open(KEY_FILE) as f:
            k = f.read().strip()
            return k or None
    except Exception:
        return None


def mask_key(k: str) -> str:
    return f"{k[:11]}...{k[-4:]}" if len(k) > 20 else "***"


VALID_EFFORTS = ("low", "medium", "high", "auto")

_HIGH_HINT = re.compile(
    r"\b(why|debug|troubleshoot|investigate|diagnos\w*|broken|not working|"
    r"doesn.?t work|won.?t (start|run|work)|failing|failure|errors?|crash\w*|"
    r"weird|strange|unexpectedly|slow|hung|stuck|refused|timeout|out of|"
    r"analyze|root cause|security|breach|audit|migrat\w*|optimize|"
    r"performance|benchmark|compare)\b", re.I)
_LOW_HINT = re.compile(
    r"^\s*(hi+|hello+|hey+|yo|sup|test|ping|thanks|thank you|thx|ty|ok|okay|"
    r"cool|nice|great|perfect|bye|good (morning|afternoon|evening|night)|"
    r"who are you|what can you do)[\s!.?]*$", re.I)


def classify_effort(text: str) -> str:
    """Heuristic per-message reasoning-effort picker used when set to 'auto'."""
    t = (text or "").strip()
    if not t:
        return "medium"
    if len(t) <= 30 and _LOW_HINT.match(t):
        return "low"
    score = 0
    if _HIGH_HINT.search(t):
        score += 2
    if len(t) > 280:
        score += 2
    elif len(t) > 120:
        score += 1
    if t.count("?") >= 2:
        score += 1
    list_lines = sum(1 for ln in t.splitlines()
                     if re.match(r"\s*(\d+[.)]|[-*•])\s+", ln))
    if list_lines >= 2:
        score += 2
    if score >= 2:
        return "high"
    if score == 0:
        return "low" if len(t) < 45 else "medium"
    return "medium"


def load_settings() -> dict:
    try:
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_settings(d: dict) -> None:
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.replace(tmp, SETTINGS_FILE)
    os.chmod(SETTINGS_FILE, 0o600)


def get_reasoning() -> str:
    lvl = load_settings().get("reasoning_effort")
    return lvl if lvl in VALID_EFFORTS else REASONING_EFFORT


def get_soul() -> str:
    """Personality overlay from SOUL.md (capped at 4 KB). Empty if absent."""
    try:
        with open(SOUL_FILE) as f:
            return f.read(4096).strip()
    except Exception:
        return ""


_login_fails: dict[str, list[float]] = {}
_lock = threading.Lock()


def login_allowed(ip: str) -> bool:
    now = time.time()
    with _lock:
        tries = [t for t in _login_fails.get(ip, []) if now - t < 600]
        _login_fails[ip] = tries
        return len(tries) < 10


def record_fail(ip: str) -> None:
    with _lock:
        _login_fails.setdefault(ip, []).append(time.time())


def system_context() -> str:
    """Live host facts injected into the system prompt each turn."""

    def run(cmd, timeout=6):
        try:
            return subprocess.run(cmd, shell=True, capture_output=True,
                                  text=True, timeout=timeout).stdout.strip()
        except Exception as e:
            return f"(unavailable: {e})"

    host = socket.gethostname()
    kernel = run("uname -r")
    uptime = run("uptime -p")
    distro = run(". /etc/os-release && echo $PRETTY_NAME")
    cpu = run("nproc")
    mem = run("free -m | awk '/^Mem:/{print $3\"/\"$2\" MB used\"}'")
    disk = run("df -h / | awk 'NR==2{print $3\"/\"$2\" used (\"$5\")\"}'")
    loadavg = run("cat /proc/loadavg | cut -d' ' -f1-3")
    try:
        ip = json.load(urllib.request.urlopen(
            "https://api.ipify.org?format=json", timeout=4))["ip"]
    except Exception:
        ip = "(unknown)"
    return (
        f"Host: {host}\nDistro: {distro}\nKernel: {kernel}\n"
        f"CPU cores: {cpu}\nMemory: {mem}\nDisk /: {disk}\n"
        f"Load: {loadavg}\nUptime: {uptime}\nPublic IP: {ip}"
    )


SYSTEM_PROMPT = """You are VPS Assistant, a concise Linux sysadmin copilot embedded \
in a web UI on the VPS you manage. You have direct tool access to the machine.

{soul_block}

Machine facts (live):
{ctx}

Rules:
- Use the `shell` tool for anything about running services, logs, network, files, \
packages, cron, etc. Do not guess when you can check.
- Prefer systemctl / journalctl / ss / df / free. Keep commands targeted; avoid \
needlessly heavy ones (no unbounded recursive greps of huge trees).
- DESTRUCTIVE actions (rm -rf outside /tmp, dropping databases, firewall flushes, \
service disables, package removals, editing configs) require explicit user \
confirmation first: say what you plan to run and wait for approval.
- read_file/write_file are for inspecting and patching config/text files. \
write_file overwrites whole files — prefer small, precise writes.
- Answer in the user's language. Be brief and factual; show the key command output, \
not everything. When a fix needs several steps, do them yourself with tools instead \
of telling the user to run them — that is your job here.
- Assume the user is NOT a Linux expert. Explain findings in plain language: what \
the numbers mean, whether it looks healthy, and what you recommend next. Avoid \
jargon where possible; when a command matters, say in one short line what it does.
- If a tool errors, adapt rather than repeating it unchanged."""

TOOLS_SCHEMA = [
    {"type": "function", "function": {
        "name": "shell",
        "description": "Run a bash command on the VPS and return stdout/stderr "
                       "and exit code. Working directory: /root.",
        "parameters": {"type": "object", "properties": {
            "cmd": {"type": "string"},
            "timeout": {"type": "integer",
                        "description": "seconds, default 30, max 180"}},
            "required": ["cmd"]}}},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Read a text file (up to ~200 KB).",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}},
            "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "write_file",
        "description": "Create/overwrite a text file (parents auto-created). "
                       "Full overwrite — include the complete desired content.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"]}}},
]


def execute_tool(name: str, args: dict) -> dict:
    if name == "shell":
        cmd = str(args.get("cmd", ""))[:20000]
        try:
            tmo = min(max(int(args.get("timeout", 30)), 1), 180)
        except Exception:
            tmo = 30
        try:
            p = subprocess.run(cmd, shell=True, executable="/bin/bash",
                               capture_output=True, text=True, timeout=tmo,
                               cwd="/root")
            out = {"ok": p.returncode == 0, "exit_code": p.returncode,
                   "stdout": p.stdout[:MAX_TOOL_OUTPUT],
                   "stderr": p.stderr[:MAX_TOOL_OUTPUT // 2]}
            if len(p.stdout) > MAX_TOOL_OUTPUT:
                out["stdout_truncated"] = True
            return out
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"timeout after {tmo}s"}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if name == "read_file":
        path = str(args.get("path", ""))
        try:
            with open(path, "r", errors="replace") as f:
                data = f.read(200_000)
            truncated = len(data) == 200_000
            return {"ok": True, "path": path,
                    "content": data, "truncated": truncated}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if name == "write_file":
        path = str(args.get("path", ""))
        content = str(args.get("content", ""))
        if not path or path.endswith("/"):
            return {"ok": False, "error": "invalid path"}
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            if os.path.isdir(path):
                return {"ok": False, "error": "path is a directory"}
            tmp = path + ".vpsa.tmp"
            with open(tmp, "w") as f:
                f.write(content)
            shutil.move(tmp, path)
            return {"ok": True, "bytes_written": len(content.encode())}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": False, "error": f"unknown tool {name}"}


def call_openrouter_stream(convo: list, api_key: str, effort: str):
    """Yield parsed chunks from a streaming completion. Raises on HTTP errors."""
    payload = {"model": MODEL, "messages": convo, "stream": True,
               "max_tokens": 16384, "tools": TOOLS_SCHEMA,
               "reasoning": {"effort": effort}}
    req = urllib.request.Request(
        OR_API_URL, data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=600)
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue  # skip ": OPENROUTER PROCESSING" keep-alives etc.
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        if "error" in chunk:
            raise RuntimeError(chunk["error"].get("message", "stream error"))
        yield chunk


def run_agent(messages: list, api_key: str, should_cancel=None, effort: str = "medium"):
    """Full tool-loop. Yields UI events; final text arrives as delta events.
    `should_cancel` is polled between steps; when true, yields 'cancelled'."""
    convo = [{"role": "system",
              "content": SYSTEM_PROMPT.format(
                  ctx=system_context(),
                  soul_block=("Personality & style:\n" + get_soul())
                  if get_soul() else "")}]
    convo += messages[-MAX_HISTORY:]
    for _step in range(MAX_STEPS):
        if should_cancel and should_cancel():
            yield {"type": "cancelled"}
            return
        yield {"type": "status", "stage": "thinking"}
        parts, calls, finish = [], {}, None
        try:
            for chunk in call_openrouter_stream(convo, api_key, effort):
                chs = chunk.get("choices") or []
                if not chs:
                    continue
                d = chs[0].get("delta") or {}
                if d.get("content"):
                    parts.append(d["content"])
                    yield {"type": "delta", "text": d["content"]}
                for tc in d.get("tool_calls") or []:
                    i = tc.get("index", 0)
                    slot = calls.setdefault(i, {"id": "", "name": "", "args": ""})
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["name"] += fn["name"]
                    if fn.get("arguments"):
                        slot["args"] += fn["arguments"]
                if chs[0].get("finish_reason"):
                    finish = chs[0]["finish_reason"]
        except urllib.error.HTTPError as e:
            detail = e.read()[:400].decode(errors="replace")
            yield {"type": "error",
                   "message": f"OpenRouter HTTP {e.code}: {detail}"}
            return
        except Exception as e:
            yield {"type": "error", "message": f"request failed: {e}"}
            return

        msg = {"role": "assistant", "content": "".join(parts) or None}
        if calls:
            msg["tool_calls"] = [
                {"id": s["id"] or f"call_{i}", "type": "function",
                 "function": {"name": s["name"],
                              "arguments": s["args"] or "{}"}}
                for i, s in sorted(calls.items())]
        convo.append(msg)

        if not calls:
            if finish == "length":
                yield {"type": "error",
                       "message": "Model hit the token limit mid-answer."}
            return

        for i, s in sorted(calls.items()):
            if should_cancel and should_cancel():
                yield {"type": "cancelled"}
                return
            name = s["name"]
            try:
                args = json.loads(s["args"] or "{}")
            except json.JSONDecodeError:
                args = {}
            cid = s["id"] or f"call_{i}"
            brief_in = args.get("cmd") or args.get("path") or ""
            yield {"type": "tool_start", "name": name, "brief": str(brief_in)[:120]}
            result = execute_tool(name, args)
            out_json = json.dumps(result)
            yield {"type": "tool_end", "name": name,
                   "ok": bool(result.get("ok")),
                   "result": result if len(out_json) < 4000 else
                             {"ok": result.get("ok"), "_truncated": True}}
            convo.append({"role": "tool", "tool_call_id": cid,
                          "content": out_json[:24000]})
    yield {"type": "error",
           "message": f"Gave up after {MAX_STEPS} tool rounds without a final answer."}


# ---------------------------------------------------------------- chats store

def valid_cid(cid) -> bool:
    return isinstance(cid, str) and bool(re.fullmatch(r"[0-9a-f]{16}", cid))


def chat_path(cid: str) -> str:
    return os.path.join(CHATS_DIR, cid + ".json")


def load_chat(cid: str) -> dict | None:
    try:
        with open(chat_path(cid)) as f:
            return json.load(f)
    except Exception:
        return None


def save_chat(chat: dict) -> None:
    tmp = chat_path(chat["id"]) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(chat, f)
    os.replace(tmp, chat_path(chat["id"]))


def new_chat() -> dict:
    chat = {"id": secrets.token_hex(8), "title": "untitled",
            "created": time.time(), "updated": time.time(), "messages": []}
    save_chat(chat)
    return chat


def list_chats() -> list:
    out = []
    for fn in os.listdir(CHATS_DIR):
        if not fn.endswith(".json"):
            continue
        c = load_chat(fn[:-5])
        if c:
            out.append({"id": c["id"], "title": c.get("title", "untitled"),
                        "updated": c.get("updated", 0),
                        "n_messages": len(c.get("messages", [])),
                        "running": c["id"] in CHAT_TASK})
    out.sort(key=lambda c: -c["updated"])
    return out


def touch_chat(chat: dict) -> None:
    chat["updated"] = time.time()
    save_chat(chat)


# ---------------------------------------------------------------- task runner

class Task:
    def __init__(self, chat_id: str):
        self.id = secrets.token_hex(8)
        self.chat_id = chat_id
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.done = False
        self.cancel = False


TASKS: dict[str, Task] = {}
CHAT_TASK: dict[str, str] = {}   # chat_id -> running task_id
STATE_LOCK = threading.Lock()


def run_agent_task(task: Task, api_key: str, effort_setting: str) -> None:
    """Detached worker: streams events into the task log and persists the
    final assistant message to the chat file. Survives client disconnects."""
    acc: list[str] = []
    try:
        chat = load_chat(task.chat_id)
        msgs = chat["messages"] if chat else []
        last_user = next((m["content"] for m in reversed(msgs)
                          if m.get("role") == "user"), "")
        if effort_setting == "auto":
            effort = classify_effort(last_user)
        else:
            effort = effort_setting
        with task.cond:
            task.events.append({"type": "effort", "value": effort})
            task.cond.notify_all()
        for ev in run_agent(msgs, api_key,
                            should_cancel=lambda: task.cancel, effort=effort):
            with task.cond:
                task.events.append(ev)
                task.cond.notify_all()
            if ev.get("type") == "delta":
                acc.append(ev.get("text", ""))
            if ev.get("type") in ("cancelled",):
                break
    except Exception as e:  # defensive: never leave the task hanging
        with task.cond:
            task.events.append({"type": "error", "message": f"internal: {e}"})
            task.cond.notify_all()
    finally:
        text = "".join(acc).strip()
        if text:
            chat = load_chat(task.chat_id)
            if chat:
                chat["messages"].append({"role": "assistant", "content": text})
                touch_chat(chat)
        with task.cond:
            task.done = True
            task.cond.notify_all()
        with STATE_LOCK:
            TASKS.pop(task.id, None)
            CHAT_TASK.pop(task.chat_id, None)


# ---------------------------------------------------------------- HTTP

STATIC_DIR = os.path.join(SCRIPT_DIR, "static")
MIME = {".html": "text/html", ".js": "text/javascript",
        ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}",
              flush=True)

    # -- plumbing ---------------------------------------------------------
    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except json.JSONDecodeError:
            return {}

    def _send(self, code: int, obj=None, ctype="application/json",
              raw: bytes | None = None, extra_headers=()):
        body = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in extra_headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _cookie_token(self) -> str | None:
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE_NAME:
                return v
        return None

    def _authed(self) -> bool:
        return check_token(self._cookie_token())

    def _client_ip(self) -> str:
        fwd = self.headers.get("X-Forwarded-For")
        return (fwd.split(",")[0].strip() if fwd else self.client_address[0])

    # -- routes -----------------------------------------------------------
    def do_GET(self):
        path, _, qs = self.path.partition("?")
        segs = [s for s in path.split("/") if s]
        if path == "/health":
            return self._send(200, {"ok": True})
        if path == "/auth/state":
            mode = "setup" if load_auth() is None else "login"
            return self._send(200, {"mode": mode,
                                    "authenticated": self._authed()})
        # static files are public (the login page needs them)
        spath = path if path != "/" else "/index.html"
        fname = os.path.normpath(spath).lstrip("/")
        full = os.path.join(STATIC_DIR, fname)
        if fname and full.startswith(STATIC_DIR) and os.path.isfile(full):
            ext = os.path.splitext(full)[1]
            with open(full, "rb") as f:
                return self._send(200, raw=f.read(),
                                  ctype=MIME.get(ext, "application/octet-stream"),
                                  extra_headers=[("Cache-Control", "no-cache")])
        if not self._authed():
            return self._send(401, {"error": "not authenticated"})
        if path == "/auth/key":
            k = get_api_key()
            return self._send(200, {"configured": bool(k),
                                    "masked": mask_key(k) if k else None,
                                    "model": MODEL,
                                    "reasoning": get_reasoning()})
        if path == "/chats":
            return self._send(200, {"chats": list_chats()})
        if len(segs) == 2 and segs[0] == "chats" and valid_cid(segs[1]):
            chat = load_chat(segs[1])
            if not chat:
                return self._send(404, {"error": "chat not found"})
            task_id = CHAT_TASK.get(chat["id"])
            return self._send(200, {"id": chat["id"], "title": chat["title"],
                                    "messages": chat["messages"],
                                    "running": bool(task_id),
                                    "task_id": task_id})
        if segs and segs[0] == "chat" and "stream" in segs[1:]:
            return self.route_stream(qs)
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        path, _, _qs = self.path.partition("?")
        ip = self._client_ip()
        if path == "/auth/setup":
            if load_auth() is not None:
                return self._send(409, {"error": "already set up"})
            pw = str(self._body().get("password", ""))
            if len(pw) < 8:
                return self._send(400, {"error": "password too short (min 8)"})
            save_auth(pw)
            return self._set_session()
        if path == "/auth/login":
            auth = load_auth()
            if auth is None:
                return self._send(409, {"error": "setup required"})
            if not login_allowed(ip):
                return self._send(429, {"error": "too many attempts, wait 10 min"})
            if hmac.compare_digest(hash_password(str(self._body().get("password", "")),
                                                 auth["salt"]), auth["hash"]):
                return self._set_session()
            record_fail(ip)
            time.sleep(1)
            return self._send(401, {"error": "wrong password"})
        if path == "/auth/logout":
            return self._send(200, {"ok": True}, extra_headers=[
                ("Set-Cookie", f"{COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax")])
        if not self._authed():
            return self._send(401, {"error": "not authenticated"})
        if path == "/auth/key":
            k = str(self._body().get("api_key", "")).strip()
            if not k.startswith("sk-or-"):
                return self._send(400, {"error": "that does not look like an OpenRouter key"})
            with open(KEY_FILE, "w") as f:
                f.write(k)
            os.chmod(KEY_FILE, 0o600)
            return self._send(200, {"ok": True, "masked": mask_key(k)})
        if path == "/auth/validate-key":
            k = str(self._body().get("api_key", "")).strip()
            if not k.startswith("sk-or-"):
                return self._send(400, {"ok": False, "error": "keys start with sk-or-"})
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/auth/key",
                headers={"Authorization": f"Bearer {k}"})
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    info = json.load(r)
                data = info.get("data", {}) if isinstance(info, dict) else {}
                out = {"ok": True,
                       "label": data.get("label") or "(unnamed key)",
                       "usage": round(data.get("usage", 0), 2),
                       "limit": data.get("limit"),
                       "is_free_tier": data.get("is_free_tier", False)}
                return self._send(200, out)
            except urllib.error.HTTPError as e:
                detail = e.read()[:200].decode(errors="replace")
                msg = "invalid or revoked key" if e.code == 401 else \
                      f"OpenRouter HTTP {e.code}"
                return self._send(200, {"ok": False, "error": msg, "detail": detail})
            except Exception as e:
                return self._send(200, {"ok": False, "error": f"network error: {e}"})
        if path == "/settings/reasoning":
            lvl = str(self._body().get("effort", "")).strip().lower()
            if lvl not in VALID_EFFORTS:
                return self._send(400, {"error": f"effort must be one of: {', '.join(VALID_EFFORTS)}"})
            s = load_settings()
            s["reasoning_effort"] = lvl
            save_settings(s)
            return self._send(200, {"ok": True, "reasoning": lvl})
        if path == "/chats":
            chat = new_chat()
            return self._send(200, {"id": chat["id"]})
        if path == "/chat":
            return self.route_chat_start()
        if path == "/chat/stop":
            task_id = str(self._body().get("task_id", ""))
            with STATE_LOCK:
                task = TASKS.get(task_id)
                if task:
                    task.cancel = True
            return self._send(200, {"ok": bool(task),
                                    "note": "stop takes effect between agent steps"})
        return self._send(404, {"error": "not found"})

    def do_DELETE(self):
        path, _, _qs = self.path.partition("?")
        if not self._authed():
            return self._send(401, {"error": "not authenticated"})
        segs = [s for s in path.split("/") if s]
        if len(segs) == 2 and segs[0] == "chats" and valid_cid(segs[1]):
            cid = segs[1]
            with STATE_LOCK:
                tid = CHAT_TASK.get(cid)
                if tid and tid in TASKS:
                    TASKS[tid].cancel = True
            try:
                os.remove(chat_path(cid))
            except FileNotFoundError:
                return self._send(404, {"error": "chat not found"})
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})

    def _set_session(self):
        secure = ", Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return self._send(200, {"ok": True}, extra_headers=[
            ("Set-Cookie",
             f"{COOKIE_NAME}={make_token()}; Max-Age={SESSION_TTL}; Path=/; HttpOnly; SameSite=Lax{secure}")])

    # -- chat start (detached task) ----------------------------------------
    def route_chat_start(self):
        body = self._body()
        cid = body.get("chat_id")
        content = str(body.get("content", "")).strip()
        if not valid_cid(cid):
            return self._send(400, {"error": "chat_id required"})
        if not content:
            return self._send(400, {"error": "content required"})
        chat = load_chat(cid)
        if not chat:
            return self._send(404, {"error": "chat not found"})
        api_key = get_api_key()
        if not api_key:
            return self._send(400, {"error": "no OpenRouter key configured — open Settings"})
        with STATE_LOCK:
            if cid in CHAT_TASK:
                return self._send(409, {"error": "a task is already running for this chat"})
            chat["messages"].append({"role": "user",
                                     "content": content[-32000:]})
            if chat.get("title") in ("", "untitled"):
                chat["title"] = content.replace("\n", " ")[:48]
            touch_chat(chat)
            task = Task(cid)
            TASKS[task.id] = task
            CHAT_TASK[cid] = task.id
        threading.Thread(target=run_agent_task,
                         args=(task, api_key, get_reasoning()),
                         daemon=True).start()
        return self._send(202, {"task_id": task.id, "chat_id": cid})

    # -- SSE stream (replayable, disconnect-safe) ---------------------------
    def route_stream(self, qs: str):
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        task_id = params.get("task", "")
        try:
            from_idx = max(int(params.get("from", "0")), 0)
        except ValueError:
            from_idx = 0
        with STATE_LOCK:
            task = TASKS.get(task_id)
        if not task:
            return self._send(404, {"error": "task not found (already finished? load the chat instead)"})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(ev: dict):
            self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
            self.wfile.flush()

        try:
            idx = from_idx
            while True:
                with task.cond:
                    while idx >= len(task.events) and not task.done:
                        task.cond.wait(timeout=15)
                    snap = task.events[idx:]
                    done = task.done
                if snap:
                    for ev in snap:
                        emit(ev)
                    idx += len(snap)
                elif done:
                    break
                else:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
            emit({"type": "done"})
        except (BrokenPipeError, ConnectionResetError):
            print("[stream] subscriber disconnected (task keeps running)",
                  flush=True)
        except Exception as e:
            try:
                emit({"type": "error", "message": str(e)})
            except Exception:
                pass


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"vps-assistant listening on http://{HOST}:{PORT} "
          f"(model: {MODEL}, data: {DATA_DIR})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
