/* VPS Assistant — terminal frontend (server-persisted chats, reattachable tasks) */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let chatId = null;        // active chat id
let streaming = false;    // a task is attached/running in this tab
let currentTask = null;   // task id we're streaming
let streamAbort = null;
let eventSource = null;

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
  const segs = txt.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/);
  for (let i = 0; i < segs.length; i++) {
    if (!segs[i].startsWith("<pre>")) segs[i] = segs[i].replace(/\n/g, "<br>");
  }
  txt = segs.join("");
  return txt.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[+i]);
}

/* ---------- boot / auth ---------- */
function enterApp() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  refreshKeyStatus();
  refreshChatList().then(() => {
    const first = ($("chat-list").querySelector(".chat-item") || {}).dataset?.id;
    if (first) openChat(first);
    else newChat();
  });
}

async function boot() {
  const st = await fetch("/auth/state").then((r) => r.json());
  if (st.mode === "setup") {
    $("auth-sub").textContent = "first run — create password (min 8 chars)";
    $("auth-btn").textContent = "[ create & unlock ]";
    $("auth-pass").setAttribute("autocomplete", "new-password");
  } else {
    $("auth-pass").setAttribute("autocomplete", "current-password");
  }
  if (st.authenticated) { enterApp(); return; }
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

/* ---------- key / settings ---------- */
/* curated OpenRouter models: verified tool-calling capable */
const MODEL_LISTS = [
  { id: "stealth/ox-alpha", label: "★ Ox-Alpha (best quality)" },
  { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (free · 1M ctx)" },
  { id: "cohere/north-mini-code:free",        label: "North Mini Code (free · code)" },
];

async function refreshKeyStatus() {
  const k = await fetch("/auth/key").then((r) => r.json());
  $("model-badge").textContent = `${k.model} · ${k.reasoning || "?"}`;
  $("key-status").textContent = k.configured
    ? k.masked + " configured" : "not configured";
  document.querySelectorAll("#reasoning-seg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.effort === k.reasoning));
  // rebuild model select
  const sel = $("model-select");
  sel.innerHTML = "";
  const haveCurrent = MODEL_LISTS.some((m) => m.id === k.model);
  for (const m of MODEL_LISTS) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  if (!haveCurrent && k.model) {   // keep custom/legacy value selectable
    const o = document.createElement("option");
    o.value = k.model; o.textContent = k.model + " (custom)";
    sel.appendChild(o);
  }
  sel.value = k.model || "";
  if (!sel.value && MODEL_LISTS.length) sel.value = MODEL_LISTS[0].id;
}

let modelSaveTimer = null;
$("model-select").addEventListener("change", async () => {
  const v = $("model-select").value;
  if (!v) return;
  await fetch("/settings/provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: v }),
  });
  refreshKeyStatus();
});

document.querySelectorAll("#reasoning-seg button").forEach((b) =>
  b.addEventListener("click", async () => {
    const effort = b.dataset.effort;
    const r = await fetch("/settings/reasoning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort }),
    });
    if (r.ok) refreshKeyStatus();
  }));
$("btn-settings").addEventListener("click", () => {
  toggleSidebar(false);
  $("settings").classList.remove("hidden");
  $("key-verify").textContent = "";
  refreshKeyStatus();
});
$("btn-logout").addEventListener("click", async () => {
  toggleSidebar(false);
  await fetch("/auth/logout", { method: "POST" });
  location.reload();
});

/* ---------- terminal drawer (quick commands) ---------- */
const termHist = [];
let termHistIdx = -1;
let termBusy = false;

function termAppend(text) {
  const out = $("term-out");
  out.textContent += "\n" + text;
  out.scrollTop = out.scrollHeight;
}

async function termRun() {
  if (termBusy) return;
  const cmd = $("term-cmd").value.trim();
  if (!cmd) return;
  termBusy = true;
  $("term-run").disabled = true;
  termHist.push(cmd);
  termHistIdx = termHist.length;
  $("term-cmd").value = "";
  termAppend("$ " + cmd);
  try {
    const r = await fetch("/term", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd }),
    });
    const d = await r.json();
    if (d.error) termAppend("[error] " + d.error);
    else {
      let block = "";
      if (d.stdout) block += d.stdout;
      if (d.stderr) block += "[stderr] " + d.stderr;
      if (!block) block = "(no output)";
      termAppend(block);
      termAppend(`[exit ${d.exit_code}]`);
    }
  } catch (e) {
    termAppend("[network error] " + e.message);
  } finally {
    termBusy = false;
    $("term-run").disabled = false;
  }
}

