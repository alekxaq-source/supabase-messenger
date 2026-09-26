import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import * as E2E from "./crypto.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);
const EMOJIS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F525}", "\u{1F44E}", "\u{1F389}"];
const STATUS_EMOJIS = ["", "\u{1F60A}", "\u{1F4BB}", "\u{1F3AE}", "\u{1F4DA}", "\u{1F3A7}", "\u{1F634}", "\u2708\uFE0F", "\u{1F3C3}", "\u2615", "\u{1F525}", "\u{1F338}"];
const WALLPAPERS = [
  { name: "\u041d\u0435\u0442", css: "" },
  { name: "\u0421\u0438\u043d\u0438\u0439 \u0433\u0440\u0430\u0434\u0438\u0435\u043d\u0442", css: "linear-gradient(160deg,#1e3a8a,#0ea5e9)" },
  { name: "\u0417\u0430\u043a\u0430\u0442", css: "linear-gradient(160deg,#f97316,#db2777)" },
  { name: "\u041b\u0435\u0441", css: "linear-gradient(160deg,#14532d,#4ade80)" },
  { name: "\u041d\u043e\u0447\u044c", css: "linear-gradient(160deg,#0f172a,#334155)" },
  { name: "\u0421\u0438\u0440\u0435\u043d\u0435\u0432\u044b\u0439", css: "linear-gradient(160deg,#4c1d95,#a78bfa)" },
];
const TTLS = [0, 10, 60, 3600, 86400];
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

const prefs = {
  sound: localStorage.getItem("sound") !== "0",
  notify: localStorage.getItem("notify") !== "0",
  typing: localStorage.getItem("typingOn") !== "0",
  enter: localStorage.getItem("enterSend") !== "0",
  font: +(localStorage.getItem("fontSize") || 16),
};
function savePrefs() {
  localStorage.setItem("sound", prefs.sound ? "1" : "0");
  localStorage.setItem("notify", prefs.notify ? "1" : "0");
  localStorage.setItem("typingOn", prefs.typing ? "1" : "0");
  localStorage.setItem("enterSend", prefs.enter ? "1" : "0");
  localStorage.setItem("fontSize", String(prefs.font));
}

const state = {
  me: null,
  priv: null,
  convs: [],
  cs: new Map(),        // convId -> {muted,archived,pinned,draft,wallpaper}
  lastMsg: {},
  unread: {},
  activeId: null,
  msgs: new Map(),
  reactions: new Map(),
  pinned: new Map(),    // convId -> messageId
  saved: new Set(),
  blocked: new Set(),
  keys: new Map(),      // convId -> CryptoKey
  e2eOff: new Set(),    // convIds where user turned encryption off
  replyTo: null,
  online: new Set(),
  typingChannel: null,
  typingUsers: {},
  groupSelected: new Map(),
  profiles: new Map(),
  ttl: 0,
  showArchived: false,
  newCount: 0,
  images: [],
  imgIndex: 0,
};

/* ================= helpers ================= */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nameOf = (p) => p?.display_name || p?.username || "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c";
const initials = (s) => (s || "?").trim().slice(0, 1).toUpperCase();
const fmtTime = (d) => new Date(d).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const fmtDay = (d) => {
  const dt = new Date(d), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dt.toDateString() === now.toDateString()) return "\u0421\u0435\u0433\u043e\u0434\u043d\u044f";
  if (dt.toDateString() === y.toDateString()) return "\u0412\u0447\u0435\u0440\u0430";
  return dt.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: dt.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};
const fmtListTime = (d) => new Date(d).toDateString() === new Date().toDateString() ? fmtTime(d) : new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
const colorFor = (id = "") => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return "hsl(" + h + " 55% 45%)"; };

function toast(text, ms = 2300) {
  const t = $("toast"); t.textContent = text; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function setAvatar(el, label, seed, url, online = false) {
  if (!el) return;
  el.textContent = url ? "" : initials(label);
  el.style.background = url ? 'url("' + url + '") center/cover' : colorFor(seed || label);
  el.classList.toggle("online", !!online);
}
function cacheProfile(p) {
  if (!p?.id) return p;
  const ex = state.profiles.get(p.id);
  if (ex) { Object.assign(ex, p); return ex; }
  state.profiles.set(p.id, p); return p;
}
const profileById = (id) => state.profiles.get(id);
const activeConv = () => state.convs.find((c) => c.id === state.activeId);
const convById = (id) => state.convs.find((c) => c.id === id);
function otherMember(conv) {
  const m = conv.conversation_members.find((x) => x.user_id !== state.me.id);
  return m ? profileById(m.user_id) : null;
}
const convTitle = (conv) => conv.is_group ? (conv.title || "\u0413\u0440\u0443\u043f\u043f\u0430") : nameOf(otherMember(conv));
const settingsOf = (id) => state.cs.get(id) || {};
function lastSeenText(p) {
  if (!p) return "";
  if (state.online.has(p.id)) return "\u0432 \u0441\u0435\u0442\u0438";
  if (!p.last_seen_at) return "";
  return "\u0431\u044b\u043b(\u0430) " + fmtDay(p.last_seen_at).toLowerCase() + " \u0432 " + fmtTime(p.last_seen_at);
}
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }
function closeAllModals() { document.querySelectorAll(".modal,.lightbox").forEach((m) => m.classList.add("hidden")); }
document.querySelectorAll(".modal,.lightbox").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.classList.add("hidden"); });
});
function download(name, data, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
let audioCtx;
function beep() {
  if (!prefs.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 660; g.gain.value = 0.07;
    o.start(); o.stop(audioCtx.currentTime + 0.12);
  } catch (_) {}
}
/* prompt modal */
function ask(title, text = "", { value = "", password = false } = {}) {
  return new Promise((resolve) => {
    $("prompt-title").textContent = title;
    $("prompt-text").textContent = text;
    const inp = $("prompt-input");
    inp.type = password ? "password" : "text";
    inp.value = value;
    openModal("prompt-modal");
    setTimeout(() => inp.focus(), 50);
    const done = (v) => { $("prompt-ok").onclick = null; inp.onkeydown = null; closeModal("prompt-modal"); resolve(v); };
    $("prompt-ok").onclick = () => done(inp.value);
    inp.onkeydown = (e) => { if (e.key === "Enter") done(inp.value); };
    $("prompt-modal").addEventListener("click", function once(e) {
      if (e.target === $("prompt-modal") || e.target.closest("[data-close]")) { $("prompt-modal").removeEventListener("click", once); resolve(null); }
    });
  });
}
/* list modal */
function showList(title, items, { searchable = false, onSearch = null } = {}) {
  $("list-title").innerHTML = esc(title) + ' <button class="icon" data-close>\u2715</button>';
  const inp = $("list-input");
  inp.classList.toggle("hidden", !searchable);
  inp.value = "";
  renderListItems(items);
  if (searchable && onSearch) {
    let t;
    inp.oninput = () => { clearTimeout(t); t = setTimeout(async () => renderListItems(await onSearch(inp.value)), 280); };
    setTimeout(() => inp.focus(), 60);
  } else inp.oninput = null;
  openModal("list-modal");
}
function renderListItems(items) {
  const ul = $("list-body");
  ul.innerHTML = "";
  if (!items || !items.length) { ul.innerHTML = '<li class="muted small">\u041f\u0443\u0441\u0442\u043e</li>'; return; }
  for (const it of items) {
    const li = document.createElement("li");
    li.innerHTML = '<div class="ellipsis" style="flex:1"><div class="bold ellipsis">' + esc(it.title) + '</div><div class="muted small ellipsis">' + esc(it.sub || "") + "</div></div>" + (it.right || "");
    if (it.avatar !== undefined) {
      const av = document.createElement("div");
      av.className = "avatar sm";
      setAvatar(av, it.title, it.seed, it.avatar);
      li.prepend(av);
    }
    li.onclick = () => { if (it.keepOpen !== true) closeModal("list-modal"); it.onPick?.(); };
    ul.appendChild(li);
  }
}

/* ================= text rendering (markdown-lite) ================= */
function renderText(raw, query = "") {
  let s = esc(raw);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>");
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<span class="spoiler">$1</span>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|\s)@([a-z0-9_]{3,32})/g, '$1<span class="mention">@$2</span>');
  if (query) {
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    s = s.replace(re, (m) => "<mark>" + m + "</mark>");
  }
  return s;
}

