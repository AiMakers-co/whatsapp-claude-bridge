/**
 * Local dashboard for the bridge — one self-contained HTML page served by the
 * control API at GET / (see api.ts). No build step, no external requests: all
 * CSS + JS is inline so it works fully offline. The page itself contains no
 * data; everything is fetched from the token-guarded API endpoints with the
 * WA_API_TOKEN the user pastes on first load (kept in localStorage).
 *
 * Sections below: STYLES → MARKUP → SCRIPT (token / api / header / chats /
 * history / compose / tasks / logs / boot).
 */

export const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>whatsapp-claude-bridge</title>

<!-- ══════════════════════════ STYLES ══════════════════════════ -->
<style>
  :root {
    --bg: #111315;          /* deep charcoal canvas */
    --panel: #17191c;       /* raised panels */
    --panel-2: #1c1f23;     /* hover / inputs */
    --line: #24272b;        /* hairlines */
    --fg: #e8e4dc;          /* warm off-white */
    --fg-dim: #9a958b;      /* secondary text */
    --fg-faint: #5f5b53;    /* timestamps, micro-copy */
    --green: #25D366;       /* the single accent */
    --green-dim: rgba(37, 211, 102, 0.12);
    --red: #e05c5c;
    --amber: #d9a441;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.35 -apple-system, "Helvetica Neue", Arial, sans-serif;
    overflow: hidden;
  }
  button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }

  /* ── header strip ── */
  #hdr {
    display: flex; align-items: center; gap: 14px;
    height: 38px; padding: 0 12px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    white-space: nowrap; overflow: hidden;
  }
  #hdr .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--fg-faint); flex: none;
  }
  #hdr .dot.ok  { background: var(--green); box-shadow: 0 0 6px var(--green); }
  #hdr .dot.bad { background: var(--red); }
  #hdr .dot.warn{ background: var(--amber); }
  #hdr .kv { color: var(--fg-dim); }
  #hdr .kv b { color: var(--fg); font-weight: 600; }
  #hdr .mono { font-family: var(--mono); font-size: 12px; }
  #hdr .badge {
    font-family: var(--mono); font-size: 11px;
    padding: 1px 7px; border-radius: 9px;
    background: var(--green-dim); color: var(--green);
  }
  #hdr .badge.zero { background: var(--panel-2); color: var(--fg-faint); }
  #hdr .spacer { flex: 1; }
  #panel-toggle { color: var(--fg-dim); padding: 2px 6px; }
  #panel-toggle:hover { color: var(--fg); }
  #settings-btn { color: var(--fg-dim); padding: 2px 6px; }
  #settings-btn:hover { color: var(--fg); }

  /* ── settings overlay ── */
  #settings-overlay {
    position: fixed; inset: 0; display: none;
    align-items: flex-start; justify-content: center;
    background: rgba(10, 11, 12, 0.86); z-index: 20;
    padding: 32px 16px; overflow-y: auto;
  }
  #settings-overlay.show { display: flex; }
  #settings-box {
    width: 640px; max-width: 100%;
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  #settings-head {
    display: flex; align-items: center; gap: 10px;
    padding: 15px 20px; border-bottom: 1px solid var(--line);
  }
  #settings-head h1 { font-size: 15px; font-weight: 600; flex: 1; }
  #settings-head .x { color: var(--fg-dim); font-size: 18px; padding: 0 6px; line-height: 1; }
  #settings-head .x:hover { color: var(--fg); }
  #settings-body { padding: 6px 20px 12px; }
  .ssection { padding: 14px 0 4px; }
  .sect-h {
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--green); opacity: 0.9; padding-bottom: 8px;
    border-bottom: 1px solid var(--line); margin-bottom: 10px;
  }
  .field { margin-bottom: 13px; }
  .field > label {
    display: block; font-weight: 600; color: var(--fg);
    margin-bottom: 3px; font-size: 12.5px;
  }
  .field .help { color: var(--fg-dim); font-size: 11.5px; margin-bottom: 5px; line-height: 1.4; }
  .field input[type=text], .field input[type=number], .field select, .field textarea {
    width: 100%; padding: 7px 9px;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;
    color: var(--fg); font: inherit;
  }
  .field input::placeholder, .field textarea::placeholder { color: var(--fg-faint); }
  .field input:focus, .field select:focus, .field textarea:focus {
    outline: none; border-color: var(--green);
  }
  .field textarea { resize: vertical; min-height: 66px; font-family: var(--mono); font-size: 12px; }
  .field.invalid input, .field.invalid textarea, .field.invalid select { border-color: var(--red); }
  .field .err { color: var(--red); font-size: 11.5px; margin-top: 4px; display: none; }
  .field.invalid .err { display: block; }
  .field.toggle { display: flex; align-items: flex-start; gap: 9px; }
  .field.toggle input { margin-top: 2px; width: 15px; height: 15px; accent-color: var(--green); flex: none; }
  .field.toggle .tlabel { flex: 1; }
  #claudemd-editor .field textarea { min-height: 200px; }
  #cmd-path { font-family: var(--mono); font-size: 11px; color: var(--fg-faint); }
  #settings-foot {
    display: flex; align-items: center; gap: 10px;
    padding: 13px 20px; border-top: 1px solid var(--line);
    position: sticky; bottom: 0; background: var(--panel); border-radius: 0 0 10px 10px;
  }
  #settings-foot .msg { flex: 1; font-size: 12px; color: var(--fg-dim); }
  #settings-foot .msg.ok { color: var(--green); }
  #settings-foot .msg.bad { color: var(--red); }
  #settings-foot button {
    padding: 7px 15px; border-radius: 6px; font-weight: 600; font-size: 12.5px;
    border: 1px solid var(--line); color: var(--fg-dim);
  }
  #settings-foot button:hover { color: var(--fg); border-color: var(--fg-faint); }
  #settings-foot button.primary {
    background: var(--green); color: #0b0d0e; border-color: var(--green);
  }
  #settings-foot button.primary:hover { color: #0b0d0e; }
  #settings-foot button:disabled { opacity: 0.5; cursor: default; }

  /* ── disconnected banner ── */
  #banner {
    display: none; padding: 5px 12px; font-size: 12px;
    background: rgba(224, 92, 92, 0.12); color: var(--red);
    border-bottom: 1px solid var(--line);
  }
  #banner.show { display: block; }

  /* ── layout ── */
  #main {
    display: grid;
    grid-template-columns: 240px 1fr 340px;
    height: calc(100vh - 38px);
  }
  body.banner-on #main { height: calc(100vh - 38px - 27px); }
  body.panel-hidden #main { grid-template-columns: 240px 1fr 0; }
  body.panel-hidden #right { display: none; }

  /* ── chats column ── */
  #chats { border-right: 1px solid var(--line); overflow-y: auto; }
  .chat {
    display: block; width: 100%; text-align: left;
    padding: 7px 10px; border-bottom: 1px solid var(--line);
  }
  .chat:hover { background: var(--panel-2); }
  .chat.sel { background: var(--panel-2); box-shadow: inset 2px 0 0 var(--green); }
  .chat .row1 { display: flex; align-items: baseline; gap: 6px; }
  .chat .name {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600;
  }
  .chat .ago { color: var(--fg-faint); font-size: 11px; flex: none; }
  .chat .kind {
    font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--fg-faint); border: 1px solid var(--line);
    border-radius: 3px; padding: 0 4px; flex: none;
  }
  .chat .kind.group { color: var(--fg-dim); }
  .chat .jid {
    font-family: var(--mono); font-size: 10px; color: var(--fg-faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* ── message history ── */
  #chatpane { display: flex; flex-direction: column; min-width: 0; }
  #chat-title {
    padding: 6px 12px; border-bottom: 1px solid var(--line);
    color: var(--fg-dim); font-size: 12px;
    display: flex; gap: 8px; align-items: baseline;
  }
  #chat-title .mono { font-family: var(--mono); font-size: 11px; color: var(--fg-faint); }
  #msgs { flex: 1; overflow-y: auto; padding: 10px 14px; }
  #msgs .empty { color: var(--fg-faint); padding: 30px; text-align: center; }
  .msg { max-width: 72%; margin: 3px 0; }
  .msg .bubble {
    display: inline-block; padding: 5px 9px; border-radius: 7px;
    background: var(--panel-2); white-space: pre-wrap; word-break: break-word;
  }
  .msg.me { margin-left: auto; text-align: right; }
  .msg.me .bubble {
    background: var(--green-dim); text-align: left;
    border: 1px solid rgba(37, 211, 102, 0.2);
  }
  .msg .who { font-size: 11px; color: var(--green); opacity: 0.85; }
  .msg .ts { font-size: 10px; color: var(--fg-faint); margin-top: 1px; }
  .msg .media { color: var(--fg-dim); font-style: italic; }

  /* ── compose ── */
  #compose {
    display: flex; gap: 8px; padding: 8px 12px;
    border-top: 1px solid var(--line); background: var(--panel);
  }
  #compose textarea {
    flex: 1; resize: none; height: 34px; padding: 7px 9px;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;
    color: var(--fg); font: inherit;
  }
  #compose textarea:focus { outline: none; border-color: var(--green); }
  #compose button {
    padding: 0 16px; border-radius: 6px; font-weight: 600;
    background: var(--green); color: #0b0d0e;
  }
  #compose button:disabled { background: var(--line); color: var(--fg-faint); cursor: default; }

  /* ── right panel: tasks + logs ── */
  #right {
    border-left: 1px solid var(--line);
    display: flex; flex-direction: column; min-width: 0;
  }
  #right h2 {
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--fg-faint); padding: 7px 10px 4px;
  }
  #tasks { flex: 1; overflow-y: auto; border-bottom: 1px solid var(--line); }
  .task { padding: 5px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
  .task .row1 { display: flex; gap: 6px; align-items: baseline; }
  .chip {
    font-family: var(--mono); font-size: 10px; text-transform: uppercase;
    padding: 0 5px; border-radius: 3px; flex: none;
  }
  .chip.running { color: var(--green); background: var(--green-dim); }
  .chip.done    { color: var(--fg-dim); background: var(--panel-2); }
  .chip.error   { color: var(--red); background: rgba(224,92,92,0.12); }
  .chip.timeout { color: var(--amber); background: rgba(217,164,65,0.12); }
  .task .chatname {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--fg);
  }
  .task .meta { color: var(--fg-faint); font-family: var(--mono); font-size: 10px; flex: none; }
  .task .preview {
    color: var(--fg-dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #logs {
    flex: 1; overflow-y: auto; padding: 6px 10px;
    font-family: var(--mono); font-size: 10.5px; line-height: 1.45;
    color: var(--fg-dim); white-space: pre-wrap; word-break: break-all;
  }

  /* ── token overlay ── */
  #token-overlay {
    position: fixed; inset: 0; display: none;
    align-items: center; justify-content: center;
    background: rgba(10, 11, 12, 0.9); z-index: 10;
  }
  #token-overlay.show { display: flex; }
  #token-box {
    width: 420px; padding: 22px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  }
  #token-box h1 { font-size: 15px; margin-bottom: 8px; }
  #token-box p { color: var(--fg-dim); font-size: 12px; margin-bottom: 12px; }
  #token-box code { font-family: var(--mono); color: var(--green); }
  #token-box input {
    width: 100%; padding: 8px 10px; margin-bottom: 10px;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;
    color: var(--fg); font-family: var(--mono);
  }
  #token-box input:focus { outline: none; border-color: var(--green); }
  #token-box button {
    width: 100%; padding: 8px; border-radius: 6px; font-weight: 600;
    background: var(--green); color: #0b0d0e;
  }
  #token-err { color: var(--red); font-size: 12px; margin-bottom: 8px; display: none; }
