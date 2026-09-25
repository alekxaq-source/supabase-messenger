import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);
const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👎", "🎉"];
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

const state = {
  me: null,
  convs: [],
  lastMsg: {},
  unread: {},
  activeId: null,
  msgs: new Map(),        // id -> message (active chat)
  reactions: new Map(),   // messageId -> [{user_id, emoji}]
  replyTo: null,
  online: new Set(),
  typingChannel: null,
  typingUsers: {},
  groupSelected: new Map(),
  profiles: new Map(),    // id -> profile
};

/* ================= helpers ================= */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nameOf = (p) => p?.display_name || p?.username || "Пользователь";
const initials = (s) => (s || "?").trim().slice(0, 1).toUpperCase();
const fmtTime = (d) => new Date(d).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const fmtDay = (d) => {
  const dt = new Date(d), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dt.toDateString() === now.toDateString()) return "Сегодня";
  if (dt.toDateString() === y.toDateString()) return "Вчера";
  return dt.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: dt.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};
const fmtListTime = (d) => new Date(d).toDateString() === new Date().toDateString() ? fmtTime(d) : new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
const colorFor = (id = "") => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; };
const linkify = (html) => html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

function toast(text, ms = 2200) {
  const t = $("toast"); t.textContent = text; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function setAvatar(el, label, seed, url, online = false) {
  el.textContent = url ? "" : initials(label);
  el.style.background = url ? `url("${url}") center/cover` : colorFor(seed);
  el.classList.toggle("online", !!online);
}
function cacheProfile(p) {
  if (!p?.id) return p;
  const existing = state.profiles.get(p.id);
  if (existing) { Object.assign(existing, p); return existing; }
  state.profiles.set(p.id, p); return p;
}
const profileById = (id) => state.profiles.get(id);
const activeConv = () => state.convs.find((c) => c.id === state.activeId);
function otherMember(conv) {
  const m = conv.conversation_members.find((m) => m.user_id !== state.me.id);
  return m ? profileById(m.user_id) : null;
}
const convTitle = (conv) => conv.is_group ? (conv.title || "Группа") : nameOf(otherMember(conv));
function lastSeenText(p) {
  if (!p) return "";
  if (state.online.has(p.id)) return "в сети";
  if (!p.last_seen_at) return "";
  return `был(а) ${fmtDay(p.last_seen_at).toLowerCase()} в ${fmtTime(p.last_seen_at)}`;
}
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }
document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.classList.add("hidden"); });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
    hideEmojiPicker();
    if (state.replyTo) setReply(null);
  }
});

/* ================= theme ================= */
$("btn-theme").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  localStorage.setItem("theme", t);
};

/* ================= auth ================= */
let mode = "login";
function setMode(m) {
  mode = m;
  $("tab-login").classList.toggle("active", m === "login");
  $("tab-signup").classList.toggle("active", m === "signup");
  $("auth-username").classList.toggle("hidden", m === "login");
  $("auth-username").required = m === "signup";
  $("auth-submit").textContent = m === "login" ? "Войти" : "Зарегистрироваться";
  $("auth-msg").textContent = "";
}
$("tab-login").onclick = () => setMode("login");
$("tab-signup").onclick = () => setMode("signup");

$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const msg = $("auth-msg");
  msg.textContent = "…";
  if (mode === "signup") {
    const username = $("auth-username").value.trim().toLowerCase().replace(/^@/, "");
    if (!USERNAME_RE.test(username)) { msg.textContent = "ID: только a-z, 0-9 и _, от 3 до 32 символов"; return; }
    const { data: free } = await sb.rpc("username_available", { name: username });
    if (free === false) { msg.textContent = "Этот ID уже занят"; return; }
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { username, display_name: username }, emailRedirectTo: location.href.split("#")[0] },
    });
    if (error) { msg.textContent = error.message; return; }
    if (!data.session) msg.textContent = "Готово! Подтвердите email по ссылке из письма, затем войдите.";
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) msg.textContent = error.message === "Email not confirmed" ? "Email не подтверждён" : "Неверный email или пароль";
  }
};
$("btn-logout").onclick = async () => {
  if (!confirm("Выйти из аккаунта?")) return;
  await touchLastSeen();
  await sb.auth.signOut(); location.reload();
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
    await new Promise((r) => setTimeout(r, 800));
    ({ data: me } = await sb.from("profiles").select("*").eq("id", user.id).single());
  }
  state.me = cacheProfile(me);
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderMe();
  await loadConversations();
  subscribeRealtime();
  subscribePresence();
  touchLastSeen();
  setInterval(touchLastSeen, 60_000);
}
function touchLastSeen() {
  if (!state.me) return;
  return sb.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", state.me.id);
}
function renderMe() {
  const me = state.me;
  $("me-name").textContent = nameOf(me);
  $("me-username").textContent = "@" + me.username;
  setAvatar($("me-avatar"), nameOf(me), me.id, me.avatar_url);
}