$("btn-term").addEventListener("click", () => {
  toggleSidebar(false);
  $("term-drawer").classList.remove("hidden");
  setTimeout(() => $("term-cmd").focus(), 60);
});
$("term-close").addEventListener("click", () => $("term-drawer").classList.add("hidden"));
$("term-run").addEventListener("click", termRun);
$("term-cmd").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); termRun(); }
  else if (e.key === "ArrowUp" && termHist.length) {
    e.preventDefault();
    termHistIdx = Math.max(0, termHistIdx - 1);
    $("term-cmd").value = termHist[termHistIdx];
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    termHistIdx = Math.min(termHist.length, termHistIdx + 1);
    $("term-cmd").value = termHist[termHistIdx] ?? "";
  }
});
$("settings-close").addEventListener("click", () => $("settings").classList.add("hidden"));
/* key flow: always-visible input + check/save (no toggle states to desync) */
$("key-toggle")?.addEventListener("click", () => {
  $("key-input").classList.toggle("hidden");
  $("key-actions").classList.toggle("hidden");
  $("key-verify").textContent = "";
});
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "toggle-key") { $("key-toggle").click(); }
  else if (act === "check-key") { $("key-check").click(); }
  else if (act === "save-key") { $("key-save").click(); }
});
async function validateKey(k) {
  const r = await fetch("/auth/validate-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: k }),
  });
  return r.json();
}
$("key-check").addEventListener("click", async () => {
  const v = $("key-input").value.trim();
  const note = $("key-verify");
  if (v.length < 20) { note.textContent = "!! that does not look like an API key"; return; }
  note.textContent = "checking with OpenRouter…";
  const d = await validateKey(v);
  note.textContent = d.ok
    ? `valid — ${d.label}, used $${d.usage}${d.limit ? " of $" + d.limit : ""}`
    : "!! " + d.error;
});
$("key-save").addEventListener("click", async () => {
  const v = $("key-input").value.trim();
  const note = $("key-verify");
  if (v.length < 20) { note.textContent = "!! that does not look like an API key"; return; }
  const r = await fetch("/auth/key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: v }),
  });
  const d = await r.json();
  $("key-status").textContent = r.ok ? "saved " + d.masked : (d.error || "save failed");
  $("key-verify").textContent = r.ok ? "saved ✔ (use check to verify against OpenRouter)" : "";
  $("key-input").value = "";
  refreshKeyStatus();
});

/* ---------- sidebar / chat list ---------- */
async function refreshChatList() {
  const d = await fetch("/chats").then((r) => r.json());
  const list = $("chat-list");
  list.innerHTML = "";
  for (const c of d.chats || []) {
    const el = document.createElement("div");
    el.className = "chat-item" + (c.id === chatId ? " active" : "");
    el.dataset.id = c.id;
    const runMark = c.running ? '<span class="run-mark">●</span>' : "";
    el.innerHTML = `<span class="ci-title">${esc(c.title)}</span>${runMark}` +
      `<button class="ci-dots" title="Options">⋮</button>`;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".ci-dots")) return;
      openChat(c.id);
    });
    el.querySelector(".ci-dots").addEventListener("click", (e) => {
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, c);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, c);
    });
    list.appendChild(el);
  }
  return d.chats || [];
}

/* ---------- context menu (⋮ / right-click) ---------- */
function closeCtxMenu() {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
}
function openCtxMenu(x, y, chat) {
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  const open = document.createElement("button");
  open.textContent = "open";
  open.addEventListener("click", () => { closeCtxMenu(); openChat(chat.id); });
  const del = document.createElement("button");
  del.textContent = chat.running ? "delete… (task running — will stop it)" : "delete";
  del.className = "danger";
  del.addEventListener("click", async () => {
    closeCtxMenu();
    if (!confirm(`Delete chat "${chat.title}"? This cannot be undone.`)) return;
    await fetch(`/chats/${chat.id}`, { method: "DELETE" });
    if (chat.id === chatId) { chatId = null; detachStream(); }
    if ((await refreshChatList()).length) {
      if (!chatId) openChat(($("chat-list").querySelector(".chat-item") || {}).dataset?.id || null);
    } else {
      newChat();
    }
  });
  menu.append(open, del);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
}
document.addEventListener("click", closeCtxMenu);
document.addEventListener("scroll", closeCtxMenu, true);

function toggleSidebar(force) {
  $("sidebar").classList.toggle("open", force);
  $("backdrop").classList.toggle("show", force);
}
$("btn-menu").addEventListener("click", () => toggleSidebar());
$("backdrop").addEventListener("click", () => toggleSidebar(false));
$("btn-newchat").addEventListener("click", () => { newChat(); });