/* ================= encryption ================= */
async function ensureIdentity() {
  if (!E2E.hasCrypto) return;
  let priv = E2E.loadPriv(state.me.id);
  if (!priv) {
    const id = await E2E.createIdentity();
    priv = id.priv;
    E2E.savePriv(state.me.id, priv);
  }
  state.priv = priv;
  const pub = await E2E.pubFromPriv(priv);
  if (state.me.public_key !== pub) {
    await sb.from("profiles").update({ public_key: pub }).eq("id", state.me.id);
    state.me.public_key = pub;
  }
  E2E.fingerprint(pub).then((f) => { $("set-fp").textContent = "\u041e\u0442\u043f\u0435\u0447\u0430\u0442\u043e\u043a \u0432\u0430\u0448\u0435\u0433\u043e \u043a\u043b\u044e\u0447\u0430: " + f; });
}
async function convKey(conv) {
  if (!conv || !E2E.hasCrypto || !state.priv) return null;
  if (state.keys.has(conv.id)) return state.keys.get(conv.id);
  let key = null;
  try {
    if (conv.is_group) {
      if (!conv.e2e || !conv.e2e_salt) return null;
      let pass = localStorage.getItem("gkey_" + conv.id);
      if (!pass) {
        pass = await ask("\u041f\u0430\u0440\u043e\u043b\u044c \u0448\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u0438\u044f \u0433\u0440\u0443\u043f\u043f\u044b", "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043e\u0431\u0449\u0438\u0439 \u043f\u0430\u0440\u043e\u043b\u044c \u044d\u0442\u043e\u0439 \u0433\u0440\u0443\u043f\u043f\u044b", { password: true });
        if (!pass) return null;
        localStorage.setItem("gkey_" + conv.id, pass);
      }
      key = await E2E.deriveGroupKey(pass, conv.e2e_salt);
    } else {
      const other = otherMember(conv);
      if (!other) return null;
      let pub = other.public_key;
      if (!pub) {
        const { data } = await sb.from("profiles").select("public_key").eq("id", other.id).maybeSingle();
        pub = data?.public_key;
        if (pub) other.public_key = pub;
      }
      if (!pub) return null;
      key = await E2E.deriveDmKey(state.priv, pub);
    }
  } catch (e) { console.warn("key error", e); return null; }
  if (key) state.keys.set(conv.id, key);
  return key;
}
const e2eEnabled = (conv) => !!conv && !state.e2eOff.has(conv.id);
async function decryptMessage(m) {
  if (!m.is_encrypted || m.plain !== undefined) return m;
  const conv = convById(m.conversation_id);
  const key = await convKey(conv);
  if (!key) { m.plain = null; return m; }
  try { m.plain = await E2E.decryptText(key, m.content); }
  catch (_) { m.plain = null; }
  return m;
}
function plainOf(m) {
  if (!m) return "";
  if (!m.is_encrypted) return m.content || "";
  if (m.plain) return m.plain;
  return "\u{1F512} \u0417\u0430\u0448\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u043d\u043e\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435";
}

/* ================= theme / settings ================= */
$("btn-theme").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  localStorage.setItem("theme", t);
};
$("btn-settings").onclick = () => {
  $("set-font").value = prefs.font;
  $("set-sound").checked = prefs.sound;
  $("set-notify").checked = prefs.notify;
  $("set-typing").checked = prefs.typing;
  $("set-enter").checked = prefs.enter;
  $("blocked-list").classList.add("hidden");
  openModal("settings-modal");
};
$("set-font").oninput = (e) => { prefs.font = +e.target.value; document.documentElement.style.fontSize = prefs.font + "px"; savePrefs(); };
$("set-sound").onchange = (e) => { prefs.sound = e.target.checked; savePrefs(); };
$("set-notify").onchange = (e) => { prefs.notify = e.target.checked; savePrefs(); if (prefs.notify && "Notification" in window) Notification.requestPermission(); };
$("set-typing").onchange = (e) => { prefs.typing = e.target.checked; savePrefs(); };
$("set-enter").onchange = (e) => { prefs.enter = e.target.checked; savePrefs(); };
$("set-key-export").onclick = () => {
  if (!state.priv) return toast("\u041a\u043b\u044e\u0447 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d");
  download("messenger-key-" + state.me.username + ".json", state.priv, "application/json");
  toast("\u041a\u043b\u044e\u0447 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d \u2014 \u0445\u0440\u0430\u043d\u0438\u0442\u0435 \u0435\u0433\u043e \u0432 \u0431\u0435\u0437\u043e\u043f\u0430\u0441\u043d\u043e\u043c \u043c\u0435\u0441\u0442\u0435");
};
$("set-key-import").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  const text = (await f.text()).trim();
  try { JSON.parse(text); } catch (_) { return toast("\u0424\u0430\u0439\u043b \u043a\u043b\u044e\u0447\u0430 \u043f\u043e\u0432\u0440\u0435\u0436\u0434\u0451\u043d"); }
  E2E.savePriv(state.me.id, text);
  state.keys.clear();
  await ensureIdentity();
  toast("\u041a\u043b\u044e\u0447 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d");
  if (state.activeId) openConversation(state.activeId);
};
$("set-key-new").onclick = async () => {
  if (!confirm("\u0421\u043e\u0437\u0434\u0430\u0442\u044c \u043d\u043e\u0432\u044b\u0439 \u043a\u043b\u044e\u0447? \u0421\u0442\u0430\u0440\u044b\u0435 \u0437\u0430\u0448\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f \u0441\u0442\u0430\u043d\u0443\u0442 \u043d\u0435\u0447\u0438\u0442\u0430\u0435\u043c\u044b\u043c\u0438.")) return;
  localStorage.removeItem("e2e_priv_" + state.me.id);
  state.priv = null; state.keys.clear();
  await ensureIdentity();
  toast("\u041d\u043e\u0432\u044b\u0439 \u043a\u043b\u044e\u0447 \u0441\u043e\u0437\u0434\u0430\u043d");
};
$("set-password").onclick = async () => {
  const p = await ask("\u041d\u043e\u0432\u044b\u0439 \u043f\u0430\u0440\u043e\u043b\u044c", "\u041c\u0438\u043d\u0438\u043c\u0443\u043c 6 \u0441\u0438\u043c\u0432\u043e\u043b\u043e\u0432", { password: true });
  if (!p) return;
  const { error } = await sb.auth.updateUser({ password: p });
  toast(error ? error.message : "\u041f\u0430\u0440\u043e\u043b\u044c \u0438\u0437\u043c\u0435\u043d\u0451\u043d");
};
$("set-blocked").onclick = async () => {
  const ul = $("blocked-list");
  ul.classList.remove("hidden");
  ul.innerHTML = '<li class="muted small">\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430\u2026</li>';
  const { data } = await sb.from("blocks").select("blocked");
  const ids = (data || []).map((b) => b.blocked);
  if (!ids.length) { ul.innerHTML = '<li class="muted small">\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442</li>'; return; }
  const { data: profs } = await sb.from("profiles").select("id,username,display_name,avatar_url").in("id", ids);
  ul.innerHTML = "";
  for (const p of profs || []) {
    cacheProfile(p);
    const li = document.createElement("li");
    li.innerHTML = '<div class="ellipsis" style="flex:1"><div class="bold">' + esc(nameOf(p)) + '</div><div class="muted small">@' + esc(p.username) + '</div></div><span class="chip-btn small">\u0420\u0430\u0437\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u0442\u044c</span>';
    li.onclick = async () => { await unblockUser(p.id); li.remove(); };
    ul.appendChild(li);
  }
};
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; $("set-install").classList.remove("hidden"); });
$("set-install").onclick = async () => { if (installEvent) { installEvent.prompt(); installEvent = null; $("set-install").classList.add("hidden"); } };
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* ================= auth ================= */
let mode = "login";
function setMode(m) {
  mode = m;
  $("tab-login").classList.toggle("active", m === "login");
  $("tab-signup").classList.toggle("active", m === "signup");
  $("auth-username").classList.toggle("hidden", m === "login");
  $("auth-submit").textContent = m === "login" ? "\u0412\u043e\u0439\u0442\u0438" : "\u0417\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043e\u0432\u0430\u0442\u044c\u0441\u044f";
  $("auth-msg").textContent = "";
}
$("tab-login").onclick = () => setMode("login");
$("tab-signup").onclick = () => setMode("signup");
$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const msg = $("auth-msg");
  msg.textContent = "\u2026";
  if (mode === "signup") {
    const username = $("auth-username").value.trim().toLowerCase().replace(/^@/, "");
    if (!USERNAME_RE.test(username)) { msg.textContent = "ID: \u0442\u043e\u043b\u044c\u043a\u043e a-z, 0-9 \u0438 _, \u043e\u0442 3 \u0434\u043e 32 \u0441\u0438\u043c\u0432\u043e\u043b\u043e\u0432"; return; }
    const { data: free } = await sb.rpc("username_available", { name: username });
    if (free === false) { msg.textContent = "\u042d\u0442\u043e\u0442 ID \u0443\u0436\u0435 \u0437\u0430\u043d\u044f\u0442"; return; }
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { username, display_name: username }, emailRedirectTo: location.href.split("#")[0] },
    });
    if (error) { msg.textContent = error.message; return; }
    if (!data.session) msg.textContent = "\u0413\u043e\u0442\u043e\u0432\u043e! \u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435 email \u043f\u043e \u0441\u0441\u044b\u043b\u043a\u0435 \u0438\u0437 \u043f\u0438\u0441\u044c\u043c\u0430, \u0437\u0430\u0442\u0435\u043c \u0432\u043e\u0439\u0434\u0438\u0442\u0435.";
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) msg.textContent = error.message === "Email not confirmed" ? "Email \u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043d" : "\u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 email \u0438\u043b\u0438 \u043f\u0430\u0440\u043e\u043b\u044c";
  }
};
$("btn-forgot").onclick = async () => {
  const email = $("auth-email").value.trim();
  if (!email) return toast("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 email \u0432\u044b\u0448\u0435");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0] });
  toast(error ? error.message : "\u041f\u0438\u0441\u044c\u043c\u043e \u0434\u043b\u044f \u0441\u0431\u0440\u043e\u0441\u0430 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e");
};
$("btn-logout").onclick = async () => {
  if (!confirm("\u0412\u044b\u0439\u0442\u0438 \u0438\u0437 \u0430\u043a\u043a\u0430\u0443\u043d\u0442\u0430?")) return;
  await touchLastSeen();
  await sb.auth.signOut();
  location.reload();
};

