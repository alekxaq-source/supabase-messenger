import {
  sb, $, hooks, state, prefs, EMOJIS, TTLS, esc, nameOf, fmtTime, fmtDay, setAvatar, cacheProfile,
  profileById, convById, activeConv, otherMember, convTitle, settingsOf, toast, openModal, closeModal,
  renderText, download, showList, beep,
} from "./state.js";
import { decryptMessage, plainOf, prepareOutgoing, convKey, e2eEnabled } from "./e2e.js";
import { renderConvList, renderChatHeader, setCS, applyWallpaper, showUser } from "./convs.js";

const MSG_COLS = "id,conversation_id,sender_id,content,attachment_url,created_at,edited_at,reply_to,is_encrypted,expires_at,forwarded_from,kind";
const isImg = (u) => /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|$)/i.test(u || "");
const msgsOf = (id) => state.msgs.get(id) || [];
const byId = (id) => msgsOf(state.activeId).find((m) => m.id === id);

export function scrollBottom(smooth = false) {
  const box = $("messages");
  box.scrollTo({ top: box.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  state.newCount = 0;
  $("btn-scroll-down").classList.add("hidden");
}
const atBottom = () => {
  const box = $("messages");
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
};

/* ---------------- open ---------------- */
export async function openConversation(id) {
  const c = convById(id);
  if (!c) return;
  state.activeId = id;
  state.replyTo = null;
  $("reply-bar").classList.add("hidden");
  $("chat-empty").classList.add("hidden");
  $("chat-view").classList.remove("hidden");
  document.body.classList.add("chat-open");
  $("chat-search-bar").classList.add("hidden");
  state.searchQuery = "";
  renderChatHeader();
  renderConvList();
  $("messages").innerHTML = '<div class="muted small pad">Загрузка…</div>';

  await convKey(c).catch(() => null);
  const { data, error } = await sb.from("messages").select(MSG_COLS).eq("conversation_id", id).order("created_at", { ascending: false }).limit(300);
  if (error) { $("messages").innerHTML = '<div class="muted small pad">Не удалось загрузить сообщения</div>'; return; }
  const list = (data || []).reverse();
  state.msgs.set(id, list);
  await loadReactions(list.map((m) => m.id));
  for (const m of list) await decryptMessage(m).catch(() => {});
  await loadPinned(id);
  renderAllMessages();
  await ensureAuthors(list);
  renderAllMessages();
  scrollBottom();
  markRead();
  const d = settingsOf(id).draft;
  $("msg-input").value = d || "";
  autoGrow();
  hooks.bindTyping?.(id);
  if (location.hash.startsWith("#c=")) history.replaceState(null, "", "#c=" + id);
}

async function ensureAuthors(list) {
  const miss = [...new Set(list.map((m) => m.sender_id).filter((x) => x && !profileById(x)))];
  if (!miss.length) return;
  const { data } = await sb.from("profiles").select("id,username,display_name,avatar_url,status_emoji,public_key,last_seen_at,bio").in("id", miss);
  (data || []).forEach(cacheProfile);
}

async function loadReactions(ids) {
  if (!ids.length) return;
  const { data } = await sb.from("message_reactions").select("message_id,user_id,emoji").in("message_id", ids);
  for (const id of ids) state.reactions.set(id, []);
  for (const r of data || []) state.reactions.set(r.message_id, [...(state.reactions.get(r.message_id) || []), r]);
}

async function loadPinned(convId) {
  const { data } = await sb.from("pinned_messages").select("message_id,created_at").eq("conversation_id", convId).order("created_at", { ascending: false });
  state.pinned.set(convId, data || []);
  renderPinnedBar();
}

export function renderPinnedBar() {
  const list = state.pinned.get(state.activeId) || [];
  const bar = $("pinned-bar");
  if (!list.length) { bar.classList.add("hidden"); return; }
  const m = byId(list[0].message_id);
  bar.classList.remove("hidden");
  $("pinned-text").textContent = "📌 " + (m ? (plainOf(m) || "Вложение") : "Сообщение");
  $("pinned-text").onclick = () => jumpToMessage(list[0].message_id);
  $("pinned-unpin").onclick = async () => {
    await sb.from("pinned_messages").delete().eq("conversation_id", state.activeId).eq("message_id", list[0].message_id);
    await loadPinned(state.activeId);
  };
}

/* ---------------- render ---------------- */
export function renderAllMessages() {
  const box = $("messages");
  box.innerHTML = "";
  const list = msgsOf(state.activeId);
  if (!list.length) { box.innerHTML = '<div class="muted small pad">Напишите первое сообщение 👋</div>'; return; }
  let day = "";
  state.images = [];
  for (const m of list) {
    const d = fmtDay(m.created_at);
    if (d !== day) { day = d; const s = document.createElement("div"); s.className = "day"; s.textContent = d; box.appendChild(s); }
    box.appendChild(rowFor(m));
  }
  applyWallpaper();
}

export function appendMessage(m) {
  const list = msgsOf(state.activeId);
  if (list.some((x) => x.id === m.id)) return;
  list.push(m);
  state.msgs.set(state.activeId, list);
  const box = $("messages");
  const prev = list[list.length - 2];
  if (!prev || fmtDay(prev.created_at) !== fmtDay(m.created_at)) {
    const s = document.createElement("div"); s.className = "day"; s.textContent = fmtDay(m.created_at); box.appendChild(s);
  }
  box.appendChild(rowFor(m));
}

export function refreshRow(id) {
  const m = byId(id);
  const old = document.querySelector('.msg[data-id="' + id + '"]');
  if (!m || !old) return;
  old.replaceWith(rowFor(m));
}

function readTick(m) {
  const c = activeConv();
  if (!c || m.sender_id !== state.me.id) return "";
  const others = (c.conversation_members || []).filter((x) => x.user_id !== state.me.id);
  const seen = others.filter((x) => x.last_read_at && new Date(x.last_read_at) >= new Date(m.created_at));
  return seen.length ? '<span class="tick read" data-act="readers" data-id="' + m.id + '">✓✓</span>' : '<span class="tick">✓</span>';
}

function rowFor(m) {
  const mine = m.sender_id === state.me.id;
  const c = activeConv();
  const author = profileById(m.sender_id);
  const el = document.createElement("div");
  el.className = "msg" + (mine ? " mine" : "");
  el.dataset.id = m.id;

  let html = "";
  if (!mine && c?.is_group) {
    html += '<div class="author" data-act="author" data-id="' + m.id + '" style="color:' + esc((author && "") || "") + '">' + esc(nameOf(author)) + "</div>";
  }
  if (m.forwarded_from) html += '<div class="fwd muted small">↪ Переслано от ' + esc(m.forwarded_from) + "</div>";
  if (m.reply_to) {
    const q = byId(m.reply_to);
    html += '<div class="quote" data-act="jump" data-id="' + m.reply_to + '"><b>' + esc(q ? nameOf(profileById(q.sender_id)) : "Сообщение") + "</b><br>" + esc(q ? (plainOf(q) || "Вложение").slice(0, 90) : "недоступно") + "</div>";
  }
  if (m.attachment_url) {
    if (m.kind === "voice") html += '<audio controls preload="none" src="' + esc(m.attachment_url) + '"></audio>';
    else if (isImg(m.attachment_url)) {
      state.images.push(m.attachment_url);
      html += '<img class="att" loading="lazy" src="' + esc(m.attachment_url) + '" data-act="img" data-url="' + esc(m.attachment_url) + '">';
    } else {
      const name = decodeURIComponent(m.attachment_url.split("/").pop().split("?")[0]);
      html += '<a class="file" href="' + esc(m.attachment_url) + '" target="_blank" rel="noopener">📎 ' + esc(name) + "</a>";
    }
  }
  const text = plainOf(m);
  if (text) html += '<div class="text">' + renderText(text, state.searchQuery) + "</div>";

  const r = state.reactions.get(m.id) || [];
  if (r.length) {
    const groups = {};
    for (const x of r) groups[x.emoji] = (groups[x.emoji] || []).concat(x.user_id);
    html += '<div class="reacts">' + Object.entries(groups).map(([e, us]) =>
      '<span class="react' + (us.includes(state.me.id) ? " own" : "") + '" data-act="toggle-react" data-id="' + m.id + '" data-emoji="' + esc(e) + '">' + esc(e) + " " + us.length + "</span>"
    ).join("") + "</div>";
  }

  const flags = [];
  if (state.saved.has(m.id)) flags.push("⭐");
  if (m.expires_at) flags.push("⏱");
  if (m.is_encrypted) flags.push("🔒");
  if (m.edited_at) flags.push("изм.");
  html += '<div class="meta">' + flags.join(" ") + " " + fmtTime(m.created_at) + " " + readTick(m) + "</div>";

  const acts = [
    ['react', '😊'], ['reply', '↩'], ['forward', '↪'], ['save', state.saved.has(m.id) ? '⭐' : '☆'],
    ['pin', '📌'], ['link', '🔗'], ['copy', '⎘'],
  ];
  if (mine) acts.push(['edit', '✎'], ['del', '🗑']);
  html += '<div class="acts">' + acts.map(([a, i]) => '<button class="icon sm" data-act="' + a + '" data-id="' + m.id + '" title="' + a + '">' + i + "</button>").join("") + "</div>";
  el.innerHTML = html;
  return el;
}

/* ---------------- read state ---------------- */
export async function markRead() {
  const id = state.activeId;
  if (!id) return;
  state.unread[id] = 0;
  renderConvList();
  const now = new Date().toISOString();
  const c = convById(id);
  const mine = c?.conversation_members?.find((x) => x.user_id === state.me.id);
  if (mine) mine.last_read_at = now;
  await sb.from("conversation_members").update({ last_read_at: now }).eq("conversation_id", id).eq("user_id", state.me.id);
}

/* ---------------- sending ---------------- */
export async function sendMessage() {
  const inp = $("msg-input");
  const text = inp.value.trim();
  const c = activeConv();
  if (!c || !text) return;
  inp.value = "";
  autoGrow();
  setCS(c.id, { draft: "" });
  const payload = await prepareOutgoing(c, text);
  const row = {
    conversation_id: c.id, sender_id: state.me.id, ...payload,
    reply_to: state.replyTo?.id || null, kind: "text",
    expires_at: state.ttl ? new Date(Date.now() + state.ttl * 1000).toISOString() : null,
  };
  cancelReply();
  const { data, error } = await sb.from("messages").insert(row).select(MSG_COLS).single();
  if (error) { toast("Сообщение не отправлено"); inp.value = text; return; }
  data.plain = text;
  appendMessage(data);
  state.lastMsg[c.id] = data;
  renderConvList();
  scrollBottom(true);
}

export async function sendFile(file, kind = "file") {
  const c = activeConv();
  if (!c || !file) return;
  if (file.size > 25 * 1024 * 1024) { toast("Файл больше 25 МБ"); return; }
  toast("Загрузка…");
  const ext = (file.name.split(".").pop() || "bin").toLowerCase();
  const path = state.me.id + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
  const { error: upErr } = await sb.storage.from("attachments").upload(path, file, { contentType: file.type || undefined });
  if (upErr) { toast("Не удалось загрузить файл"); return; }
  const url = sb.storage.from("attachments").getPublicUrl(path).data.publicUrl;
  const { data, error } = await sb.from("messages").insert({
    conversation_id: c.id, sender_id: state.me.id, attachment_url: url, kind,
    content: null, is_encrypted: false, reply_to: state.replyTo?.id || null,
    expires_at: state.ttl ? new Date(Date.now() + state.ttl * 1000).toISOString() : null,
  }).select(MSG_COLS).single();
  cancelReply();
  if (error) { toast("Ошибка отправки"); return; }
  appendMessage(data);
  state.lastMsg[c.id] = data;
  renderConvList();
  scrollBottom(true);
}

function cancelReply() {
  state.replyTo = null;
  $("reply-bar").classList.add("hidden");
}
function startReply(m) {
  state.replyTo = m;
  $("reply-name").textContent = nameOf(profileById(m.sender_id));
  $("reply-text").textContent = (plainOf(m) || "Вложение").slice(0, 120);
  $("reply-bar").classList.remove("hidden");
  $("msg-input").focus();
}

/* ---------------- message actions ---------------- */
export function jumpToMessage(id) {
  const el = document.querySelector('.msg[data-id="' + id + '"]');
  if (!el) { toast("Сообщение выше истории"); return; }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1200);
}

function openEmojiPicker(anchor, onPick) {
  const p = $("emoji-picker");
  p.innerHTML = "";
  for (const e of EMOJIS) {
    const b = document.createElement("button");
    b.className = "icon";
    b.textContent = e;
    b.onclick = () => { p.classList.add("hidden"); onPick(e); };
    p.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  p.style.top = Math.max(8, r.top - 50) + "px";
  p.style.left = Math.min(window.innerWidth - 240, r.left - 60) + "px";
  p.classList.remove("hidden");
  setTimeout(() => document.addEventListener("click", function h(ev) {
    if (!ev.target.closest("#emoji-picker")) { p.classList.add("hidden"); document.removeEventListener("click", h); }
  }), 10);
}

export async function toggleReaction(msgId, emoji) {
  const list = state.reactions.get(msgId) || [];
  const own = list.find((x) => x.user_id === state.me.id && x.emoji === emoji);
  if (own) {
    state.reactions.set(msgId, list.filter((x) => x !== own));
    refreshRow(msgId);
    await sb.from("message_reactions").delete().eq("message_id", msgId).eq("user_id", state.me.id).eq("emoji", emoji);
  } else {
    state.reactions.set(msgId, [...list, { message_id: msgId, user_id: state.me.id, emoji }]);
    refreshRow(msgId);
    await sb.from("message_reactions").insert({ message_id: msgId, user_id: state.me.id, emoji });
  }
}

async function toggleSave(m) {
  if (state.saved.has(m.id)) {
    state.saved.delete(m.id);
    await sb.from("saved_messages").delete().eq("user_id", state.me.id).eq("message_id", m.id);
    toast("Убрано из избранного");
  } else {
    state.saved.add(m.id);
    await sb.from("saved_messages").insert({ user_id: state.me.id, message_id: m.id });
    toast("Сохранено в избранное");
  }
  refreshRow(m.id);
}

async function togglePin(m) {
  const list = state.pinned.get(state.activeId) || [];
  if (list.some((x) => x.message_id === m.id)) {
    await sb.from("pinned_messages").delete().eq("conversation_id", state.activeId).eq("message_id", m.id);
    toast("Откреплено");
  } else {
    await sb.from("pinned_messages").insert({ conversation_id: state.activeId, message_id: m.id, pinned_by: state.me.id });
    toast("Закреплено");
  }
  await loadPinned(state.activeId);
}

async function editMessage(m) {
  const cur = plainOf(m);
  const next = await hooks.ask("Изменить сообщение", "", { value: cur });
  if (next == null || next.trim() === cur) return;
  const payload = await prepareOutgoing(activeConv(), next.trim());
  const { error } = await sb.from("messages").update({ ...payload, edited_at: new Date().toISOString() }).eq("id", m.id);
  if (error) { toast("Не удалось изменить"); return; }
  Object.assign(m, payload, { edited_at: new Date().toISOString(), plain: next.trim() });
  refreshRow(m.id);
}

async function deleteMessage(m) {
  if (!confirm("Удалить сообщение?")) return;
  const { error } = await sb.from("messages").delete().eq("id", m.id);
  if (error) { toast("Не удалось удалить"); return; }
  removeLocal(m.id);
}
export function removeLocal(id) {
  const list = msgsOf(state.activeId).filter((x) => x.id !== id);
  state.msgs.set(state.activeId, list);
  document.querySelector('.msg[data-id="' + id + '"]')?.remove();
}

async function forwardMessage(m) {
  const items = state.convs.map((c) => ({
    title: convTitle(c), sub: c.is_group ? "группа" : "личный чат", avatar: null, seed: c.id,
    onPick: async () => {
      const target = convById(c.id);
      const text = plainOf(m);
      const payload = await prepareOutgoing(target, text);
      const { error } = await sb.from("messages").insert({
        conversation_id: c.id, sender_id: state.me.id, ...payload,
        attachment_url: m.attachment_url, kind: m.kind || "text",
        forwarded_from: nameOf(profileById(m.sender_id)),
      });
      if (error) { toast("Не удалось переслать"); return; }
      toast("Переслано в «" + convTitle(c) + "»");
    },
  }));
  showList("Переслать…", items);
}

async function showReaders(m) {
  const c = activeConv();
  const rows = (c.conversation_members || []).filter((x) => x.user_id !== state.me.id).map((x) => {
    const p = profileById(x.user_id);
    const seen = x.last_read_at && new Date(x.last_read_at) >= new Date(m.created_at);
    return { title: nameOf(p), sub: seen ? "прочитано" : "не прочитано", avatar: p?.avatar_url, seed: x.user_id };
  });
  showList("Кто прочитал", rows);
}

export function showSaved() {
  const ids = [...state.saved];
  const items = ids.map((id) => {
    const m = byId(id);
    return { title: m ? (plainOf(m) || "Вложение") : "Сообщение из другого чата", sub: m ? fmtDay(m.created_at) + ", " + fmtTime(m.created_at) : "", onPick: () => m && jumpToMessage(id) };
  });
  showList("⭐ Избранное (" + ids.length + ")", items);
}

export function showPinnedList() {
  const list = state.pinned.get(state.activeId) || [];
  showList("📌 Закреплённые", list.map((x) => {
    const m = byId(x.message_id);
    return { title: m ? (plainOf(m) || "Вложение") : "Сообщение", sub: m ? fmtTime(m.created_at) : "", onPick: () => jumpToMessage(x.message_id) };
  }));
}

/* ---------------- expiring messages ---------------- */
export function dropExpiredLocally() {
  const now = Date.now();
  let changed = false;
  for (const [cid, list] of state.msgs) {
    const keep = list.filter((m) => !m.expires_at || new Date(m.expires_at).getTime() > now);
    if (keep.length !== list.length) {
      changed = true;
      state.msgs.set(cid, keep);
      if (cid === state.activeId) for (const m of list) if (!keep.includes(m)) document.querySelector('.msg[data-id="' + m.id + '"]')?.remove();
    }
  }
  if (changed) renderConvList();
}

/* ---------------- in-chat search ---------------- */
let hits = [], hitIdx = 0;
function runChatSearch(q) {
  state.searchQuery = q.trim();
  renderAllMessages();
  hits = state.searchQuery ? msgsOf(state.activeId).filter((m) => (plainOf(m) || "").toLowerCase().includes(state.searchQuery.toLowerCase())) : [];
  hitIdx = hits.length - 1;
  $("chat-search-count").textContent = hits.length ? hitIdx + 1 + "/" + hits.length : "0";
  if (hits.length) jumpToMessage(hits[hitIdx].id);
}
function stepSearch(d) {
  if (!hits.length) return;
  hitIdx = (hitIdx + d + hits.length) % hits.length;
  $("chat-search-count").textContent = hitIdx + 1 + "/" + hits.length;
  jumpToMessage(hits[hitIdx].id);
}

/* ---------------- composer ---------------- */
function autoGrow() {
  const t = $("msg-input");
  t.style.height = "auto";
  t.style.height = Math.min(160, t.scrollHeight) + "px";
}

export function bindMsgUi() {
  hooks.openConversation = openConversation;
  hooks.reopen = (id) => openConversation(id);
  hooks.renderAllMessages = renderAllMessages;
  hooks.appendMessage = appendMessage;
  hooks.refreshRow = refreshRow;
  hooks.markRead = markRead;
  hooks.loadPinned = loadPinned;
  hooks.jumpToMessage = jumpToMessage;
  hooks.sendFile = sendFile;
  hooks.scrollBottom = scrollBottom;
  hooks.atBottom = atBottom;

  const inp = $("msg-input");
  inp.addEventListener("input", () => {
    autoGrow();
    hooks.sendTyping?.();
    clearTimeout(bindMsgUi._d);
    bindMsgUi._d = setTimeout(() => { if (state.activeId) setCS(state.activeId, { draft: inp.value }); }, 700);
  });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && prefs.enter) { e.preventDefault(); sendMessage(); }
    if (e.key === "ArrowUp" && !inp.value.trim()) {
      const mine = msgsOf(state.activeId).filter((m) => m.sender_id === state.me.id && !m.attachment_url);
      if (mine.length) { e.preventDefault(); editMessage(mine[mine.length - 1]); }
    }
    if (e.key === "Escape") cancelReply();
  });
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
  $("reply-cancel").onclick = cancelReply;
  $("file-input").onchange = (e) => { for (const f of e.target.files) sendFile(f); e.target.value = ""; };
  inp.addEventListener("paste", (e) => {
    for (const it of e.clipboardData?.items || []) {
      if (it.kind === "file") { const f = it.getAsFile(); if (f) { e.preventDefault(); sendFile(f); } }
    }
  });

  $("btn-timer").onclick = () => {
    const i = TTLS.findIndex((t) => t.s === state.ttl);
    const next = TTLS[(i + 1) % TTLS.length];
    state.ttl = next.s;
    $("btn-timer").classList.toggle("on", !!next.s);
    $("btn-timer").title = "Таймер: " + next.label;
    toast("Самоудаление: " + next.label);
  };

  $("messages").addEventListener("scroll", () => {
    if (atBottom()) { state.newCount = 0; $("btn-scroll-down").classList.add("hidden"); markReadDebounced(); }
  });
  $("btn-scroll-down").onclick = () => scrollBottom(true);

  $("messages").addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "img") { hooks.openLightbox?.(t.dataset.url); return; }
    const m = byId(t.dataset.id);
    if (act === "jump") { jumpToMessage(t.dataset.id); return; }
    if (!m) return;
    if (act === "author") showUser(m.sender_id);
    if (act === "react") openEmojiPicker(t, (emoji) => toggleReaction(m.id, emoji));
    if (act === "toggle-react") toggleReaction(m.id, t.dataset.emoji);
    if (act === "reply") startReply(m);
    if (act === "forward") forwardMessage(m);
    if (act === "save") toggleSave(m);
    if (act === "pin") togglePin(m);
    if (act === "copy") { navigator.clipboard?.writeText(plainOf(m) || m.attachment_url || ""); toast("Скопировано"); }
    if (act === "link") {
      navigator.clipboard?.writeText(location.origin + location.pathname + "#c=" + m.conversation_id + "&m=" + m.id);
      toast("Ссылка на сообщение скопирована");
    }
    if (act === "edit") editMessage(m);
    if (act === "del") deleteMessage(m);
    if (act === "readers") showReaders(m);
  });

  $("btn-chat-search").onclick = () => {
    const bar = $("chat-search-bar");
    bar.classList.toggle("hidden");
    if (!bar.classList.contains("hidden")) $("chat-search-input").focus();
    else runChatSearch("");
  };
  let st;
  $("chat-search-input").oninput = (e) => { clearTimeout(st); st = setTimeout(() => runChatSearch(e.target.value), 250); };
  $("chat-search-prev").onclick = () => stepSearch(-1);
  $("chat-search-next").onclick = () => stepSearch(1);
  $("pinned-bar").ondblclick = showPinnedList;
  $("btn-saved").onclick = showSaved;
  $("btn-back").onclick = () => {
    document.body.classList.remove("chat-open");
    state.activeId = null;
    $("chat-view").classList.add("hidden");
    $("chat-empty").classList.remove("hidden");
    renderConvList();
  };

  const drop = $("drop-overlay");
  window.addEventListener("dragover", (e) => { e.preventDefault(); if (state.activeId) drop.classList.remove("hidden"); });
  window.addEventListener("dragleave", (e) => { if (e.relatedTarget === null) drop.classList.add("hidden"); });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.add("hidden");
    for (const f of e.dataTransfer?.files || []) sendFile(f);
  });

  setInterval(dropExpiredLocally, 5000);
  setInterval(() => sb.rpc("purge_expired").catch(() => {}), 60000);
}

let mrT;
function markReadDebounced() { clearTimeout(mrT); mrT = setTimeout(markRead, 600); }
export { markReadDebounced };
