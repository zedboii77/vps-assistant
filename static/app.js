/* VPS Assistant frontend */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let convo = [];          // {role, content}
let streaming = false;
let abortCtl = null;

/* ---------- tiny markdown ---------- */
function mdRender(src) {
  const blocks = [];
  let txt = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  txt = esc(txt);
  txt = txt.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  txt = txt.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  txt = txt.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  txt = txt.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  txt = txt.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  txt = txt.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  txt = txt.replace(/^\s*[-•] (.*)$/gm, "<li>$1</li>")
           .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
  // line breaks outside of pre blocks
  const segs = txt.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/);
  for (let i = 0; i < segs.length; i++) {
    if (!segs[i].startsWith("<pre>")) {
      segs[i] = segs[i].replace(/\n/g, "<br>");
    }
  }
  txt = segs.join("");
  txt = txt.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[+i]);
  return txt;
}

/* ---------- boot ---------- */
function enterApp() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  refreshKeyStatus();
  loadHistory() || showHero();
}

async function boot() {
  const st = await fetch("/auth/state").then((r) => r.json());
  if (st.mode === "setup") {
    $("auth-sub").textContent = "Create your password (first run)";
    $("auth-btn").textContent = "Create & unlock";
    $("auth-pass").setAttribute("autocomplete", "new-password");
  } else {
    $("auth-pass").setAttribute("autocomplete", "current-password");
  }
  if (st.authenticated) {
    enterApp();               // valid session cookie — skip the login form
    return;
  }
  $("auth").classList.remove("hidden");
  $("auth-form").dataset.mode = st.mode;
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pass = $("auth-pass").value;
  const mode = e.target.dataset.mode;
  $("auth-btn").disabled = true;
  $("auth-err").textContent = "";
  try {
    const r = await fetch(`/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pass }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "failed");
    enterApp();
  } catch (err) {
    $("auth-err").textContent = err.message;
  } finally {
    $("auth-btn").disabled = false;
    $("auth-pass").value = "";
  }
});

/* ---------- local persistence (chats survive refresh) ---------- */
const LS_KEY = "vpsa_convo_v1";

function saveHistory() {
  try {
    // tool chips are transient; only durable text roles are stored
    localStorage.setItem(LS_KEY, JSON.stringify(convo.slice(-200)));
  } catch { /* storage unavailable/full */ }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return false;
    convo = saved.filter((m) =>
      m && (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" && m.content.trim());
    if (!convo.length) return false;
    for (const m of convo) {
      if (m.role === "user") {
        addUserMsg(m.content);
      } else {
        const b = addAssistantMsg();
        b.innerHTML = mdRender(m.content);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/* ---------- key / settings ---------- */
async function refreshKeyStatus() {
  const k = await fetch("/auth/key").then((r) => r.json());
  $("model-badge").textContent = k.model || "?";
  $("model-name").textContent = k.model || "?";
  $("key-status").textContent = k.configured
    ? `${k.masked} (configured)`
    : "not configured — paste your OpenRouter key";
  return k;
}

$("btn-settings").addEventListener("click", () => {
  $("settings").classList.remove("hidden");
  $("key-input").classList.add("hidden");
  $("key-save").classList.add("hidden");
  refreshKeyStatus();
});
$("settings-close").addEventListener("click", () => $("settings").classList.add("hidden"));
$("key-toggle").addEventListener("click", () => {
  $("key-input").classList.toggle("hidden");
  $("key-save").classList.toggle("hidden");
});
$("key-save").addEventListener("click", async () => {
  const v = $("key-input").value.trim();
  if (!v.startsWith("sk-or-")) { $("key-status").textContent = "keys start with sk-or-"; return; }
  const r = await fetch("/auth/key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: v }),
  });
  const d = await r.json();
  $("key-status").textContent = r.ok ? `saved ${d.masked}` : (d.error || "save failed");
  $("key-input").value = "";
  $("key-input").classList.add("hidden");
  $("key-save").classList.add("hidden");
  refreshKeyStatus();
});
$("btn-logout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.reload();
});

/* ---------- rendering ---------- */
const chatEl = $("chat");
let chatInner = null;

function ensureInner() {
  if (!chatInner) {
    chatInner = document.createElement("div");
    chatInner.className = "chat-inner";
    chatEl.appendChild(chatInner);
  }
  return chatInner;
}

function scrollDown() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function showHero() {
  chatEl.innerHTML = "";
  chatInner = null;
  const hero = document.createElement("div");
  hero.className = "empty-hero";
  hero.innerHTML = `
    <div class="logo-big">V</div>
    <h2>VPS Assistant</h2>
    <p>Chat with an agent that runs commands directly on this server.</p>
    <div class="suggestions">
      <button data-q="Check overall server health: disk, memory, CPU load, failed systemd services">Server health check</button>
      <button data-q="What are my public-facing services right now? Check listening ports and nginx sites">List exposed services</button>
      <button data-q="Show recent errors from journalctl across all services">Recent system errors</button>
      <button data-q="Is anything consuming unusual CPU or memory right now? Show top processes">Top resource hogs</button>
    </div>`;
  hero.querySelectorAll("button[data-q]").forEach((b) =>
    b.addEventListener("click", () => { $("input").value = b.dataset.q; doSend(); }));
  chatEl.appendChild(hero);
}

function addUserMsg(text) {
  ensureInner();
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  chatInner.appendChild(el);
  scrollDown();
}

function addAssistantMsg() {
  ensureInner();
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="bubble"><span class="cursor"></span></div>`;
  chatInner.appendChild(el);
  scrollDown();
  return el.querySelector(".bubble");
}

function addToolChip(name, brief) {
  ensureInner();
  const chip = document.createElement("details");
  chip.className = "tool-chip";
  chip.innerHTML = `
    <summary><span class="t-ico">⏳</span><span class="t-name">${esc(name)}</span>
      <span class="t-brief">${esc(brief)}</span></summary>
    <pre>(running…)</pre>`;
  chatInner.appendChild(chip);
  chip.open = false;
  scrollDown();
  return chip;
}

function setStatus(text) {
  ensureInner();
  let s = chatInner.querySelector(".status-line:last-of-type");
  if (!text) { if (s) s.remove(); return; }
  if (!s) {
    s = document.createElement("div");
    s.className = "status-line";
    chatInner.appendChild(s);
  }
  s.textContent = text;
}

/* ---------- send / stream ---------- */
function setBusy(b) {
  streaming = b;
  const btn = $("btn-send");
  btn.disabled = false;
  btn.textContent = b ? "■" : "➤";
  $("input").disabled = b;
}

async function doSend() {
  if (streaming) { abortCtl?.abort(); return; }
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;
  const keyOk = (await fetch("/auth/key").then((r) => r.json())).configured;
  if (!keyOk) {
    $("btn-settings").click();
    $("key-toggle").click();
    $("key-status").textContent = "Add your OpenRouter API key first ↓";
    return;
  }

  convo.push({ role: "user", content: text });
  saveHistory();
  input.value = "";
  autoGrow();
  addUserMsg(text);
  setBusy(true);
  abortCtl = new AbortController();

  let bubble = null;
  let rawText = "";
  let renderQueued = false;
  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      if (bubble) {
        bubble.innerHTML = mdRender(rawText) + '<span class="cursor"></span>';
        scrollDown();
      }
    }, 90);
  };

  try {
    const resp = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: convo }),
      signal: abortCtl.signal,
    });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!frame.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(frame.slice(5).trim()); } catch { continue; }

        if (ev.type === "delta") {
          if (!bubble) bubble = addAssistantMsg();
          rawText += ev.text;
          scheduleRender();
        } else if (ev.type === "tool_start") {
          if (bubble && !rawText) { bubble.remove(); bubble = null; }
          ev._chip = addToolChip(ev.name, ev.brief);
          setStatus(`${ev.name} running…`);
        } else if (ev.type === "tool_end") {
          const chip = ev._chip;
          if (chip) {
            chip.classList.toggle("failed", !ev.ok);
            chip.querySelector(".t-ico").textContent = ev.ok ? "✓" : "✗";
            const pre = chip.querySelector("pre");
            if (ev.result && ev.result._truncated) {
              pre.textContent = "(large output truncated in UI — full output was given to the model)";
            } else {
              const r = ev.result || {};
              const parts = [];
              if (r.stdout) parts.push(r.stdout);
              if (r.stderr) parts.push("[stderr] " + r.stderr);
              if (r.content !== undefined) parts.push(r.content);
              if (r.error) parts.push("[error] " + r.error);
              if (r.bytes_written !== undefined) parts.push(`(${r.bytes_written} bytes written)`);
              pre.textContent = parts.join("\n") || "(no output)";
            }
          }
          setStatus("");
        } else if (ev.type === "status") {
          setStatus(ev.stage === "thinking" ? "thinking…" : "");
        } else if (ev.type === "error") {
          if (!bubble) bubble = addAssistantMsg();
          bubble.innerHTML = `<span style="color:var(--danger)">⚠ ${esc(ev.message)}</span>`;
          scrollDown();
        } else if (ev.type === "done") {
          if (bubble) {
            bubble.innerHTML = mdRender(rawText) || "(empty reply)";
            if (rawText.trim()) {
              convo.push({ role: "assistant", content: rawText });
              saveHistory();
            }
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      if (!bubble) bubble = addAssistantMsg();
      bubble.innerHTML = `<span style="color:var(--danger)">⚠ ${esc(err.message)}</span>`;
      convo.pop(); // don't keep the user msg if the turn failed hard
      saveHistory();
    } else if (bubble) {
      bubble.innerHTML = mdRender(rawText) + " <em>(stopped)</em>";
      if (rawText.trim()) {
        convo.push({ role: "assistant", content: rawText });
        saveHistory();
      }
    }
  } finally {
    setStatus("");
    setBusy(false);
    abortCtl = null;
    scrollDown();
  }
}