let started = false;
sb.auth.onAuthStateChange((_evt, session) => {
  if (session && !started) { started = true; setTimeout(() => start(session.user), 0); }
  if (!session) { $("auth").classList.remove("hidden"); $("app").classList.add("hidden"); }
});

/* ================= boot ================= */
async function start(user) {
  let { data: me } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!me) {
    await new Promise((r) => setTimeout(r, 900));
    ({ data: me } = await sb.from("profiles").select("*").eq("id", user.id).single());
  }
  state.me = cacheProfile(me);
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderMe();
  await ensureIdentity();
  await Promise.all([loadSettings(), loadBlocks(), loadSaved()]);
  await loadConversations();
  subscribeRealtime();
  subscribePresence();
  touchLastSeen();
  setInterval(touchLastSeen, 60000);
  setInterval(() => sb.rpc("purge_expired").then(() => {}), 45000);
  setInterval(dropExpiredLocally, 5000);
  handleHash();
}
function touchLastSeen() {
  if (!state.me) return;
  return sb.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", state.me.id);
}
function renderMe() {
  const me = state.me;
  $("me-name").textContent = nameOf(me);
  $("me-emoji").textContent = me.status_emoji || "";
  $("me-username").textContent = "@" + me.username;
  setAvatar($("me-avatar"), nameOf(me), me.id, me.avatar_url);
}
async function loadSettings() {
  const { data } = await sb.from("conv_settings").select("*");
  state.cs = new Map((data || []).map((r) => [r.conversation_id, r]));
}
async function saveSetting(convId, patch) {
  const cur = settingsOf(convId);
  const row = { user_id: state.me.id, conversation_id: convId, muted: !!cur.muted, archived: !!cur.archived, pinned: !!cur.pinned, draft: cur.draft ?? null, wallpaper: cur.wallpaper ?? null, ...patch, updated_at: new Date().toISOString() };
  state.cs.set(convId, row);
  await sb.from("conv_settings").upsert(row, { onConflict: "user_id,conversation_id" });
}
async function loadBlocks() {
  const { data } = await sb.from("blocks").select("blocked");
  state.blocked = new Set((data || []).map((b) => b.blocked));
}
async function loadSaved() {
  const { data } = await sb.from("saved_messages").select("message_id");
  state.saved = new Set((data || []).map((s) => s.message_id));
}