</style>
</head>
<body>

<!-- ══════════════════════════ MARKUP ══════════════════════════ -->

<div id="hdr">
  <span class="dot" id="dot"></span>
  <span id="state" class="kv">connecting…</span>
  <span id="me" class="kv mono"></span>
  <span class="kv">up <b id="uptime">–</b></span>
  <span class="kv">reconnects <b id="reconnects">–</b></span>
  <span class="badge zero" id="pending">queue 0</span>
  <span class="kv mono" id="provider"></span>
  <span class="spacer"></span>
  <button id="settings-btn" title="bridge settings">&#9881; settings</button>
  <button id="panel-toggle" title="toggle tasks/logs panel">tasks</button>
</div>

<div id="banner"></div>

<div id="main">
  <div id="chats"></div>

  <div id="chatpane">
    <div id="chat-title"><span id="chat-name">no chat selected</span><span class="mono" id="chat-jid"></span></div>
    <div id="msgs"><div class="empty">Select a chat on the left.</div></div>
    <div id="compose">
      <textarea id="input" placeholder="Message… (Enter to send, Shift+Enter for newline)" disabled></textarea>
      <button id="send" disabled>Send</button>
    </div>
  </div>

  <div id="right">
    <h2>Tasks</h2>
    <div id="tasks"><div class="task"><span class="meta">no tasks yet</span></div></div>
    <h2>Log tail</h2>
    <div id="logs"></div>
  </div>