/* ================= my profile ================= */
let pendingAvatar; // undefined = no change, null = remove, File = upload
$("btn-my-profile").onclick = () => {
  const me = state.me;
  pendingAvatar = undefined;
  $("pf-name").value = me.display_name || "";
  $("pf-username").value = me.username;
  $("pf-bio").value = me.bio || "";
  $("pf-uuid").textContent = me.id;
  $("pf-msg").textContent = "";
  $("pf-username-hint").textContent = "a-z, 0-9, _ — от 3 до 32 символов";
  $("pf-username-hint").className = "small muted";
  setAvatar($("pf-avatar"), nameOf(me), me.id, me.avatar_url);
  openModal("profile-modal");
};
$("pf-copy-uuid").onclick = () => { navigator.clipboard.writeText(state.me.id); toast("ID скопирован"); };
$("pf-avatar-input").onchange = (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (!f.type.startsWith("image/")) return toast("Нужна картинка");
  if (f.size > 5 * 1024 * 1024) return toast("Максимум 5 МБ");
  pendingAvatar = f;
  setAvatar($("pf-avatar"), "", "", URL.createObjectURL(f));
};
$("pf-avatar-remove").onclick = () => { pendingAvatar = null; setAvatar($("pf-avatar"), $("pf-name").value || state.me.username, state.me.id, null); };

let unameTimer;
$("pf-username").oninput = (e) => {
  const hint = $("pf-username-hint");
  const v = e.target.value.trim().toLowerCase().replace(/^@/, "");
  clearTimeout(unameTimer);
  if (v === state.me.username) { hint.textContent = "Это ваш текущий ID"; hint.className = "small muted"; return; }
  if (!USERNAME_RE.test(v)) { hint.textContent = "Только a-z, 0-9 и _, от 3 до 32 символов"; hint.className = "small err"; return; }
  hint.textContent = "Проверяю…"; hint.className = "small muted";
  unameTimer = setTimeout(async () => {
    const { data: free } = await sb.rpc("username_available", { name: v });
    hint.textContent = free ? `@${v} свободен ✓` : `@${v} уже занят`;
    hint.className = "small " + (free ? "ok" : "err");
  }, 350);
};