async function requestStop() {
  if (!currentTask) return;
  setStatus("stop requested — takes effect between steps…");
  await fetch("/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: currentTask }),
  });
}

async function newChat() {
  const d = await fetch("/chats", { method: "POST" }).then((r) => r.json());
  chatId = d.id;
  await refreshChatList();
  renderChat({ id: chatId, messages: [], running: false });
  if (window.innerWidth <= 900) toggleSidebar(false);
}

async function openChat(id) {
  if (streaming) detachStream();
  const d = await fetch(`/chats/${id}`).then((r) => r.json());
  chatId = id;
  renderChat(d);
  refreshChatList();
  if (d.running && d.task_id) attachStream(d.task_id, true);
  if (window.innerWidth <= 900) toggleSidebar(false);
}

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
const scrollDown = () => { chatEl.scrollTop = chatEl.scrollHeight; };

function showHero() {
  chatEl.innerHTML = ""; chatInner = null;
  const hero = document.createElement("div");
  hero.className = "empty-hero";
  hero.innerHTML = `
    <p class="hero-title">vpsa_</p>
    <p class="hero-tag">connected to local vps · shell access enabled · be specific</p>
    <div class="suggestions">
      <button data-q="Check overall server health: disk, memory, CPU load, failed systemd services">server health check</button>
      <button data-q="What are my public-facing services right now? Check listening ports and nginx sites">list exposed services</button>
      <button data-q="Show recent errors from journalctl across all services">recent system errors</button>
      <button data-q="Is anything consuming unusual CPU or memory right now? Show top processes">top resource hogs</button>
    </div>`;
  hero.querySelectorAll("button[data-q]").forEach((b) =>
    b.addEventListener("click", () => { $("input").value = b.dataset.q; doSend(); }));
  ensureInner().appendChild(hero);
  scrollDown();
}

function renderChat(chat) {
  chatEl.innerHTML = ""; chatInner = null;
  if (!chat.messages.length) { showHero(); return; }
  for (const m of chat.messages) {
    if (m.role === "user") addUserMsg(m.content);
    else addAssistantMsg(mdRender(m.content));
  }
  scrollDown();
}

function addUserMsg(text) {
  ensureInner();
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  chatInner.appendChild(el);
  scrollDown();
}