</div>

<div id="token-overlay">
  <div id="token-box">
    <h1>Bridge API token</h1>
    <p>Paste the value of <code>WA_API_TOKEN</code> from the bridge&rsquo;s
       <code>.env</code> file. It is stored in this browser&rsquo;s localStorage
       and sent as <code>x-wa-token</code> on every request.</p>
    <div id="token-err">That token was rejected (401). Try again.</div>
    <input id="token-input" type="password" placeholder="WA_API_TOKEN" autocomplete="off">
    <button id="token-save">Unlock</button>
  </div>
</div>

<div id="settings-overlay">
  <div id="settings-box">
    <div id="settings-head">
      <h1>Bridge settings</h1>
      <button class="x" id="settings-close" title="close">&times;</button>
    </div>
    <div id="settings-body">
      <div id="settings-form"></div>
      <div class="ssection" id="claudemd-editor">
        <div class="sect-h">Project steering &mdash; CLAUDE.md</div>
        <div class="field">
          <label for="cmd-workdir">Project</label>
          <div class="help">The CLAUDE.md in this working dir is the standing instructions Claude Code reads before every task from that channel.</div>
          <select id="cmd-workdir"></select>
        </div>
        <div class="field">
          <label>Contents <span id="cmd-path"></span></label>
          <textarea id="cmd-content" placeholder="# CLAUDE.md&#10;&#10;Instructions Claude Code follows for tasks in this project…"></textarea>
          <div class="err" id="cmd-err"></div>
        </div>
        <div style="display:flex; gap:10px; align-items:center;">
          <button id="cmd-save" style="padding:6px 13px;border-radius:6px;border:1px solid var(--line);color:var(--fg-dim);font-weight:600;">Save CLAUDE.md</button>
          <span id="cmd-msg" style="font-size:12px;color:var(--fg-dim);"></span>
        </div>
      </div>
    </div>
    <div id="settings-foot">
      <span class="msg" id="settings-msg"></span>
      <button id="settings-savecancel">Close</button>
      <button id="settings-save">Save</button>
      <button id="settings-saverestart" class="primary">Save &amp; Restart</button>
    </div>
  </div>
