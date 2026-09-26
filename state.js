import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
export const $ = (id) => document.getElementById(id);
export const hooks = {};

export const EMOJIS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F525}", "\u{1F44E}", "\u{1F389}"];
export const STATUS_EMOJIS = ["", "\u{1F60A}", "\u{1F4BB}", "\u{1F3AE}", "\u{1F4DA}", "\u{1F3A7}", "\u{1F634}", "\u2708\uFE0F", "\u2615", "\u{1F525}"];
export const WALLPAPERS = [
  { name: "\u0411\u0435\u0437 \u0444\u043e\u043d\u0430", css: "" },
  { name: "\u041c\u043e\u0440\u0435", css: "linear-gradient(160deg,#1e3a8a,#0ea5e9)" },
  { name: "\u0417\u0430\u043a\u0430\u0442", css: "linear-gradient(160deg,#f97316,#db2777)" },
  { name: "\u041b\u0435\u0441", css: "linear-gradient(160deg,#14532d,#4ade80)" },
  { name: "\u041d\u043e\u0447\u044c", css: "linear-gradient(160deg,#0f172a,#334155)" },
  { name: "\u0421\u0438\u0440\u0435\u043d\u044c", css: "linear-gradient(160deg,#4c1d95,#a78bfa)" },
];
export const TTLS = [
  { s: 0, label: "\u0431\u0435\u0437 \u0442\u0430\u0439\u043c\u0435\u0440\u0430" },
  { s: 10, label: "10 \u0441\u0435\u043a" },
  { s: 60, label: "1 \u043c\u0438\u043d" },
  { s: 3600, label: "1 \u0447\u0430\u0441" },
  { s: 86400, label: "1 \u0434\u0435\u043d\u044c" },
];
export const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

export const prefs = {
  sound: localStorage.getItem("sound") !== "0",
  notify: localStorage.getItem("notify") !== "0",
  typing: localStorage.getItem("typingOn") !== "0",
  enter: localStorage.getItem("enterSend") !== "0",
  font: +(localStorage.getItem("fontSize") || 16),
};
export function savePrefs() {
  localStorage.setItem("sound", prefs.sound ? "1" : "0");
  localStorage.setItem("notify", prefs.notify ? "1" : "0");
  localStorage.setItem("typingOn", prefs.typing ? "1" : "0");
  localStorage.setItem("enterSend", prefs.enter ? "1" : "0");
  localStorage.setItem("fontSize", String(prefs.font));
}

export const state = {
  me: null, priv: null, convs: [],
  cs: new Map(), lastMsg: {}, unread: {},
  activeId: null, msgs: new Map(), reactions: new Map(),
  pinned: new Map(), saved: new Set(), blocked: new Set(),
  keys: new Map(), e2eOff: new Set(),
  replyTo: null, online: new Set(),
  typingChannel: null, typingUsers: {},
  groupSelected: new Map(), profiles: new Map(),
  ttl: 0, showArchived: false, newCount: 0,
  images: [], imgIndex: 0, searchQuery: "",
};

/* ---------- formatting ---------- */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const nameOf = (p) => p?.display_name || p?.username || "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c";
export const initials = (s) => (s || "?").trim().slice(0, 1).toUpperCase();
export const fmtTime = (d) => new Date(d).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
export function fmtDay(d) {
  const dt = new Date(d), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dt.toDateString() === now.toDateString()) return "\u0421\u0435\u0433\u043e\u0434\u043d\u044f";
  if (dt.toDateString() === y.toDateString()) return "\u0412\u0447\u0435\u0440\u0430";
  return dt.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: dt.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
export const fmtListTime = (d) => new Date(d).toDateString() === new Date().toDateString() ? fmtTime(d) : new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
export function colorFor(id = "") { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return "hsl(" + h + " 55% 45%)"; }