function addAssistantMsg(html) {
  ensureInner();
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="bubble">${html ?? '<span class="cursor"></span>'}</div>`;
  chatInner.appendChild(el);
  scrollDown();
  return el.querySelector(".bubble");
}

function addToolChip(name, brief) {
  ensureInner();
  const chip = document.createElement("details");
  chip.className = "tool-chip";
  chip.innerHTML = `
    <summary><span class="t-ico">*</span><span class="t-name">${esc(name)}</span>
      <span class="t-brief">${esc(brief)}</span></summary>
    <pre>(running…)</pre>`;
  chatInner.appendChild(chip);
  scrollDown();
  return chip;
}

function setStatus(text) {
  ensureInner();
  let s = chatInner.querySelector(".status-line:last-of-type");
  if (!text) { if (s) s.remove(); return; }
  if (!s) { s = document.createElement("div"); s.className = "status-line"; chatInner.appendChild(s); }
  s.textContent = text;
}

function setRunningUI(on) {
  streaming = on;
  // the composer's send button becomes a stop button while a task runs
  const send = $("btn-send");
  send.textContent = on ? "stop" : "send";
  send.classList.toggle("stopping", on);
}

async function requestStop() {
  if (!currentTask) return;
  setStatus("stop requested — takes effect between steps…");
  await fetch("/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: currentTask }),
  });
}

/* ---------- send / task lifecycle ---------- */
function autoGrow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = t.scrollHeight + "px";   // no cap — expands with content
}
$("input").addEventListener("input", autoGrow);
// sending is button-only by design; Enter inserts a newline
$("btn-send").addEventListener("click", doSend);

async function doSend() {
  if (streaming) { await requestStop(); return; }
  const input = $("input");
  const text = input.value.trim();
  if (!text || !chatId) return;
  const keyOk = (await fetch("/auth/key").then((r) => r.json())).configured;
  if (!keyOk) {
    $("btn-settings").click(); $("key-toggle").click();
    $("key-status").textContent = "add your OpenRouter API key below";
    return;
  }
  input.value = ""; autoGrow();

  const r = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, content: text }),
  });
  const d = await r.json();
  if (!r.ok) {
    addUserMsg(text);   // still show what you tried
    addAssistantMsg(`<span class="alert">!! ${esc(d.error || "failed")}</span>`);
    return;
  }
  addUserMsg(text);
  refreshChatList();
  attachStream(d.task_id, false);
}

/* Attach to a task's event stream. `replay` = include events already logged. */
function attachStream(taskId, replay) {
  detachStream();
  currentTask = taskId;
  setRunningUI(true);
  let bubble = null, rawText = "", renderQueued = false, hadError = false;
  const from = replay ? 0 : null;   // server replays full log when from=0

  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      if (bubble) { bubble.innerHTML = mdRender(rawText) + '<span class="cursor"></span>'; scrollDown(); }
    }, 90);
  };
  /* final render without the blinking cursor; never clobber error alerts */
  const finalize = () => {
    renderQueued = false;
    if (bubble && !hadError) {
      bubble.innerHTML = mdRender(rawText) || "(empty reply)";
      scrollDown();
    }
    bubble = null;
  };
  const handle = (ev) => {
    if (ev.type === "delta") {
      if (!bubble) bubble = addAssistantMsg();
      rawText += ev.text;
      scheduleRender();
    } else if (ev.type === "effort") {
      setStatus("thinking… (effort: " + ev.value + ")");
    } else if (ev.type === "tool_start") {
      if (bubble && !rawText) { bubble.remove(); bubble = null; }
      ev._chip = addToolChip(ev.name, ev.brief);
      setStatus(ev.name + " running…");
    } else if (ev.type === "tool_end") {
      const chip = ev._chip;
      if (chip) {
        chip.classList.add("done");
        chip.classList.toggle("failed", !ev.ok);
        chip.querySelector(".t-ico").textContent = ev.ok ? "ok" : "!!";
        const pre = chip.querySelector("pre");
        if (ev.result && ev.result._truncated) {
          pre.textContent = "(large output truncated in UI — full output was given to the model)";
        } else {
          const r = ev.result || {}, parts = [];
          if (r.stdout) parts.push(r.stdout);
          if (r.stderr) parts.push("[stderr] " + r.stderr);
          if (r.content !== undefined) parts.push(r.content);
          if (r.error) parts.push("[error] " + r.error);
          if (r.bytes_written !== undefined) parts.push(`(${r.bytes_written} bytes written)`);
          pre.textContent = parts.join("\n") || "(no output)";
        }
      }
      setStatus("");
    } else if (ev.type === "cancelled") {
      if (bubble) bubble.innerHTML = mdRender(rawText) + " <em>(stopped)</em>";
      setStatus("");
    } else if (ev.type === "error") {
      hadError = true;
      if (!bubble) bubble = addAssistantMsg();
      bubble.innerHTML = `<span class="alert">!! ${esc(ev.message)}</span>`;
      scrollDown();
    }
  };

  const url = `/chat/stream?task=${encodeURIComponent(taskId)}${from !== null ? "&from=0" : ""}`;
  eventSource = new EventSource(url);
  eventSource.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === "done") {
      finalize();
      detachStream();
      refreshChatList();
      return;
    }
    handle(ev);
  };
  eventSource.onerror = () => {
    // task finished and endpoint went away — reload authoritative state
    detachStream();
    if (chatId) openChat(chatId);
  };
}

function detachStream() {
  if (eventSource) { try { eventSource.close(); } catch {} eventSource = null; }
  setRunningUI(false);
  setStatus("");
  currentTask = null;
}

// Reattach to the active chat's running task after a page reload.
window.addEventListener("beforeunload", () => { try { eventSource?.close(); } catch {} });

/* ---------- mic dictation (Web Speech API, button-only UX) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
  $("btn-mic").classList.add("hidden");
} else {
  let recog = null, recording = false;
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
      setStatus("listening… speak, then tap ⏹");
    };
    recog.onresult = (e) => {
      let finalTxt = "", interim = "";
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
      micBtn.textContent = "mic";
      setStatus("");
    };
    recog.onend = stop;
    recog.onerror = (e) => {
      stop();
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setStatus("mic blocked — allow microphone access for this site");
      } else if (e.error !== "aborted") setStatus("voice input error: " + e.error);
    };
    try { recog.start(); } catch {}
  });
}

/* startup sanity: every control we expect must exist in the DOM */
for (const id of ["btn-send", "btn-newchat", "btn-mic", "btn-settings",
                  "btn-menu", "chat-list", "input"]) {
  if (!$(id)) console.error("vpsa: missing required element #" + id);
}

boot();