</div>

<!-- ══════════════════════════ SCRIPT ══════════════════════════ -->
<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  /* ── token handling ──────────────────────────────────────────
     Token lives in localStorage; every fetch carries x-wa-token.
     A 401 clears it and re-opens the overlay. */
  var TOKEN_KEY = "wa-bridge-token";
  var token = localStorage.getItem(TOKEN_KEY) || "";

  function askToken(rejected) {
    $("token-err").style.display = rejected ? "block" : "none";
    $("token-overlay").classList.add("show");
    $("token-input").focus();
  }
  function saveToken() {
    var v = $("token-input").value.trim();
    if (!v) return;
    token = v;
    localStorage.setItem(TOKEN_KEY, v);
    $("token-overlay").classList.remove("show");
    $("token-input").value = "";
    boot();
  }
  $("token-save").addEventListener("click", saveToken);
  $("token-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") saveToken();
  });

  /* ── api helper ── */
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "x-wa-token": token }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        token = "";
        askToken(true);
        throw new Error("unauthorized");
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  /* ── small formatters ── */
  function ago(tsSec) {
    var d = Math.max(0, Math.floor(Date.now() / 1000) - tsSec);
    if (d < 60) return d + "s";
    if (d < 3600) return Math.floor(d / 60) + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h";
    return Math.floor(d / 86400) + "d";
  }
  function dur(ms) {
    if (ms < 1000) return ms + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    return Math.floor(ms / 60000) + "m" + Math.floor((ms % 60000) / 1000) + "s";
  }
  function hhmm(tsSec) {
    var d = new Date(tsSec * 1000);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ── header / status poll (also feeds the tasks panel) ── */
  function pollStatus() {
    api("/status").then(function (s) {
      var dot = $("dot"), state = $("state");
      if (s.loggedOut) {
        dot.className = "dot bad";
        state.textContent = "LOGGED OUT — delete auth/ and re-run npm start to re-link";
      } else if (s.connected) {
        dot.className = "dot ok";
        state.textContent = "connected";
      } else {
        dot.className = "dot warn";
        state.textContent = "reconnecting…";
      }
      $("me").textContent = s.me ? s.me.split("@")[0] : "";
      $("uptime").textContent = dur(s.uptimeSec * 1000);
      $("reconnects").textContent = s.reconnects;
      var p = $("pending");
      p.textContent = "queue " + s.pendingSends;
      p.className = "badge" + (s.pendingSends ? "" : " zero");
      $("provider").textContent = s.provider + (s.model ? ":" + s.model : "") + " @ " + s.workdir;

      var banner = $("banner");
      if (!s.connected && !s.loggedOut) {
        banner.textContent = "Bridge is not connected to WhatsApp — sends will queue until it reconnects.";
        banner.classList.add("show"); document.body.classList.add("banner-on");
      } else if (s.loggedOut) {
        banner.textContent = "Session logged out. Delete the auth/ folder and re-run npm start to scan a fresh QR.";
        banner.classList.add("show"); document.body.classList.add("banner-on");
      } else {
        banner.classList.remove("show"); document.body.classList.remove("banner-on");
      }
      renderTasks(s.tasks || []);
    }).catch(function (e) {
      if (e && e.message === "unauthorized") return; // 401 already re-prompted
      // Bridge process unreachable (crashed, stopped, port lost): show a
      // distinct grey state instead of freezing on the last successful
      // poll's "connected". Recovers automatically on the next success.
      $("dot").className = "dot";
      $("state").textContent = "bridge unreachable";
      var banner = $("banner");
      banner.textContent = "Dashboard cannot reach the bridge process — is it running?";
      banner.classList.add("show"); document.body.classList.add("banner-on");
    });
  }

  /* ── chats list ── */
  var selectedJid = null;
  var chatNames = {}; // jid -> display name

  function pollChats() {
    api("/chats").then(function (r) {
      var box = $("chats");
      box.textContent = "";
      (r.chats || []).forEach(function (c) {
        chatNames[c.jid] = c.name;
        var b = el("button", "chat" + (c.jid === selectedJid ? " sel" : ""));
        var row = el("div", "row1");
        row.appendChild(el("span", "name", c.name));
        row.appendChild(el("span", "kind " + c.kind, c.kind === "group" ? "grp" : "dm"));
        row.appendChild(el("span", "ago", ago(c.lastTs)));
        b.appendChild(row);
        b.appendChild(el("div", "jid", c.jid));
        b.addEventListener("click", function () { selectChat(c.jid, c.name); });
        box.appendChild(b);
      });
    }).catch(function () {});
  }

  /* ── history + sticky scroll ── */
  var stick = true; // auto-scroll unless the user scrolled up
  $("msgs").addEventListener("scroll", function () {
    var m = $("msgs");
    stick = m.scrollTop + m.clientHeight >= m.scrollHeight - 40;
  });

  function selectChat(jid, name) {
    selectedJid = jid;
    stick = true;
    $("chat-name").textContent = name || jid;
    $("chat-jid").textContent = jid;
    $("input").disabled = false;
    $("send").disabled = false;
    $("msgs").textContent = "";
    pollChats(); // refresh selection highlight
    loadHistory();
  }

  function loadHistory() {
    if (!selectedJid) return;
    var jid = selectedJid;
    api("/history?jid=" + encodeURIComponent(jid) + "&limit=100").then(function (r) {
      if (jid !== selectedJid) return; // user switched chats mid-flight
      renderMessages(r.messages || [], jid.slice(-5) === "@g.us");
    }).catch(function () {});
  }

  function renderMessages(msgs, isGroup) {
    var box = $("msgs");
    var prevTop = box.scrollTop; // clearing collapses scrollHeight — restore below
    box.textContent = "";
    // In-flight optimistic sends: keep them visible across rebuilds until the
    // server copy shows up in the store (match on fromMe+text within a time
    // window) or they age out after 30s — a slow send must not just vanish.
    var nowSec = Math.floor(Date.now() / 1000);
    pendingSends = pendingSends.filter(function (p) {
      if (nowSec - p.ts > 30) return false;
      if (p.jid !== selectedJid) return true;
      return !msgs.some(function (m) {
        return m.fromMe && m.text === p.text && Math.abs(m.ts - p.ts) < 120;
      });
    });
    var pending = pendingSends.filter(function (p) { return p.jid === selectedJid; });
    var failed = failedSends.filter(function (f) { return f.jid === selectedJid; });
    if (!msgs.length && !failed.length && !pending.length) {
      box.appendChild(el("div", "empty", "No stored history for this chat yet."));
      return;
    }
    msgs.forEach(function (m) {
      var w = el("div", "msg" + (m.fromMe ? " me" : ""));
      if (!m.fromMe && isGroup) w.appendChild(el("div", "who", m.sender));
      var b = el("div", "bubble");
      if (m.mediaType) b.appendChild(el("span", "media", "[" + m.mediaType + "] "));
      b.appendChild(document.createTextNode(m.text || ""));
      w.appendChild(b);
      w.appendChild(el("div", "ts", hhmm(m.ts)));
      box.appendChild(w);
    });
    pending.forEach(function (p) {
      var w = el("div", "msg me");
      var b = el("div", "bubble", p.text);
      b.style.opacity = "0.7";
      w.appendChild(b);
      w.appendChild(el("div", "ts", hhmm(p.ts) + " — sending…"));
      box.appendChild(w);
    });
    // Failed sends never reach the store, so the refresh would silently erase
    // them — re-append a persistent error row after every rebuild.
    failed.forEach(function (f) {
      var w = el("div", "msg me");
      var b = el("div", "bubble", f.text);
      b.style.opacity = "0.4";
      w.appendChild(b);
      var t = el("div", "ts", hhmm(f.ts) + " — failed to send: " + f.err);
      t.style.color = "var(--red)";
      w.appendChild(t);
      box.appendChild(w);
    });
    if (stick) box.scrollTop = box.scrollHeight;
    else box.scrollTop = prevTop; // don't yank a scrolled-up reader to the top
  }

  /* ── compose / send ── */
  var failedSends = [];  // {jid, text, ts, err} — survives history refreshes
  var pendingSends = []; // {jid, text, ts} — in flight; survives refreshes until the store copy appears (or 30s)
  function sendMessage() {
    var input = $("input");
    var text = input.value.trim();
    if (!text || !selectedJid) return;
    var jid = selectedJid;
    input.value = "";
    // optimistic append — refreshes re-render it from pendingSends until the
    // store copy appears, so a slow send never vanishes mid-flight
    var entry = { jid: jid, text: text, ts: Math.floor(Date.now() / 1000) };
    pendingSends.push(entry);
    if (pendingSends.length > 20) pendingSends.shift();
    var w = el("div", "msg me");
    var b = el("div", "bubble", text);
    w.appendChild(b);
    w.appendChild(el("div", "ts", hhmm(entry.ts)));
    $("msgs").appendChild(w);
    stick = true;
    $("msgs").scrollTop = $("msgs").scrollHeight;
    api("/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jid: jid, text: text }),
    }).catch(function (e) {
      var i = pendingSends.indexOf(entry);
      if (i >= 0) pendingSends.splice(i, 1);
      failedSends.push({ jid: jid, text: text, ts: entry.ts, err: e.message });
      if (failedSends.length > 20) failedSends.shift();
      loadHistory(); // surface the failure row promptly
    });
  }
  $("send").addEventListener("click", sendMessage);
  $("input").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  /* ── tasks panel (data arrives with /status) ── */
  function renderTasks(tasks) {
    var box = $("tasks");
    box.textContent = "";
    if (!tasks.length) {
      var t = el("div", "task");
      t.appendChild(el("span", "meta", "no tasks yet"));
      box.appendChild(t);
      return;
    }
    tasks.forEach(function (t) {
      var d = el("div", "task");
      var row = el("div", "row1");
      row.appendChild(el("span", "chip " + t.status, t.status));
      row.appendChild(el("span", "chatname", t.chatName || chatNames[t.jid] || t.jid));
      var ms = (t.endedAt || Date.now()) - t.startedAt;
      var meta = dur(ms) + (t.costUsd != null ? " $" + t.costUsd.toFixed(2) : "");
      row.appendChild(el("span", "meta", meta));
      d.appendChild(row);
      d.appendChild(el("div", "preview", t.kind + " · " + t.preview));
      box.appendChild(d);
    });
  }

  /* ── log tail ── */
  function pollLogs() {
    api("/logs?n=200").then(function (r) {
      var box = $("logs");
      var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
      box.textContent = (r.lines || []).join("\\n");
      if (atBottom) box.scrollTop = box.scrollHeight;
    }).catch(function () {});
  }

  /* ── right panel toggle ── */
  $("panel-toggle").addEventListener("click", function () {
    document.body.classList.toggle("panel-hidden");
  });

  /* ── settings panel ──────────────────────────────────────────
     Loads field defs + values from /config, renders a grouped form,
     edits the workdir CLAUDE.md, and saves via /config + /claudemd.
     "Save & Restart" POSTs /restart — the Tauri supervisor respawns
     the daemon, which reconnects from auth/ and picks up the changes. */
  var sFields = [];

  function openSettings() {
    $("settings-overlay").classList.add("show");
    setMsg("", "");
    loadConfig();
  }
  function closeSettings() { $("settings-overlay").classList.remove("show"); }
  function setMsg(text, kind) {
    var m = $("settings-msg");
    m.textContent = text || "";
    m.className = "msg" + (kind ? " " + kind : "");
  }

  function loadConfig() {
    api("/config").then(function (cfg) {
      sFields = cfg.fields || [];
      buildForm(sFields, cfg.values || {});
      var sel = $("cmd-workdir");
      sel.textContent = "";
      (cfg.workdirs || []).forEach(function (w) {
        var o = el("option", null, w);
        o.value = w;
        sel.appendChild(o);
      });
      if ((cfg.workdirs || []).length) loadClaudeMd(cfg.workdirs[0]);
    }).catch(function (e) {
      if (e && e.message === "unauthorized") return;
      setMsg("Could not load settings: " + e.message, "bad");
    });
  }

  function buildForm(fields, values) {
    var box = $("settings-form");
    box.textContent = "";
    var curGroup = null, section = null;
    fields.forEach(function (f) {
      if (f.group !== curGroup) {
        curGroup = f.group;
        section = el("div", "ssection");
        section.appendChild(el("div", "sect-h", f.group));
        box.appendChild(section);
      }
      var val = values[f.key] != null ? values[f.key] : "";
      var wrap = el("div", "field");
      wrap.id = "field-" + f.key;
      var control;
      if (f.type === "bool") {
        wrap.className = "field toggle";
        control = document.createElement("input");
        control.type = "checkbox";
        // Blank defaults to enabled for the two trigger/create bools (config.ts
        // uses "?? true"); reflect that so an untouched box isn't misleading.
        control.checked = val === "" ? true : String(val).toLowerCase() !== "false";
        control.id = "f-" + f.key;
        var tl = el("div", "tlabel");
        tl.appendChild(el("label", null, f.label));
        if (f.help) tl.appendChild(el("div", "help", f.help));
        wrap.appendChild(control);
        wrap.appendChild(tl);
      } else {
        wrap.appendChild(el("label", null, f.label));
        if (f.help) wrap.appendChild(el("div", "help", f.help));
        if (f.type === "select") {
          control = document.createElement("select");
          (f.options || []).forEach(function (opt) {
            var o = el("option", null, opt);
            o.value = opt;
            if (opt === val) o.selected = true;
            control.appendChild(o);
          });
        } else if (f.type === "textarea") {
          control = document.createElement("textarea");
          control.value = val;
          if (f.placeholder) control.placeholder = f.placeholder;
        } else {
          control = document.createElement("input");
          control.type = f.type === "number" ? "number" : "text";
          control.value = val;
          if (f.placeholder) control.placeholder = f.placeholder;
        }
        control.id = "f-" + f.key;
        wrap.appendChild(control);
      }
      var err = el("div", "err");
      err.id = "err-" + f.key;
      wrap.appendChild(err);
      section.appendChild(wrap);
    });
  }

  function collectValues() {
    var out = {};
    sFields.forEach(function (f) {
      var c = $("f-" + f.key);
      if (!c) return;
      out[f.key] = f.type === "bool" ? (c.checked ? "true" : "false") : c.value;
    });
    return out;
  }

  function clearErrors() {
    sFields.forEach(function (f) {
      var w = $("field-" + f.key);
      if (w) w.classList.remove("invalid");
    });
  }
  function showErrors(errors) {
    clearErrors();
    var first = null;
    Object.keys(errors || {}).forEach(function (k) {
      var w = $("field-" + k), e = $("err-" + k);
      if (w) { w.classList.add("invalid"); if (!first) first = w; }
      if (e) e.textContent = errors[k];
    });
    if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function saveSettings(restart) {
    clearErrors();
    setMsg("Saving…", "");
    var btns = ["settings-save", "settings-saverestart"];
    btns.forEach(function (id) { $(id).disabled = true; });
    // Raw fetch so we can read the body on a 400 (per-field validation errors).
    return fetch("/config", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wa-token": token },
      body: JSON.stringify({ values: collectValues() }),
    }).then(function (r) {
      if (r.status === 401) {
        localStorage.removeItem(TOKEN_KEY); token = ""; askToken(true);
        throw new Error("unauthorized");
      }
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (r) {
      if (r.status !== 200) {
        if (r.body && r.body.errors) { showErrors(r.body.errors); setMsg("Fix the highlighted fields.", "bad"); }
        else setMsg("Save failed (HTTP " + r.status + ").", "bad");
        return;
      }
      if (restart) {
        setMsg("Saved — restarting bridge…", "ok");
        return api("/restart", { method: "POST" }).catch(function () {})
          .then(function () { setTimeout(closeSettings, 1400); });
      }
      setMsg("Saved. Restart the bridge to apply.", "ok");
    }).catch(function (e) {
      if (!e || e.message !== "unauthorized") setMsg("Save failed: " + ((e && e.message) || "error"), "bad");
    }).then(function () {
      btns.forEach(function (id) { $(id).disabled = false; });
    });
  }

  /* ── CLAUDE.md editor ── */
  function loadClaudeMd(workdir) {
    $("cmd-msg").textContent = "";
    api("/claudemd?workdir=" + encodeURIComponent(workdir)).then(function (r) {
      $("cmd-content").value = r.content || "";
      $("cmd-path").textContent = r.path ? r.path : "";
    }).catch(function () {
      $("cmd-content").value = "";
      $("cmd-path").textContent = "";
    });
  }
  function saveClaudeMd() {
    var workdir = $("cmd-workdir").value;
    var msg = $("cmd-msg");
    msg.textContent = "Saving…"; msg.style.color = "var(--fg-dim)";
    api("/claudemd", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workdir: workdir, content: $("cmd-content").value }),
    }).then(function (r) {
      msg.textContent = "Saved " + (r.path || "CLAUDE.md");
      msg.style.color = "var(--green)";
    }).catch(function (e) {
      msg.textContent = "Save failed: " + (e.message || "error");
      msg.style.color = "var(--red)";
    });
  }

  $("settings-btn").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", closeSettings);
  $("settings-savecancel").addEventListener("click", closeSettings);
  $("settings-save").addEventListener("click", function () { saveSettings(false); });
  $("settings-saverestart").addEventListener("click", function () { saveSettings(true); });
  $("cmd-workdir").addEventListener("change", function () { loadClaudeMd(this.value); });
  $("cmd-save").addEventListener("click", saveClaudeMd);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && $("settings-overlay").classList.contains("show")) closeSettings();
  });

  /* ── boot + polling loops ── */
  var booted = false;
  function boot() {
    // Always refresh immediately — after a re-entered token the intervals
    // already run, but waiting them out (chats: 30s) looks broken.
    pollStatus(); pollChats(); pollLogs();
    if (booted) return;
    booted = true;
    setInterval(pollStatus, 5000);
    setInterval(pollChats, 30000);
    setInterval(pollLogs, 5000);
    setInterval(loadHistory, 4000); // ONLY refreshes the open chat
  }

  if (token) boot();
  else askToken(false);
})();
</script>
</body>
</html>
`;