/* ================= my profile ================= */
let pendingAvatar;
$("btn-my-profile").onclick = () => {
  const me = state.me;
  pendingAvatar = undefined;
  $("pf-name").value = me.display_name || "";
  $("pf-username").value = me.username;
  $("pf-bio").value = me.bio || "";
  $("pf-uuid").textContent = me.id;
  $("pf-msg").textContent = "";
  $("pf-username-hint").textContent = "a-z, 0-9, _ \u2014 \u043e\u0442 3 \u0434\u043e 32 \u0441\u0438\u043c\u0432\u043e\u043b\u043e\u0432";
  $("pf-username-hint").className = "small muted";
  setAvatar($("pf-avatar"), nameOf(me), me.id, me.avatar_url);
  renderEmojiRow(me.status_emoji || "");
  openModal("profile-modal");
};
let chosenEmoji = "";
function renderEmojiRow(sel) {
  chosenEmoji = sel || "";
  const box = $("pf-emoji-row");
  box.innerHTML = "";
  for (const e of STATUS_EMOJIS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn" + (e === chosenEmoji ? " bold" : "");
    b.textContent = e || "\u2014";
    b.onclick = () => renderEmojiRow(e);
    box.appendChild(b);
  }
}
$("pf-copy-uuid").onclick = () => { navigator.clipboard.writeText(state.me.id); toast("ID \u0441\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d"); };
$("pf-share").onclick = () => {
  const link = location.href.split("#")[0] + "#u=" + state.me.username;
  navigator.clipboard.writeText(link);
  toast("\u0421\u0441\u044b\u043b\u043a\u0430-\u043f\u0440\u0438\u0433\u043b\u0430\u0448\u0435\u043d\u0438\u0435 \u0441\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d\u0430");
};
$("pf-qr").onclick = () => {
  const link = location.href.split("#")[0] + "#u=" + state.me.username;
  $("lb-img").src = "https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=" + encodeURIComponent(link);
  $("lb-download").href = $("lb-img").src;
  $("lightbox").classList.remove("hidden");
};
$("pf-avatar-input").onchange = (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (!f.type.startsWith("image/")) return toast("\u041d\u0443\u0436\u043d\u0430 \u043a\u0430\u0440\u0442\u0438\u043d\u043a\u0430");
  if (f.size > 5 * 1024 * 1024) return toast("\u041c\u0430\u043a\u0441\u0438\u043c\u0443\u043c 5 \u041c\u0411");
  pendingAvatar = f;
  setAvatar($("pf-avatar"), "", "", URL.createObjectURL(f));
};
$("pf-avatar-remove").onclick = () => { pendingAvatar = null; setAvatar($("pf-avatar"), $("pf-name").value || state.me.username, state.me.id, null); };
let unameTimer;
$("pf-username").oninput = (e) => {
  const hint = $("pf-username-hint");
  const v = e.target.value.trim().toLowerCase().replace(/^@/, "");
  clearTimeout(unameTimer);
  if (v === state.me.username) { hint.textContent = "\u042d\u0442\u043e \u0432\u0430\u0448 \u0442\u0435\u043a\u0443\u0449\u0438\u0439 ID"; hint.className = "small muted"; return; }
  if (!USERNAME_RE.test(v)) { hint.textContent = "\u0422\u043e\u043b\u044c\u043a\u043e a-z, 0-9 \u0438 _, \u043e\u0442 3 \u0434\u043e 32 \u0441\u0438\u043c\u0432\u043e\u043b\u043e\u0432"; hint.className = "small err"; return; }
  hint.textContent = "\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e\u2026"; hint.className = "small muted";
  unameTimer = setTimeout(async () => {
    const { data: free } = await sb.rpc("username_available", { name: v });
    hint.textContent = free ? "@" + v + " \u0441\u0432\u043e\u0431\u043e\u0434\u0435\u043d \u2713" : "@" + v + " \u0443\u0436\u0435 \u0437\u0430\u043d\u044f\u0442";
    hint.className = "small " + (free ? "ok" : "err");
  }, 350);
};
$("pf-save").onclick = async () => {
  const msg = $("pf-msg");
  const username = $("pf-username").value.trim().toLowerCase().replace(/^@/, "");
  const display_name = $("pf-name").value.trim() || username;
  const bio = $("pf-bio").value.trim() || null;
  if (!USERNAME_RE.test(username)) { msg.textContent = "\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u044b\u0439 ID"; return; }
  msg.textContent = "\u0421\u043e\u0445\u0440\u0430\u043d\u044f\u044e\u2026";
  const update = { display_name, bio, username, status_emoji: chosenEmoji || null };
  if (pendingAvatar instanceof File) {
    const ext = (pendingAvatar.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = state.me.id + "/avatar-" + Date.now() + "." + ext;
    const { error } = await sb.storage.from("avatars").upload(path, pendingAvatar, { contentType: pendingAvatar.type, upsert: true });
    if (error) { msg.textContent = "\u041e\u0448\u0438\u0431\u043a\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438 \u0444\u043e\u0442\u043e: " + error.message; return; }
    update.avatar_url = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  } else if (pendingAvatar === null) update.avatar_url = null;
  const { data, error } = await sb.from("profiles").update(update).eq("id", state.me.id).select().single();
  if (error) { msg.textContent = error.code === "23505" ? "\u042d\u0442\u043e\u0442 ID \u0443\u0436\u0435 \u0437\u0430\u043d\u044f\u0442" : error.message; return; }
  cacheProfile(data);
  renderMe(); renderConvList(); renderChatHeader();
  closeModal("profile-modal");
  toast("\u041f\u0440\u043e\u0444\u0438\u043b\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d");
};

/* ================= other user profile ================= */
async function showUser(userId) {
  if (userId === state.me.id) return $("btn-my-profile").click();
  const { data } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
  const p = data ? cacheProfile(data) : profileById(userId);
  if (!p) return toast("\u041f\u0440\u043e\u0444\u0438\u043b\u044c \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d");
  setAvatar($("up-avatar"), nameOf(p), p.id, p.avatar_url, state.online.has(p.id));
  $("up-name").textContent = nameOf(p);
  $("up-emoji").textContent = p.status_emoji || "";
  $("up-username").textContent = "@" + p.username;
  $("up-status").textContent = lastSeenText(p);
  $("up-bio").textContent = p.bio || "";
  $("up-fp").textContent = "";
  if (p.public_key) E2E.fingerprint(p.public_key).then((f) => { $("up-fp").textContent = "\u041a\u043b\u044e\u0447: " + f; });
  const blocked = state.blocked.has(p.id);
  $("up-block").textContent = blocked ? "\u2705 \u0420\u0430\u0437\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u0442\u044c" : "\u{1F6AB} \u0411\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u0442\u044c";
  $("up-block").onclick = async () => { blocked ? await unblockUser(p.id) : await blockUser(p.id); closeModal("user-modal"); };
  const dm = state.convs.find((c) => !c.is_group && c.conversation_members.some((m) => m.user_id === userId));
  $("up-delete-chat").classList.toggle("hidden", !dm);
  $("up-message").onclick = async () => { closeModal("user-modal"); await startDm(userId); };
  $("up-delete-chat").onclick = async () => {
    if (!confirm("\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u044d\u0442\u043e\u0442 \u0447\u0430\u0442 \u0443 \u0441\u0435\u0431\u044f?")) return;
    await leaveConversation(dm.id);
    closeModal("user-modal");
  };
  openModal("user-modal");
}
async function blockUser(id) {
  const { error } = await sb.from("blocks").insert({ blocker: state.me.id, blocked: id });
  if (error && error.code !== "23505") return toast(error.message);
  state.blocked.add(id);
  renderConvList();
  if (state.activeId) renderAllMessages();
  toast("\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d");
}
async function unblockUser(id) {
  await sb.from("blocks").delete().eq("blocker", state.me.id).eq("blocked", id);
  state.blocked.delete(id);
  renderConvList();
  if (state.activeId) renderAllMessages();
  toast("\u0420\u0430\u0437\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d");
}

/* ================= conversations ================= */
async function loadConversations() {
  const { data, error } = await sb
    .from("conversations")
    .select("id,is_group,title,last_message_at,created_by,e2e,e2e_salt,conversation_members(user_id,role,last_read_at,profiles(id,username,display_name,avatar_url,last_seen_at,bio,status_emoji,public_key))")
    .order("last_message_at", { ascending: false });
  if (error) { console.error(error); toast("\u041e\u0448\u0438\u0431\u043a\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438 \u0447\u0430\u0442\u043e\u0432"); return; }
  data.forEach((c) => c.conversation_members.forEach((m) => { if (m.profiles) cacheProfile(m.profiles); delete m.profiles; }));
  state.convs = data;
  await Promise.all(data.map(refreshConvMeta));
  await loadPinnedAll();
  renderConvList();
  if (state.activeId && !activeConv()) closeChat();
}
async function refreshConvMeta(conv) {
  const my = conv.conversation_members.find((m) => m.user_id === state.me.id);
  const [{ data: last }, { count }] = await Promise.all([
    sb.from("messages").select("*").eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("messages").select("id", { count: "exact", head: true })
      .eq("conversation_id", conv.id).neq("sender_id", state.me.id).gt("created_at", my?.last_read_at || "1970-01-01"),
  ]);
  state.lastMsg[conv.id] = last || null;
  state.unread[conv.id] = conv.id === state.activeId ? 0 : count || 0;
}
async function loadPinnedAll() {
  const { data } = await sb.from("pinned_messages").select("conversation_id,message_id");
  state.pinned = new Map((data || []).map((p) => [p.conversation_id, p.message_id]));
}
function visibleConvs() {
  return state.convs.filter((c) => {
    const s = settingsOf(c.id);
    if (!!s.archived !== state.showArchived) return false;
    if (!c.is_group) {
      const o = otherMember(c);
      if (o && state.blocked.has(o.id)) return false;
    }
    return true;
  }).sort((a, b) => {
    const pa = settingsOf(a.id).pinned ? 1 : 0, pb = settingsOf(b.id).pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return new Date(b.last_message_at) - new Date(a.last_message_at);
  });
}
function previewOf(conv) {
  const last = state.lastMsg[conv.id];
  if (!last) return "\u041d\u0435\u0442 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0439";
  let p = last.is_encrypted ? "\u{1F512} \u0417\u0430\u0448\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u043e" : (last.kind === "voice" ? "\u{1F3A4} \u0413\u043e\u043b\u043e\u0441\u043e\u0432\u043e\u0435" : (last.content || "\u{1F4CE} \u0412\u043b\u043e\u0436\u0435\u043d\u0438\u0435"));
  if (last.sender_id === state.me.id) p = "\u0412\u044b: " + p;
  else if (conv.is_group) p = nameOf(profileById(last.sender_id)) + ": " + p;
  return p;
}
function renderConvList() {
  const ul = $("conv-list");
  ul.innerHTML = "";
  const list = visibleConvs();
  if (!list.length) {
    ul.innerHTML = '<li class="muted small" style="cursor:default">' + (state.showArchived ? "\u0410\u0440\u0445\u0438\u0432 \u043f\u0443\u0441\u0442" : "\u041f\u043e\u043a\u0430 \u043d\u0435\u0442 \u0447\u0430\u0442\u043e\u0432. \u041d\u0430\u0439\u0434\u0438\u0442\u0435 \u0447\u0435\u043b\u043e\u0432\u0435\u043a\u0430 \u0432\u044b\u0448\u0435.") + "</li>";
  }
  let total = 0;
  for (const c of list) {
    const s = settingsOf(c.id);
    const li = document.createElement("li");
    if (c.id === state.activeId) li.classList.add("active");
    const last = state.lastMsg[c.id];
    const other = otherMember(c);
    const title = convTitle(c);
    const unread = s.muted ? 0 : (state.unread[c.id] || 0);
    total += unread;
    const tags = (c.is_group ? '<span class="tag">\u0433\u0440\u0443\u043f\u043f\u0430</span>' : "") +
      (s.pinned ? '<span class="tag">\u{1F4CC}</span>' : "") + (s.muted ? '<span class="tag">\u{1F507}</span>' : "") +
      ((c.is_group ? c.e2e : !!other?.public_key) ? '<span class="tag">\u{1F512}</span>' : "");
    li.innerHTML = '<div class="avatar"></div><div class="conv-info">' +
      '<div class="conv-top"><span class="bold ellipsis">' + esc(title) + " " + tags + '</span><span class="muted small">' + (last ? fmtListTime(last.created_at) : "") + "</span></div>" +
      '<div class="conv-top"><span class="muted small ellipsis">' + esc(previewOf(c)) + "</span>" + (unread ? '<span class="badge">' + unread + "</span>" : "") + "</div></div>";
    setAvatar(li.querySelector(".avatar"), title, c.is_group ? c.id : other?.id, c.is_group ? null : other?.avatar_url, !c.is_group && other && state.online.has(other.id));
    li.onclick = () => openConversation(c.id);
    ul.appendChild(li);
  }
  document.title = total ? "(" + total + ") Messenger" : "Messenger";
}
async function leaveConversation(convId) {
  const { error } = await sb.from("conversation_members").delete().eq("conversation_id", convId).eq("user_id", state.me.id);
  if (error) return toast(error.message);
  state.convs = state.convs.filter((c) => c.id !== convId);
  if (state.activeId === convId) closeChat();
  renderConvList();
}
$("btn-archive").onclick = () => {
  state.showArchived = !state.showArchived;
  $("btn-archive").classList.toggle("bold", state.showArchived);
  renderConvList();
  toast(state.showArchived ? "\u041f\u043e\u043a\u0430\u0437\u0430\u043d \u0430\u0440\u0445\u0438\u0432" : "\u041e\u0431\u044b\u0447\u043d\u044b\u0435 \u0447\u0430\u0442\u044b");
};

/* ================= search users / DM ================= */
async function searchUsers(q) {
  q = q.trim().replace(/^@/, "").replace(/[%,()*]/g, "");
  if (!q) return [];
  const { data } = await sb.from("profiles").select("id,username,display_name,avatar_url,last_seen_at,bio,status_emoji,public_key")
    .or("username.ilike.%" + q + "%,display_name.ilike.%" + q + "%")
    .neq("id", state.me.id).limit(15);
  return (data || []).map(cacheProfile);
}
function renderUserList(ul, users, onPick, extra) {
  ul.innerHTML = "";
  if (!users.length) { ul.innerHTML = '<li class="muted small">\u041d\u0438\u043a\u043e\u0433\u043e \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e</li>'; return; }
  for (const u of users) {
    const li = document.createElement("li");
    li.innerHTML = '<div class="avatar sm"></div><div class="ellipsis" style="flex:1"><div class="bold ellipsis">' + esc(nameOf(u)) + " " + (u.status_emoji || "") + '</div><div class="muted small">@' + esc(u.username) + "</div></div>" + (extra ? extra(u) : "");
    setAvatar(li.querySelector(".avatar"), nameOf(u), u.id, u.avatar_url, state.online.has(u.id));
    li.onclick = (e) => onPick(u, e);
    ul.appendChild(li);
  }
}
async function startDm(userId) {
  const { data: convId, error } = await sb.rpc("get_or_create_dm", { other_user: userId });
  if (error) return toast(error.message);
  if (!convById(convId)) await loadConversations();
  openConversation(convId);
}
let searchTimer;
$("user-search").oninput = (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  const ul = $("search-results");
  if (!q.trim()) { ul.classList.add("hidden"); return; }
  searchTimer = setTimeout(async () => {
    const users = await searchUsers(q);
    ul.classList.remove("hidden");
    renderUserList(ul, users, (u) => { ul.classList.add("hidden"); $("user-search").value = ""; showUser(u.id); });
  }, 250);
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search")) $("search-results").classList.add("hidden");
  if (!e.target.closest("#emoji-picker") && !e.target.closest('[data-a="react"]')) hideEmojiPicker();
  if (!e.target.closest("#chat-menu") && e.target.id !== "btn-chat-menu") $("chat-menu").classList.add("hidden");
});