export function renderText(raw, query = "") {
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

/* ---------- ui helpers ---------- */
export function toast(text, ms = 2300) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
export function setAvatar(el, label, seed, url, online = false) {
  if (!el) return;
  el.textContent = url ? "" : initials(label);
  el.style.background = url ? 'url("' + url + '") center/cover' : colorFor(seed || label);
  el.classList.toggle("online", !!online);
}
export function cacheProfile(p) {
  if (!p?.id) return p;
  const ex = state.profiles.get(p.id);
  if (ex) { Object.assign(ex, p); return ex; }
  state.profiles.set(p.id, p);
  return p;
}
export const profileById = (id) => state.profiles.get(id);
export const convById = (id) => state.convs.find((c) => c.id === id);
export const activeConv = () => convById(state.activeId);
export function otherMember(conv) {
  const m = conv?.conversation_members?.find((x) => x.user_id !== state.me.id);
  return m ? profileById(m.user_id) : null;
}
export const convTitle = (conv) => conv.is_group ? (conv.title || "\u0413\u0440\u0443\u043f\u043f\u0430") : nameOf(otherMember(conv));
export const settingsOf = (id) => state.cs.get(id) || {};
export function lastSeenText(p) {
  if (!p) return "";
  if (state.online.has(p.id)) return "\u0432 \u0441\u0435\u0442\u0438";
  if (!p.last_seen_at) return "";
  return "\u0431\u044b\u043b(\u0430) " + fmtDay(p.last_seen_at).toLowerCase() + " \u0432 " + fmtTime(p.last_seen_at);
}
export const openModal = (id) => $(id).classList.remove("hidden");
export const closeModal = (id) => $(id).classList.add("hidden");
export const closeAllModals = () => document.querySelectorAll(".modal,.lightbox").forEach((m) => m.classList.add("hidden"));
document.querySelectorAll(".modal,.lightbox").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.classList.add("hidden"); });
});
export function download(name, data, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
let audioCtx;
export function beep() {
  if (!prefs.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 680; g.gain.value = 0.06;
    o.start(); o.stop(audioCtx.currentTime + 0.12);
  } catch (_) {}
}
export function ask(title, text = "", { value = "", password = false } = {}) {
  return new Promise((resolve) => {
    $("prompt-title").innerHTML = esc(title) + ' <button class="icon" data-close>\u2715</button>';
    $("prompt-text").textContent = text;
    const inp = $("prompt-input");
    inp.type = password ? "password" : "text";
    inp.value = value;
    openModal("prompt-modal");
    setTimeout(() => inp.focus(), 60);
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      $("prompt-modal").removeEventListener("click", onBg);
      inp.onkeydown = null;
      $("prompt-ok").onclick = null;
      closeModal("prompt-modal");
      resolve(v);
    };
    function onBg(e) { if (e.target === $("prompt-modal") || e.target.closest("[data-close]")) finish(null); }
    $("prompt-modal").addEventListener("click", onBg);
    $("prompt-ok").onclick = () => finish(inp.value);
    inp.onkeydown = (e) => { if (e.key === "Enter") finish(inp.value); };
  });
}
export function renderListItems(items) {
  const ul = $("list-body");
  ul.innerHTML = "";
  if (!items || !items.length) { ul.innerHTML = '<li class="muted small">\u041f\u0443\u0441\u0442\u043e</li>'; return; }
  for (const it of items) {
    const li = document.createElement("li");
    li.innerHTML = '<div class="ellipsis" style="flex:1"><div class="bold ellipsis">' + esc(it.title) + '</div><div class="muted small ellipsis">' + esc(it.sub || "") + "</div></div>" + (it.right || "");
    if ("avatar" in it) {
      const av = document.createElement("div");
      av.className = "avatar sm";
      setAvatar(av, it.title, it.seed, it.avatar);
      li.prepend(av);
    }
    li.onclick = () => { closeModal("list-modal"); it.onPick?.(); };
    ul.appendChild(li);
  }
}
export function showList(title, items, { searchable = false, onSearch = null, placeholder = "\u0418\u0441\u043a\u0430\u0442\u044c\u2026" } = {}) {
  $("list-title").innerHTML = esc(title) + ' <button class="icon" data-close>\u2715</button>';
  const inp = $("list-input");
  inp.classList.toggle("hidden", !searchable);
  inp.value = "";
  inp.placeholder = placeholder;
  renderListItems(items);
  if (searchable && onSearch) {
    let t;
    inp.oninput = () => { clearTimeout(t); t = setTimeout(async () => renderListItems(await onSearch(inp.value)), 300); };
    setTimeout(() => inp.focus(), 80);
  } else inp.oninput = null;
  openModal("list-modal");
}