/* ---------- composer ---------- */
function autoGrow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}
$("input").addEventListener("input", autoGrow);
// NOTE: sending is intentionally button-only. Enter inserts a newline.
$("btn-send").addEventListener("click", doSend);

/* ---------- mic dictation (Web Speech API, button-only UX) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
  $("btn-mic").classList.add("hidden");   // unsupported browser: hide entirely
} else {
  let recog = null;
  let recording = false;
  const micBtn = $("btn-mic");

  micBtn.addEventListener("click", () => {
    if (recording) { recog.stop(); return; }
    recog = new SR();
    recog.lang = navigator.language || "en-US";
    recog.interimResults = true;
    recog.continuous = true;
    const base = $("input").value;

    recog.onstart = () => {
      recording = true;
      micBtn.classList.add("recording");
      micBtn.textContent = "⏹";
      micBtn.title = "Stop dictation";
      setStatus("listening… speak, then tap ⏹");
    };
    recog.onresult = (e) => {
      let finalTxt = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalTxt += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      $("input").value = (base ? base + " " : "") + finalTxt + interim;
      autoGrow();
    };
    const stop = () => {
      if (!recording) return;
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.textContent = "🎙";
      micBtn.title = "Voice input";
      setStatus("");
    };
    recog.onend = stop;
    recog.onerror = (e) => {
      stop();
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setStatus("mic blocked — allow microphone access for this site");
      } else if (e.error !== "aborted") {
        setStatus("voice input error: " + e.error);
      }
    };
    try { recog.start(); } catch { /* double-start race; ignore */ }
  });
}

$("btn-newchat").addEventListener("click", () => {
  convo = [];
  try { localStorage.removeItem(LS_KEY); } catch {}
  showHero();
});

boot();