/* ================= groups ================= */
$("btn-new-group").onclick = () => {
  state.groupSelected.clear();
  $("group-title").value = ""; $("group-search").value = "";
  $("group-results").innerHTML = ""; renderChips();
  openModal("group-modal");
  $("group-title").focus();
};
let groupTimer;
$("group-search").oninput = (e) => {
  clearTimeout(groupTimer);
  groupTimer = setTimeout(async () => {
    const users = await searchUsers(e.target.value);
    renderUserList($("group-results"), users, (u) => { state.groupSelected.set(u.id, u); renderChips(); });
  }, 250);
};
function renderChips() {
  const box = $("group-selected");
  box.innerHTML = "";
  for (const u of state.groupSelected.values()) {
    const s = document.createElement("span");
    s.className = "chip-btn"; s.textContent = nameOf(u) + " \u2715";
    s.onclick = () => { state.groupSelected.delete(u.id); renderChips(); };
    box.appendChild(s);
  }
}
$("group-create").onclick = async () => {
  const title = $("group-title").value.trim();
  if (!title) return toast("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435");
  if (!state.groupSelected.size) return toast("\u0414\u043e\u0431\u0430\u0432\u044c\u0442\u0435 \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u043e\u0432");
  const { data: convId, error } = await sb.rpc("create_group", { group_title: title, member_ids: [...state.groupSelected.keys()] });
  if (error) return toast(error.message);
  closeModal("group-modal");
  await loadConversations();
  openConversation(convId);
};
function showGroupInfo() {
  const conv = activeConv();
  if (!conv) return;
  $("gi-title").value = conv.title || "";
  $("gi-add-search").value = "";
  $("gi-add-results").innerHTML = "";
  renderGroupMembers();
  openModal("ginfo-modal");
}
function renderGroupMembers() {
  const conv = activeConv();
  if (!conv) return;
  const members = conv.conversation_members.map((m) => ({ ...profileById(m.user_id), role: m.role, id: m.user_id }));
  $("gi-count").textContent = "(" + members.length + ")";
  renderUserList($("gi-members"), members, (u) => { closeModal("ginfo-modal"); showUser(u.id); },
    (u) => (u.role === "owner" ? '<span class="tag">\u0441\u043e\u0437\u0434\u0430\u0442\u0435\u043b\u044c</span>' : "") + (u.id === state.me.id ? '<span class="tag">\u0432\u044b</span>' : "") + (state.online.has(u.id) ? '<span class="small muted">\u0432 \u0441\u0435\u0442\u0438</span>' : ""));
}
$("gi-rename").onclick = async () => {
  const title = $("gi-title").value.trim();
  if (!title) return;
  const { error } = await sb.from("conversations").update({ title }).eq("id", state.activeId);
  if (error) return toast(error.message);
  activeConv().title = title;
  renderChatHeader(); renderConvList(); toast("\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u043e");
};
let giTimer;
$("gi-add-search").oninput = (e) => {
  clearTimeout(giTimer);
  giTimer = setTimeout(async () => {
    const conv = activeConv();
    if (!conv) return;
    const ids = new Set(conv.conversation_members.map((m) => m.user_id));
    const users = (await searchUsers(e.target.value)).filter((u) => !ids.has(u.id));
    renderUserList($("gi-add-results"), users, async (u) => {
      const { error } = await sb.rpc("add_group_members", { conv: conv.id, member_ids: [u.id] });
      if (error) return toast(error.message);
      conv.conversation_members.push({ user_id: u.id, role: "member", last_read_at: new Date(0).toISOString() });
      $("gi-add-search").value = ""; $("gi-add-results").innerHTML = "";
      renderGroupMembers(); renderChatHeader();
      toast(nameOf(u) + " \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d(\u0430)");
    }, () => '<span class="small">\u2795</span>');
  }, 250);
};
$("gi-leave").onclick = async () => {
  if (!confirm("\u041f\u043e\u043a\u0438\u043d\u0443\u0442\u044c \u0433\u0440\u0443\u043f\u043f\u0443?")) return;
  const id = state.activeId;
  closeModal("ginfo-modal");
  await leaveConversation(id);
};