$("pf-save").onclick = async () => {
  const msg = $("pf-msg");
  const username = $("pf-username").value.trim().toLowerCase().replace(/^@/, "");
  const display_name = $("pf-name").value.trim() || username;
  const bio = $("pf-bio").value.trim() || null;
  if (!USERNAME_RE.test(username)) { msg.textContent = "Некорректный ID"; return; }
  msg.textContent = "Сохраняю…";
  const update = { display_name, bio, username };
  if (pendingAvatar instanceof File) {
    const ext = (pendingAvatar.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${state.me.id}/avatar-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from("avatars").upload(path, pendingAvatar, { contentType: pendingAvatar.type, upsert: true });
    if (error) { msg.textContent = "Ошибка загрузки фото: " + error.message; return; }
    update.avatar_url = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  } else if (pendingAvatar === null) update.avatar_url = null;

  const { data, error } = await sb.from("profiles").update(update).eq("id", state.me.id).select().single();
  if (error) {
    msg.textContent = error.code === "23505" ? "Этот ID уже занят" : error.message;
    return;
  }
  cacheProfile(data);
  renderMe(); renderConvList(); renderChatHeader();
  closeModal("profile-modal");
  toast("Профиль сохранён");
};

/* ================= user profile view ================= */
async function showUser(userId) {
  if (userId === state.me.id) return $("btn-my-profile").click();
  let p = profileById(userId);
  const { data } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (data) p = cacheProfile(data);
  if (!p) return;
  setAvatar($("up-avatar"), nameOf(p), p.id, p.avatar_url, state.online.has(p.id));
  $("up-name").textContent = nameOf(p);
  $("up-username").textContent = "@" + p.username;
  $("up-status").textContent = lastSeenText(p);
  $("up-bio").textContent = p.bio || "";
  const dm = state.convs.find((c) => !c.is_group && c.conversation_members.some((m) => m.user_id === userId));
  $("up-delete-chat").classList.toggle("hidden", !dm);
  $("up-message").onclick = async () => { closeModal("user-modal"); await startDm(userId); };
  $("up-delete-chat").onclick = async () => {
    if (!confirm("Удалить этот чат у себя?")) return;
    await leaveConversation(dm.id);
    closeModal("user-modal");
  };
  openModal("user-modal");
}

/* ================= conversations ================= */
async function loadConversations() {
  const { data, error } = await sb
    .from("conversations")
    .select("id,is_group,title,last_message_at,created_by,conversation_members(user_id,role,last_read_at,profiles(id,username,display_name,avatar_url,last_seen_at,bio))")
    .order("last_message_at", { ascending: false });
  if (error) { console.error(error); toast("Ошибка загрузки чатов"); return; }
  data.forEach((c) => c.conversation_members.forEach((m) => { if (m.profiles) cacheProfile(m.profiles); delete m.profiles; }));
  state.convs = data;
  await Promise.all(data.map(refreshConvMeta));
  renderConvList();
  if (state.activeId && !activeConv()) closeChat();
}
async function refreshConvMeta(conv) {
  const myMember = conv.conversation_members.find((m) => m.user_id === state.me.id);
  const [{ data: last }, { count }] = await Promise.all([
    sb.from("messages").select("*").eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("messages").select("id", { count: "exact", head: true })
      .eq("conversation_id", conv.id).neq("sender_id", state.me.id).gt("created_at", myMember?.last_read_at || "1970-01-01"),
  ]);
  state.lastMsg[conv.id] = last || null;
  state.unread[conv.id] = conv.id === state.activeId ? 0 : count || 0;
}
function renderConvList() {
  const ul = $("conv-list");
  ul.innerHTML = "";
  const sorted = [...state.convs].sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  if (!sorted.length) {
    ul.innerHTML = `<li class="muted small" style="cursor:default">Пока нет чатов. Найдите пользователя по имени или @id выше.</li>`;
  }
  let totalUnread = 0;
  for (const c of sorted) {
    const li = document.createElement("li");
    if (c.id === state.activeId) li.classList.add("active");
    const last = state.lastMsg[c.id];
    const other = otherMember(c);
    const title = convTitle(c);
    let preview = last ? (last.content || "📎 Вложение") : "Нет сообщений";
    if (last && last.sender_id === state.me.id) preview = "Вы: " + preview;
    else if (last && c.is_group) preview = nameOf(profileById(last.sender_id)) + ": " + preview;
    const typingHere = c.id === state.activeId ? "" : "";
    const unread = state.unread[c.id] || 0;
    totalUnread += unread;
    li.innerHTML = `
      <div class="avatar"></div>
      <div class="conv-info">
        <div class="conv-top"><span class="bold ellipsis">${esc(title)} ${c.is_group ? '<span class="tag">группа</span>' : ""}</span><span class="muted small">${last ? fmtListTime(last.created_at) : ""}</span></div>
        <div class="conv-top"><span class="muted small ellipsis">${esc(preview)}${typingHere}</span>${unread ? `<span class="badge">${unread}</span>` : ""}</div>
      </div>`;
    setAvatar(li.querySelector(".avatar"), title, c.is_group ? c.id : other?.id, c.is_group ? null : other?.avatar_url,
      !c.is_group && other && state.online.has(other.id));
    li.onclick = () => openConversation(c.id);
    ul.appendChild(li);
  }
  document.title = totalUnread ? `(${totalUnread}) Messenger` : "Messenger";
}
async function leaveConversation(convId) {
  const { error } = await sb.from("conversation_members").delete().eq("conversation_id", convId).eq("user_id", state.me.id);
  if (error) return toast(error.message);
  state.convs = state.convs.filter((c) => c.id !== convId);
  if (state.activeId === convId) closeChat();
  renderConvList();
}

/* ================= user search / DM ================= */
async function searchUsers(q) {
  q = q.trim().replace(/^@/, "").replace(/[%,()*]/g, "");
  if (!q) return [];
  const { data } = await sb.from("profiles").select("id,username,display_name,avatar_url,last_seen_at,bio")
    .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
    .neq("id", state.me.id).limit(15);
  return (data || []).map(cacheProfile);
}
function renderUserList(ul, users, onPick, extra) {
  ul.innerHTML = "";
  if (!users.length) { ul.innerHTML = `<li class="muted small">Никого не найдено</li>`; return; }
  for (const u of users) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="avatar sm"></div><div class="ellipsis" style="flex:1"><div class="bold ellipsis">${esc(nameOf(u))}</div><div class="muted small">@${esc(u.username)}</div></div>${extra ? extra(u) : ""}`;
    setAvatar(li.querySelector(".avatar"), nameOf(u), u.id, u.avatar_url, state.online.has(u.id));
    li.onclick = (e) => onPick(u, e);
    ul.appendChild(li);
  }
}
async function startDm(userId) {
  const { data: convId, error } = await sb.rpc("get_or_create_dm", { other_user: userId });
  if (error) return toast(error.message);
  if (!state.convs.find((c) => c.id === convId)) await loadConversations();
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
    renderUserList(ul, users, (u) => {
      ul.classList.add("hidden");
      $("user-search").value = "";
      showUser(u.id);
    });
  }, 250);
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search")) $("search-results").classList.add("hidden");
  if (!e.target.closest("#emoji-picker") && !e.target.closest('[data-a="react"]')) hideEmojiPicker();
});

/* ================= new group ================= */
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
    s.className = "chip"; s.textContent = nameOf(u) + " ✕";
    s.onclick = () => { state.groupSelected.delete(u.id); renderChips(); };
    box.appendChild(s);
  }
}
$("group-create").onclick = async () => {
  const title = $("group-title").value.trim();
  if (!title) return toast("Введите название");
  if (!state.groupSelected.size) return toast("Добавьте хотя бы одного участника");
  const { data: convId, error } = await sb.rpc("create_group", { group_title: title, member_ids: [...state.groupSelected.keys()] });
  if (error) return toast(error.message);
  closeModal("group-modal");
  await loadConversations();
  openConversation(convId);
};

/* ================= group info ================= */
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
  $("gi-count").textContent = `(${members.length})`;
  renderUserList($("gi-members"), members, (u) => { closeModal("ginfo-modal"); showUser(u.id); },
    (u) => `${u.role === "owner" ? '<span class="tag">создатель</span>' : ""}${u.id === state.me.id ? '<span class="tag">вы</span>' : ""}<span class="small muted">${state.online.has(u.id) ? "в сети" : ""}</span>`);
}
$("gi-rename").onclick = async () => {
  const title = $("gi-title").value.trim();
  if (!title) return;
  const { error } = await sb.from("conversations").update({ title }).eq("id", state.activeId);
  if (error) return toast(error.message);
  activeConv().title = title;
  renderChatHeader(); renderConvList(); toast("Название изменено");
};
let giTimer;
$("gi-add-search").oninput = (e) => {
  clearTimeout(giTimer);
  giTimer = setTimeout(async () => {
    const conv = activeConv();
    const ids = new Set(conv.conversation_members.map((m) => m.user_id));
    const users = (await searchUsers(e.target.value)).filter((u) => !ids.has(u.id));
    renderUserList($("gi-add-results"), users, async (u) => {
      const { error } = await sb.rpc("add_group_members", { conv: conv.id, member_ids: [u.id] });
      if (error) return toast(error.message);
      conv.conversation_members.push({ user_id: u.id, role: "member", last_read_at: new Date(0).toISOString() });
      $("gi-add-search").value = ""; $("gi-add-results").innerHTML = "";
      renderGroupMembers(); renderChatHeader();
      toast(`${nameOf(u)} добавлен(а)`);
    }, () => '<span class="small">➕</span>');
  }, 250);
};
$("gi-leave").onclick = async () => {
  if (!confirm("Покинуть группу?")) return;
  const id = state.activeId;
  closeModal("ginfo-modal");
  await leaveConversation(id);
};

/* ================= chat ================= */
async function openConversation(id) {
  const conv = state.convs.find((c) => c.id === id);
  if (!conv) return;
  state.activeId = id;
  state.unread[id] = 0;
  state.msgs.clear(); state.reactions.clear();
  setReply(null);
  closeChatSearch();
  $("app").classList.add("in-chat");
  $("chat-empty").classList.add("hidden");
  $("chat-view").classList.remove("hidden");
  renderChatHeader();
  renderConvList();

  const box = $("messages");
  box.innerHTML = `<div class="empty">Загрузка…</div>`;
  const { data: msgs } = await sb.from("messages").select("*").eq("conversation_id", id)
    .order("created_at", { ascending: false }).limit(300);
  if (state.activeId !== id) return;
  const list = (msgs || []).reverse();
  list.forEach((m) => state.msgs.set(m.id, m));
  if (list.length) {
    const { data: reacts } = await sb.from("message_reactions").select("message_id,user_id,emoji").in("message_id", list.map((m) => m.id));
    (reacts || []).forEach(addReactionToState);
  }
  if (state.activeId !== id) return;
  renderAllMessages();
  box.scrollTop = box.scrollHeight;
  markRead(id);
  joinTypingChannel(id);
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

function renderChatHeader() {
  const conv = activeConv();
  if (!conv) return;
  const other = otherMember(conv);
  const title = convTitle(conv);
  $("chat-title").textContent = title;
  if (conv.is_group) {
    const n = conv.conversation_members.length;
    const on = conv.conversation_members.filter((m) => state.online.has(m.user_id)).length;
    $("chat-sub").textContent = `${n} участник(ов)` + (on ? `, ${on} в сети` : "");
  } else {
    $("chat-sub").textContent = lastSeenText(other) || "@" + (other?.username || "");
  }
  setAvatar($("chat-avatar"), title, conv.is_group ? conv.id : other?.id, conv.is_group ? null : other?.avatar_url,
    !conv.is_group && other && state.online.has(other.id));
}
const openChatInfo = () => {
  const conv = activeConv(); if (!conv) return;
  if (conv.is_group) showGroupInfo(); else { const o = otherMember(conv); if (o) showUser(o.id); }
};
$("chat-head-info").onclick = openChatInfo;
$("btn-chat-info").onclick = openChatInfo;

/* ---------- rendering messages ---------- */
function renderAllMessages() {
  const box = $("messages");
  box.innerHTML = "";
  lastRenderedDay = null;
  const list = [...state.msgs.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (!list.length) { box.innerHTML = `<div class="empty">Напишите первое сообщение 👋</div>`; return; }
  list.forEach(appendMessage);
}
let lastRenderedDay = null;
function appendMessage(m) {
  const box = $("messages");
  box.querySelector(".empty")?.remove();
  const day = new Date(m.created_at).toDateString();
  if (day !== lastRenderedDay) {
    lastRenderedDay = day;
    const d = document.createElement("div"); d.className = "day"; d.textContent = fmtDay(m.created_at);
    box.appendChild(d);
  }
  const row = document.createElement("div");
  row.className = "msg-row" + (m.sender_id === state.me.id ? " mine" : "");
  row.dataset.id = m.id;
  fillRow(row, m);
  box.appendChild(row);
}
function isReadByOthers(m) {
  const conv = state.convs.find((c) => c.id === m.conversation_id);
  if (!conv) return false;
  return conv.conversation_members.some((x) => x.user_id !== state.me.id && new Date(x.last_read_at) >= new Date(m.created_at));
}
function fillRow(row, m) {
  const conv = state.convs.find((c) => c.id === m.conversation_id);
  const mine = m.sender_id === state.me.id;

  const q = chatSearchQuery;
  const hl = (html) => q ? html.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (s) => `<mark>${s}</mark>`) : html;
  let html = "";
  if (conv?.is_group && !mine) html += `<div class="author" data-user="${m.sender_id}">${esc(nameOf(profileById(m.sender_id)))}</div>`;
  if (m.reply_to) {
    const r = state.msgs.get(m.reply_to);
    html += `<div class="quote" data-jump="${m.reply_to}"><b>${esc(r ? nameOf(profileById(r.sender_id)) : "Сообщение")}</b>${esc(r ? (r.content || "📎 Вложение") : "сообщение недоступно")}</div>`;
  }
  if (m.attachment_url) {
    const isImg = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|$)/i.test(m.attachment_url);
    html += isImg ? `<a href="${esc(m.attachment_url)}" target="_blank" rel="noopener"><img src="${esc(m.attachment_url)}" alt="" loading="lazy" /></a>`
                  : `<a href="${esc(m.attachment_url)}" target="_blank" rel="noopener">📎 ${esc(decodeURIComponent(m.attachment_url.split("/").pop().replace(/^\d+-/, "")))}</a>`;
  }
  if (m.content) html += `<div class="text">${hl(linkify(esc(m.content)))}</div>`;
  const check = mine ? `<span class="check ${isReadByOthers(m) ? "read" : ""}">${isReadByOthers(m) ? "✓✓" : "✓"}</span>` : "";
  html += `<div class="meta">${m.edited_at ? "изм. " : ""}${fmtTime(m.created_at)}${check}</div>`;

  const actions = `<div class="actions">
    <button data-a="react" title="Реакция">😊</button>
    <button data-a="reply" title="Ответить">↩️</button>
    ${m.content ? `<button data-a="copy" title="Копировать">📋</button>` : ""}
    ${mine && m.content ? `<button data-a="edit" title="Изменить">✏️</button>` : ""}
    ${mine ? `<button data-a="del" title="Удалить">🗑️</button>` : ""}
  </div>`;
  row.innerHTML = `${actions}<div class="bubble">${html}</div><div class="reactions"></div>`;
  renderReactions(row, m.id);

  row.querySelector(".author")?.addEventListener("click", () => showUser(m.sender_id));
  row.querySelector(".quote")?.addEventListener("click", () => jumpTo(m.reply_to));
  row.querySelector(".bubble").addEventListener("click", (e) => {
    if (e.target.closest("a,.quote,.author")) return;
    document.querySelectorAll(".msg-row.show-actions").forEach((r) => r !== row && r.classList.remove("show-actions"));
    row.classList.toggle("show-actions");
  });
  row.querySelector('[data-a="react"]').onclick = (e) => showEmojiPicker(e.currentTarget, m.id);
  row.querySelector('[data-a="reply"]').onclick = () => setReply(m);
  row.querySelector('[data-a="copy"]')?.addEventListener("click", () => { navigator.clipboard.writeText(m.content); toast("Скопировано"); });
  row.querySelector('[data-a="edit"]')?.addEventListener("click", async () => {
    const text = prompt("Изменить сообщение", m.content);
    if (text == null || !text.trim() || text === m.content) return;
    const { error } = await sb.from("messages").update({ content: text.trim(), edited_at: new Date().toISOString() }).eq("id", m.id);
    if (error) toast(error.message);
  });
  row.querySelector('[data-a="del"]')?.addEventListener("click", async () => {
    if (!confirm("Удалить сообщение для всех?")) return;
    const { error } = await sb.from("messages").delete().eq("id", m.id);
    if (error) toast(error.message); else removeMessage(m.id);
  });
}
function rerenderMessage(id) {
  const row = document.querySelector(`.msg-row[data-id="${id}"]`);
  const m = state.msgs.get(id);
  if (row && m) fillRow(row, m);
}
function removeMessage(id) {
  state.msgs.delete(id);
  document.querySelector(`.msg-row[data-id="${id}"]`)?.remove();
  document.querySelectorAll(`.quote[data-jump="${id}"]`).forEach((q) => { q.innerHTML = "<b>Сообщение</b>удалено"; });
}
function updateAllChecks() {
  document.querySelectorAll(".msg-row.mine").forEach((row) => {
    const m = state.msgs.get(row.dataset.id);
    const el = row.querySelector(".check");
    if (!m || !el) return;
    const read = isReadByOthers(m);
    el.classList.toggle("read", read);
    el.textContent = read ? "✓✓" : "✓";
  });
}
async function jumpTo(id) {
  const row = document.querySelector(`.msg-row[data-id="${id}"]`);
  if (!row) return toast("Сообщение не найдено");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("highlight");
  setTimeout(() => row.classList.remove("highlight"), 1500);
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
    b.textContent = `${emoji} ${users.length}`;
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
  const row = document.querySelector(`.msg-row[data-id="${messageId}"]`);
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

/* ---------- reply ---------- */
function setReply(m) {
  state.replyTo = m;
  $("reply-bar").classList.toggle("hidden", !m);
  if (m) {
    $("reply-name").textContent = "Ответ " + nameOf(profileById(m.sender_id));
    $("reply-text").textContent = m.content || "📎 Вложение";
    $("msg-input").focus();
  }
}
$("reply-cancel").onclick = () => setReply(null);

/* ---------- composer ---------- */
const input = $("msg-input");
function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; }
input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
  if (e.key === "ArrowUp" && !input.value) {
    const mineLast = [...state.msgs.values()].filter((m) => m.sender_id === state.me.id && m.content).pop();
    if (mineLast) document.querySelector(`.msg-row[data-id="${mineLast.id}"] [data-a="edit"]`)?.click();
  }
});
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const content = input.value.trim();
  if (!content || !state.activeId) return;
  const reply_to = state.replyTo?.id || null;
  input.value = ""; autoGrow(); setReply(null);
  const { error } = await sb.from("messages").insert({ conversation_id: state.activeId, content, reply_to });
  if (error) { toast(error.message); input.value = content; autoGrow(); }
};

async function sendFile(file) {
  if (!file || !state.activeId) return;
  if (file.size > 20 * 1024 * 1024) return toast("Максимум 20 МБ");
  toast("Загружаю файл…", 10000);
  const safe = (file.name || "file.png").replace(/[^\w.\-]+/g, "_");
  const path = `${state.me.id}/${Date.now()}-${safe}`;
  const { error: upErr } = await sb.storage.from("attachments").upload(path, file, { contentType: file.type });
  if (upErr) return toast(upErr.message);
  const { data } = sb.storage.from("attachments").getPublicUrl(path);
  const content = input.value.trim() || null;
  const reply_to = state.replyTo?.id || null;
  input.value = ""; autoGrow(); setReply(null);
  const { error } = await sb.from("messages").insert({ conversation_id: state.activeId, content, attachment_url: data.publicUrl, reply_to });
  if (error) toast(error.message); else toast("Файл отправлен");
}
$("file-input").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; sendFile(f); };

input.addEventListener("paste", (e) => {
  const f = [...(e.clipboardData?.files || [])][0];
  if (f) { e.preventDefault(); sendFile(f); }
});
const chatEl = $("chat");
let dragDepth = 0;
chatEl.addEventListener("dragenter", (e) => { if (!state.activeId || !e.dataTransfer?.types.includes("Files")) return; dragDepth++; $("drop-overlay").classList.remove("hidden"); });
chatEl.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-overlay").classList.add("hidden"); } });
chatEl.addEventListener("dragover", (e) => e.preventDefault());
chatEl.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("drop-overlay").classList.add("hidden");
  const f = e.dataTransfer?.files?.[0]; if (f) sendFile(f);
});

async function markRead(convId) {
  const now = new Date().toISOString();
  const conv = state.convs.find((c) => c.id === convId);
  const me = conv?.conversation_members.find((m) => m.user_id === state.me.id);
  if (me) me.last_read_at = now;
  await sb.from("conversation_members").update({ last_read_at: now }).eq("conversation_id", convId).eq("user_id", state.me.id);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.activeId) { state.unread[state.activeId] = 0; markRead(state.activeId); renderConvList(); }
});

/* ---------- in-chat search ---------- */
let chatSearchQuery = "";
$("btn-chat-search").onclick = () => {
  const bar = $("chat-search-bar");
  if (bar.classList.contains("hidden")) { bar.classList.remove("hidden"); $("chat-search-input").focus(); }
  else closeChatSearch();
};
function closeChatSearch() {
  $("chat-search-bar").classList.add("hidden");
  $("chat-search-input").value = ""; $("chat-search-count").textContent = "";
  if (chatSearchQuery) { chatSearchQuery = ""; renderAllMessages(); }
}
let csTimer;
$("chat-search-input").oninput = (e) => {
  clearTimeout(csTimer);
  csTimer = setTimeout(() => {
    chatSearchQuery = e.target.value.trim();
    renderAllMessages();
    if (!chatSearchQuery) { $("chat-search-count").textContent = ""; return; }
    const found = [...state.msgs.values()].filter((m) => m.content?.toLowerCase().includes(chatSearchQuery.toLowerCase()));
    $("chat-search-count").textContent = found.length ? `найдено: ${found.length}` : "ничего";
    if (found.length) jumpTo(found[found.length - 1].id);
  }, 250);
};

/* ================= typing (broadcast) ================= */
function joinTypingChannel(convId) {
  leaveTypingChannel();
  state.typingUsers = {};
  renderTyping();
  state.typingChannel = sb.channel("typing:" + convId, { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (payload.user_id === state.me.id) return;
      clearTimeout(state.typingUsers[payload.user_id]?.t);
      state.typingUsers[payload.user_id] = { name: payload.name, t: setTimeout(() => { delete state.typingUsers[payload.user_id]; renderTyping(); }, 3000) };
      renderTyping();
    })
    .subscribe();
}
function leaveTypingChannel() {
  if (state.typingChannel) sb.removeChannel(state.typingChannel);
  state.typingChannel = null;
}
function renderTyping() {
  const names = Object.values(state.typingUsers).map((u) => u.name);
  $("typing").textContent = names.length ? `${names.join(", ")} печатает…` : "";
}
let lastTypingSent = 0;
input.addEventListener("input", () => {
  if (!state.typingChannel || Date.now() - lastTypingSent < 1500) return;
  lastTypingSent = Date.now();
  state.typingChannel.send({ type: "broadcast", event: "typing", payload: { user_id: state.me.id, name: nameOf(state.me) } });
});

/* ================= presence ================= */
function subscribePresence() {
  const ch = sb.channel("online", { config: { presence: { key: state.me.id } } });
  ch.on("presence", { event: "sync" }, () => {
    state.online = new Set(Object.keys(ch.presenceState()));
    renderConvList();
    renderChatHeader();
  }).subscribe(async (status) => {
    if (status === "SUBSCRIBED") await ch.track({ at: Date.now() });
  });
  window.addEventListener("beforeunload", () => { touchLastSeen(); });
}

/* ================= realtime DB changes ================= */
function subscribeRealtime() {
  sb.channel("db-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, async ({ new: m }) => {
      let conv = state.convs.find((c) => c.id === m.conversation_id);
      if (!conv) { await loadConversations(); conv = state.convs.find((c) => c.id === m.conversation_id); if (!conv) return; }
      conv.last_message_at = m.created_at;
      state.lastMsg[m.conversation_id] = m;
      if (m.conversation_id === state.activeId) {
        state.msgs.set(m.id, m);
        const box = $("messages");
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
        appendMessage(m);
        if (nearBottom || m.sender_id === state.me.id) box.scrollTop = box.scrollHeight;
        if (m.sender_id !== state.me.id) {
          delete state.typingUsers[m.sender_id]; renderTyping();
          if (!document.hidden) markRead(m.conversation_id);
          else { state.unread[m.conversation_id] = (state.unread[m.conversation_id] || 0) + 1; notify(conv, m); }
        }
      } else if (m.sender_id !== state.me.id) {
        state.unread[m.conversation_id] = (state.unread[m.conversation_id] || 0) + 1;
        notify(conv, m);
      }
      renderConvList();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, ({ new: m }) => {
      if (state.msgs.has(m.id)) { state.msgs.set(m.id, m); rerenderMessage(m.id); }
      if (state.lastMsg[m.conversation_id]?.id === m.id) { state.lastMsg[m.conversation_id] = m; renderConvList(); }
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, async ({ old }) => {
      removeMessage(old.id);
      const convId = Object.keys(state.lastMsg).find((k) => state.lastMsg[k]?.id === old.id);
      if (convId) { await refreshConvMeta(state.convs.find((c) => c.id === convId)); renderConvList(); }
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "message_reactions" }, ({ new: r }) => {
      if (!state.msgs.has(r.message_id)) return;
      addReactionToState(r); rerenderReactions(r.message_id);
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "message_reactions" }, ({ old: r }) => {
      if (!state.msgs.has(r.message_id)) return;
      removeReactionFromState(r); rerenderReactions(r.message_id);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "conversation_members" }, (p) => {
      const row = p.new?.conversation_id ? p.new : p.old;
      if (p.eventType === "UPDATE") {
        const conv = state.convs.find((c) => c.id === row.conversation_id);
        const mem = conv?.conversation_members.find((m) => m.user_id === row.user_id);
        if (mem) { mem.last_read_at = row.last_read_at; if (conv.id === state.activeId) updateAllChecks(); }
      } else {
        loadConversations().then(() => { if (state.activeId) { renderChatHeader(); } });
      }
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations" }, ({ new: c }) => {
      const conv = state.convs.find((x) => x.id === c.id);
      if (!conv) return;
      conv.title = c.title; conv.last_message_at = c.last_message_at;
      renderConvList(); if (c.id === state.activeId) renderChatHeader();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles" }, ({ new: p }) => {
      if (!state.profiles.has(p.id)) return;
      cacheProfile(p);
      if (p.id === state.me.id) renderMe();
      renderConvList(); renderChatHeader();
    })
    .subscribe();
}

/* ================= notifications ================= */
if ("Notification" in window && Notification.permission === "default") {
  document.addEventListener("click", () => Notification.requestPermission(), { once: true });
}
function notify(conv, m) {
  if (!("Notification" in window) || Notification.permission !== "granted" || (document.hasFocus() && m.conversation_id === state.activeId)) return;
  if (document.hasFocus()) return;
  const who = nameOf(profileById(m.sender_id));
  const n = new Notification(conv.is_group ? `${convTitle(conv)} — ${who}` : who, { body: m.content || "📎 Вложение", icon: profileById(m.sender_id)?.avatar_url || undefined });
  n.onclick = () => { window.focus(); openConversation(conv.id); };
}

/* ================= init ================= */
setMode("login");
const { data: { session } } = await sb.auth.getSession();
if (!session) $("auth").classList.remove("hidden");