/* ================= chat ================= */
async function openConversation(id, jumpMsgId) {
  const conv = convById(id);
  if (!conv) return;
  state.activeId = id;
  state.unread[id] = 0;
  state.newCount = 0;
  updateNewCount();
  state.msgs.clear(); state.reactions.clear();
  setReply(null);
  closeChatSearch();
  $("app").classList.add("in-chat");
  $("chat-empty").classList.add("hidden");
  $("chat-view").classList.remove("hidden");
  applyWallpaper(settingsOf(id).wallpaper);
  renderChatHeader();
  renderConvList();
  const draft = settingsOf(id).draft || "";
  $("msg-input").value = draft; autoGrow();

  const box = $("messages");
  box.innerHTML = '<div class="empty">\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430\u2026</div>';
  const { data: msgs } = await sb.from("messages").select("*").eq("conversation_id", id)
    .order("created_at", { ascending: false }).limit(300);
  if (state.activeId !== id) return;
  const list = (msgs || []).reverse();
  list.forEach((m) => state.msgs.set(m.id, m));
  if (list.length) {
    const ids = list.map((m) => m.id);
    const { data: reacts } = await sb.from("message_reactions").select("message_id,user_id,emoji").in("message_id", ids);
    (reacts || []).forEach(addReactionToState);
  }
  await Promise.all(list.filter((m) => m.is_encrypted).map(decryptMessage));
  if (state.activeId !== id) return;
  renderAllMessages();
  box.scrollTop = box.scrollHeight;
  markRead(id);
  joinTypingChannel(id);
  renderPinnedBar();
  if (jumpMsgId) setTimeout(() => jumpTo(jumpMsgId), 250);
  if (matchMedia("(min-width: 721px)").matches) $("msg-input").focus();
}
function closeChat() {
  state.activeId = null;
  $("app").classList.remove("in-chat");
  $("chat-view").classList.add("hidden");
  $("chat-empty").classList.remove("hidden");
  leaveTypingChannel();
  renderConvList();
}
$("btn-back").onclick = closeChat;
function applyWallpaper(css) {
  $("messages").style.background = css || "";
}
async function renderChatHeader() {
  const conv = activeConv();
  if (!conv) return;
  const other = otherMember(conv);
  const title = convTitle(conv);
  $("chat-title").textContent = title;
  if (conv.is_group) {
    const n = conv.conversation_members.length;
    const on = conv.conversation_members.filter((m) => state.online.has(m.user_id)).length;
    $("chat-sub").textContent = n + " \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a(\u043e\u0432)" + (on ? ", " + on + " \u0432 \u0441\u0435\u0442\u0438" : "");
  } else {
    $("chat-sub").textContent = lastSeenText(other) || "@" + (other?.username || "");
  }
  setAvatar($("chat-avatar"), title, conv.is_group ? conv.id : other?.id, conv.is_group ? null : other?.avatar_url, !conv.is_group && other && state.online.has(other.id));
  const key = await convKey(conv);
  $("lock-badge").classList.toggle("hidden", !(key && e2eEnabled(conv)));
}
const openChatInfo = () => {
  const conv = activeConv(); if (!conv) return;
  if (conv.is_group) showGroupInfo(); else { const o = otherMember(conv); if (o) showUser(o.id); }
};
$("chat-head-info").onclick = openChatInfo;
$("btn-chat-info").onclick = openChatInfo;
$("btn-chat-menu").onclick = () => $("chat-menu").classList.toggle("hidden");
$("chat-menu").onclick = async (e) => {
  const a = e.target.dataset?.m;
  if (!a) return;
  $("chat-menu").classList.add("hidden");
  const conv = activeConv();
  if (!conv) return;
  const s = settingsOf(conv.id);
  if (a === "mute") { await saveSetting(conv.id, { muted: !s.muted }); renderConvList(); toast(!s.muted ? "\u0423\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f \u0432\u044b\u043a\u043b\u044e\u0447\u0435\u043d\u044b" : "\u0423\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f \u0432\u043a\u043b\u044e\u0447\u0435\u043d\u044b"); }
  if (a === "pin") { await saveSetting(conv.id, { pinned: !s.pinned }); renderConvList(); toast(!s.pinned ? "\u0427\u0430\u0442 \u0437\u0430\u043a\u0440\u0435\u043f\u043b\u0451\u043d" : "\u041e\u0442\u043a\u0440\u0435\u043f\u043b\u0451\u043d"); }
  if (a === "archive") { await saveSetting(conv.id, { archived: !s.archived }); closeChat(); renderConvList(); toast(!s.archived ? "\u0412 \u0430\u0440\u0445\u0438\u0432\u0435" : "\u0418\u0437 \u0430\u0440\u0445\u0438\u0432\u0430"); }
  if (a === "wallpaper") {
    showList("\u041e\u0431\u043e\u0438 \u0447\u0430\u0442\u0430", WALLPAPERS.map((w) => ({
      title: w.name, sub: "", onPick: async () => { await saveSetting(conv.id, { wallpaper: w.css || null }); applyWallpaper(w.css); },
    })));
  }
  if (a === "export") exportChat(conv);
  if (a === "clear") {
    if (!confirm("\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0432\u0441\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f \u044d\u0442\u043e\u0433\u043e \u0447\u0430\u0442\u0430 \u0434\u043b\u044f \u0432\u0441\u0435\u0445?")) return;
    const { error } = await sb.rpc("clear_chat", { conv: conv.id });
    if (error) return toast(error.message);
    state.msgs.clear(); renderAllMessages(); await refreshConvMeta(conv); renderConvList();
    toast("\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u043e\u0447\u0438\u0449\u0435\u043d\u0430");
  }
  if (a === "lock") await toggleEncryption(conv);
};
async function toggleEncryption(conv) {
  if (!E2E.hasCrypto) return toast("\u0411\u0440\u0430\u0443\u0437\u0435\u0440 \u043d\u0435 \u043f\u043e\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u0448\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u0438\u0435");
  if (conv.is_group) {
    if (!conv.e2e) {
      const pass = await ask("\u041f\u0430\u0440\u043e\u043b\u044c \u0434\u043b\u044f \u0433\u0440\u0443\u043f\u043f\u044b", "\u041f\u0435\u0440\u0435\u0434\u0430\u0439\u0442\u0435 \u0435\u0433\u043e \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u0430\u043c \u0434\u0440\u0443\u0433\u0438\u043c \u0441\u043f\u043e\u0441\u043e\u0431\u043e\u043c", { password: true });
      if (!pass) return;
      const salt = E2E.randomSalt();
      const { error } = await sb.from("conversations").update({ e2e: true, e2e_salt: salt }).eq("id", conv.id);
      if (error) return toast(error.message);
      conv.e2e = true; conv.e2e_salt = salt;
      localStorage.setItem("gkey_" + conv.id, pass);
      state.keys.delete(conv.id);
      state.e2eOff.delete(conv.id);
      toast("\u0428\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u0438\u0435 \u0432\u043a\u043b\u044e\u0447\u0435\u043d\u043e");
    } else {
      state.e2eOff.has(conv.id) ? state.e2eOff.delete(conv.id) : state.e2eOff.add(conv.id);
      toast(state.e2eOff.has(conv.id) ? "\u041d\u043e\u0432\u044b\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f \u0431\u0435\u0437 \u0448\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u0438\u044f" : "\u0428\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u0438\u0435 \u0432\u043a\u043b\u044e\u0447\u0435\u043d\u043e");
    }
  } else {
    const key = await convKey(conv);
    if (!key) return toast("\u0423 \u0441\u043e\u0431\u0435\u0441\u0435\u0434\u043d\u0438\u043a\u0430 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442 \u043a\u043b\u044e\u0447\u0430 \u2014 \u043f\u0443\u0441\u0442\u044c \u0437\u0430\u0439\u0434\u0451\u0442 \u0432 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435");
    state.e2eOff.has(conv.id) ? state.e2eOff.delete(conv.id) : state.e2eOff.add(conv.id);
    toast(state.e2eOff.has(conv.id) ? "\u0428\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u0438\u0435 \u0432\u044b\u043a\u043b\u044e\u0447\u0435\u043d\u043e" : "\u0428\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u0438\u0435 \u0432\u043a\u043b\u044e\u0447\u0435\u043d\u043e");
  }
  renderChatHeader();
}
function exportChat(conv) {
  const lines = [...state.msgs.values()]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((m) => "[" + new Date(m.created_at).toLocaleString("ru-RU") + "] " + nameOf(profileById(m.sender_id)) + ": " + (plainOf(m) || (m.attachment_url ? m.attachment_url : "")));
  download("chat-" + convTitle(conv).replace(/[^\w\u0400-\u04FF]+/g, "_") + ".txt", lines.join("\n"));
  toast("\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u0441\u043a\u0430\u0447\u0430\u043d\u0430");
}

/* ---------- messages rendering ---------- */
function renderAllMessages() {
  const box = $("messages");
  box.innerHTML = "";
  lastRenderedDay = null;
  state.images = [];
  const list = [...state.msgs.values()]
    .filter((m) => !state.blocked.has(m.sender_id))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (!list.length) { box.innerHTML = '<div class="empty">\u041d\u0430\u043f\u0438\u0448\u0438\u0442\u0435 \u043f\u0435\u0440\u0432\u043e\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u{1F44B}</div>'; return; }
  list.forEach(appendMessage);
}
let lastRenderedDay = null;
function appendMessage(m) {
  if (state.blocked.has(m.sender_id)) return;
  const box = $("messages");
  box.querySelector(".empty")?.remove();
  const day = new Date(m.created_at).toDateString();
  if (day !== lastRenderedDay) {
    lastRenderedDay = day;
    const d = document.createElement("div");
    d.className = "day"; d.textContent = fmtDay(m.created_at);
    box.appendChild(d);
  }
  const row = document.createElement("div");
  row.className = "msg-row" + (m.sender_id === state.me.id ? " mine" : "");
  row.dataset.id = m.id;
  fillRow(row, m);
  box.appendChild(row);
}
function readersOf(m) {
  const conv = convById(m.conversation_id);
  if (!conv) return [];
  return conv.conversation_members.filter((x) => x.user_id !== state.me.id && new Date(x.last_read_at) >= new Date(m.created_at)).map((x) => x.user_id);
}
const isReadByOthers = (m) => readersOf(m).length > 0;
function fillRow(row, m) {
  const conv = convById(m.conversation_id);
  const mine = m.sender_id === state.me.id;
  const text = plainOf(m);
  let html = "";
  if (conv?.is_group && !mine) html += '<div class="author">' + esc(nameOf(profileById(m.sender_id))) + "</div>";
  if (m.forwarded_from) html += '<div class="small muted">\u21aa\uFE0F \u041f\u0435\u0440\u0435\u0441\u043b\u0430\u043d\u043e \u043e\u0442 ' + esc(m.forwarded_from) + "</div>";
  if (m.reply_to) {
    const r = state.msgs.get(m.reply_to);
    html += '<div class="quote" data-jump="' + m.reply_to + '"><b>' + esc(r ? nameOf(profileById(r.sender_id)) : "\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435") + "</b>" + esc(r ? (plainOf(r) || "\u{1F4CE} \u0412\u043b\u043e\u0436\u0435\u043d\u0438\u0435") : "\u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u043e") + "</div>";
  }
  if (m.attachment_url) {
    const url = esc(m.attachment_url);
    if (m.kind === "voice") html += '<audio controls preload="none" src="' + url + '"></audio>';
    else if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|$)/i.test(m.attachment_url)) {
      state.images.push(m.attachment_url);
      html += '<img src="' + url + '" alt="" loading="lazy" data-img="' + url + '" />';
    } else html += '<a href="' + url + '" target="_blank" rel="noopener">\u{1F4CE} ' + esc(decodeURIComponent(m.attachment_url.split("/").pop().replace(/^\d+-/, ""))) + "</a>";
  }
  if (text) html += '<div class="text">' + renderText(text, chatSearchQuery) + "</div>";
  const saved = state.saved.has(m.id) ? "\u2b50" : "";
  const ttl = m.expires_at ? "\u23f1\uFE0F" : "";
  const lock = m.is_encrypted ? "\u{1F512}" : "";
  const check = mine ? '<span class="check ' + (isReadByOthers(m) ? "read" : "") + '">' + (isReadByOthers(m) ? "\u2713\u2713" : "\u2713") + "</span>" : "";
  html += '<div class="meta">' + saved + ttl + lock + (m.edited_at ? " \u0438\u0437\u043c." : "") + " " + fmtTime(m.created_at) + check + "</div>";
  const actions = '<div class="actions">' +
    '<button data-a="react" title="\u0420\u0435\u0430\u043a\u0446\u0438\u044f">\u{1F60A}</button>' +
    '<button data-a="reply" title="\u041e\u0442\u0432\u0435\u0442\u0438\u0442\u044c">\u21a9\uFE0F</button>' +
    '<button data-a="forward" title="\u041f\u0435\u0440\u0435\u0441\u043b\u0430\u0442\u044c">\u27a1\uFE0F</button>' +
    '<button data-a="save" title="\u0412 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435">\u2b50</button>' +
    '<button data-a="pin" title="\u0417\u0430\u043a\u0440\u0435\u043f\u0438\u0442\u044c">\u{1F4CC}</button>' +
    '<button data-a="link" title="\u0421\u0441\u044b\u043b\u043a\u0430">\u{1F517}</button>' +
    (text ? '<button data-a="copy" title="\u041a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c">\u{1F4CB}</button>' : "") +
    (mine && text ? '<button data-a="edit" title="\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c">\u270F\uFE0F</button>' : "") +
    (mine ? '<button data-a="del" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c">\u{1F5D1}\uFE0F</button>' : "") +
    "</div>";
  row.innerHTML = actions + '<div class="bubble">' + html + '</div><div class="reactions"></div>';
  renderReactions(row, m.id);

  row.querySelector(".author")?.addEventListener("click", () => showUser(m.sender_id));
  row.querySelector(".quote")?.addEventListener("click", () => jumpTo(m.reply_to));
  row.querySelectorAll(".spoiler").forEach((s) => s.addEventListener("click", () => s.classList.toggle("open")));
  row.querySelector("[data-img]")?.addEventListener("click", (e) => openLightbox(e.target.dataset.img));
  row.querySelector(".check")?.addEventListener("click", () => showReaders(m));
  row.querySelector(".bubble").addEventListener("click", (e) => {
    if (e.target.closest("a,.quote,.author,.spoiler,[data-img],audio,.check")) return;
    document.querySelectorAll(".msg-row.show-actions").forEach((r) => r !== row && r.classList.remove("show-actions"));
    row.classList.toggle("show-actions");
  });
  const act = (name, fn) => row.querySelector('[data-a="' + name + '"]')?.addEventListener("click", fn);
  act("react", (e) => showEmojiPicker(e.currentTarget, m.id));
  act("reply", () => setReply(m));
  act("forward", () => forwardMessage(m));
  act("save", () => toggleSaved(m));
  act("pin", () => pinMessage(m));
  act("link", () => {
    const link = location.href.split("#")[0] + "#c=" + m.conversation_id + "&m=" + m.id;
    navigator.clipboard.writeText(link); toast("\u0421\u0441\u044b\u043b\u043a\u0430 \u0441\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d\u0430");
  });
  act("copy", () => { navigator.clipboard.writeText(plainOf(m)); toast("\u0421\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d\u043e"); });
  act("edit", async () => {
    const t = await ask("\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435", "", { value: plainOf(m) });
    if (t == null || !t.trim() || t === plainOf(m)) return;
    const payload = { content: t.trim(), edited_at: new Date().toISOString() };
    if (m.is_encrypted) {
      const key = await convKey(convById(m.conversation_id));
      if (!key) return toast("\u041d\u0435\u0442 \u043a\u043b\u044e\u0447\u0430");
      payload.content = await E2E.encryptText(key, t.trim());
    }
    const { error } = await sb.from("messages").update(payload).eq("id", m.id);
    if (error) toast(error.message);
    else { m.plain = t.trim(); }
  });
  act("del", async () => {
    if (!confirm("\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u0434\u043b\u044f \u0432\u0441\u0435\u0445?")) return;
    const { error } = await sb.from("messages").delete().eq("id", m.id);
    if (error) toast(error.message); else removeMessage(m.id);
  });
}
function rerenderMessage(id) {
  const row = document.querySelector('.msg-row[data-id="' + id + '"]');
  const m = state.msgs.get(id);
  if (row && m) fillRow(row, m);
}
function removeMessage(id) {
  state.msgs.delete(id);
  document.querySelector('.msg-row[data-id="' + id + '"]')?.remove();
  document.querySelectorAll('.quote[data-jump="' + id + '"]').forEach((q) => { q.innerHTML = "<b>\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435</b>\u0443\u0434\u0430\u043b\u0435\u043d\u043e"; });
}
function updateAllChecks() {
  document.querySelectorAll(".msg-row.mine").forEach((row) => {
    const m = state.msgs.get(row.dataset.id);
    const el = row.querySelector(".check");
    if (!m || !el) return;
    const read = isReadByOthers(m);
    el.classList.toggle("read", read);
    el.textContent = read ? "\u2713\u2713" : "\u2713";
  });
}
function showReaders(m) {
  const ids = readersOf(m);
  showList("\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u043b\u0438 (" + ids.length + ")", ids.map((id) => {
    const p = profileById(id);
    return { title: nameOf(p), sub: "@" + (p?.username || ""), avatar: p?.avatar_url || null, seed: id, onPick: () => showUser(id) };
  }));
}
function jumpTo(id) {
  const row = document.querySelector('.msg-row[data-id="' + id + '"]');
  if (!row) return toast("\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e \u0432 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d\u043d\u043e\u0439 \u0447\u0430\u0441\u0442\u0438");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("highlight");
  setTimeout(() => row.classList.remove("highlight"), 1600);
}
function dropExpiredLocally() {
  const now = Date.now();
  let changed = false;
  for (const m of [...state.msgs.values()]) {
    if (m.expires_at && new Date(m.expires_at).getTime() < now) { removeMessage(m.id); changed = true; }
  }
  if (changed) renderConvList();
}

/* ---------- saved / pinned / forward ---------- */
async function toggleSaved(m) {
  if (state.saved.has(m.id)) {
    await sb.from("saved_messages").delete().eq("user_id", state.me.id).eq("message_id", m.id);
    state.saved.delete(m.id); toast("\u0423\u0431\u0440\u0430\u043d\u043e \u0438\u0437 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0433\u043e");
  } else {
    const { error } = await sb.from("saved_messages").insert({ user_id: state.me.id, message_id: m.id });
    if (error && error.code !== "23505") return toast(error.message);
    state.saved.add(m.id); toast("\u0412 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u043c \u2b50");
  }
  rerenderMessage(m.id);
}
$("btn-saved").onclick = async () => {
  const { data } = await sb.from("saved_messages").select("message_id,created_at").order("created_at", { ascending: false }).limit(100);
  const ids = (data || []).map((s) => s.message_id);
  if (!ids.length) return showList("\u2b50 \u0418\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435", []);
  const { data: msgs } = await sb.from("messages").select("*").in("id", ids);
  const items = [];
  for (const m of msgs || []) {
    await decryptMessage(m);
    const conv = convById(m.conversation_id);
    items.push({
      title: plainOf(m) || "\u{1F4CE} \u0412\u043b\u043e\u0436\u0435\u043d\u0438\u0435",
      sub: (conv ? convTitle(conv) : "\u0427\u0430\u0442") + " \u00b7 " + fmtListTime(m.created_at),
      onPick: () => openConversation(m.conversation_id, m.id),
    });
  }
  showList("\u2b50 \u0418\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435", items);
};
async function pinMessage(m) {
  const cur = state.pinned.get(m.conversation_id);
  if (cur === m.id) {
    await sb.from("pinned_messages").delete().eq("conversation_id", m.conversation_id).eq("message_id", m.id);
    state.pinned.delete(m.conversation_id);
  } else {
    if (cur) await sb.from("pinned_messages").delete().eq("conversation_id", m.conversation_id).eq("message_id", cur);
    const { error } = await sb.from("pinned_messages").insert({ conversation_id: m.conversation_id, message_id: m.id, pinned_by: state.me.id });
    if (error) return toast(error.message);
    state.pinned.set(m.conversation_id, m.id);
    toast("\u0417\u0430\u043a\u0440\u0435\u043f\u043b\u0435\u043d\u043e \u{1F4CC}");
  }
  renderPinnedBar();
}
function renderPinnedBar() {
  const bar = $("pinned-bar");
  const id = state.pinned.get(state.activeId);
  if (!id) { bar.classList.add("hidden"); return; }
  const m = state.msgs.get(id);
  $("pinned-text").textContent = m ? (plainOf(m) || "\u0412\u043b\u043e\u0436\u0435\u043d\u0438\u0435") : "\u0417\u0430\u043a\u0440\u0435\u043f\u043b\u0451\u043d\u043d\u043e\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435";
  bar.classList.remove("hidden");
  bar.onclick = (e) => { if (e.target.id !== "pinned-unpin") jumpTo(id); };
  $("pinned-unpin").onclick = async () => {
    await sb.from("pinned_messages").delete().eq("conversation_id", state.activeId).eq("message_id", id);
    state.pinned.delete(state.activeId); renderPinnedBar();
  };
}
function forwardMessage(m) {
  const text = plainOf(m);
  showList("\u041f\u0435\u0440\u0435\u0441\u043b\u0430\u0442\u044c \u0432\u2026", visibleConvs().map((c) => ({
    title: convTitle(c), sub: previewOf(c),
    onPick: async () => {
      const target = convById(c.id);
      const payload = { conversation_id: c.id, content: text, attachment_url: m.attachment_url || null, kind: m.kind || "text", forwarded_from: nameOf(profileById(m.sender_id)) };
      const key = await convKey(target);
      if (key && e2eEnabled(target) && payload.content) {
        payload.content = await E2E.encryptText(key, text);
        payload.is_encrypted = true;
      }
      const { error } = await sb.from("messages").insert(payload);
      toast(error ? error.message : "\u041f\u0435\u0440\u0435\u0441\u043b\u0430\u043d\u043e");
    },
  })));
}

/* ---------- reactions ---------- */
function addReactionToState(r) {
  const arr = state.reactions.get(r.message_id) || [];
  if (!arr.some((x) => x.user_id === r.user_id && x.emoji === r.emoji)) arr.push({ user_id: r.user_id, emoji: r.emoji });
  state.reactions.set(r.message_id, arr);
}
function removeReactionFromState(r) {
  const arr = (state.reactions.get(r.message_id) || []).filter((x) => !(x.user_id === r.user_id && x.emoji === r.emoji));
  state.reactions.set(r.message_id, arr);
}
function renderReactions(row, messageId) {
  const box = row.querySelector(".reactions");
  box.innerHTML = "";
  const groups = {};
  for (const r of state.reactions.get(messageId) || []) (groups[r.emoji] ||= []).push(r.user_id);
  for (const [emoji, users] of Object.entries(groups)) {
    const b = document.createElement("span");
    b.className = "reaction" + (users.includes(state.me.id) ? " mine" : "");
    b.textContent = emoji + " " + users.length;
    b.title = users.map((u) => nameOf(profileById(u))).join(", ");
    b.onclick = () => toggleReaction(messageId, emoji);
    box.appendChild(b);
  }
}
async function toggleReaction(messageId, emoji) {
  const has = (state.reactions.get(messageId) || []).some((r) => r.user_id === state.me.id && r.emoji === emoji);
  const r = { message_id: messageId, user_id: state.me.id, emoji };
  if (has) {
    removeReactionFromState(r); rerenderReactions(messageId);
    const { error } = await sb.from("message_reactions").delete().match(r);
    if (error) { addReactionToState(r); rerenderReactions(messageId); toast(error.message); }
  } else {
    addReactionToState(r); rerenderReactions(messageId);
    const { error } = await sb.from("message_reactions").insert({ message_id: messageId, emoji });
    if (error && error.code !== "23505") { removeReactionFromState(r); rerenderReactions(messageId); toast(error.message); }
  }
}
function rerenderReactions(messageId) {
  const row = document.querySelector('.msg-row[data-id="' + messageId + '"]');
  if (row) renderReactions(row, messageId);
}
function showEmojiPicker(anchor, messageId) {
  const p = $("emoji-picker");
  p.innerHTML = "";
  for (const e of EMOJIS) {
    const b = document.createElement("button");
    b.textContent = e;
    b.onclick = () => { hideEmojiPicker(); toggleReaction(messageId, e); };
    p.appendChild(b);
  }
  p.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth;
  p.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left - w / 2)) + "px";
  p.style.top = Math.max(8, r.top - p.offsetHeight - 6) + "px";
}
function hideEmojiPicker() { $("emoji-picker").classList.add("hidden"); }

/* ---------- lightbox ---------- */
function openLightbox(url) {
  state.imgIndex = Math.max(0, state.images.indexOf(url));
  showImage();
  $("lightbox").classList.remove("hidden");
}
function showIm