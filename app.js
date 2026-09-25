import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

const state = {
  me: null,            // profile
  convs: [],           // conversations with members
  lastMsg: {},         // convId -> message
  unread: {},          // convId -> number
  activeId: null,
  online: new Set(),
  typingChannel: null,
  typingUsers: {},     // userId -> timeout
  groupSelected: new Map(),
  profilesCache: new Map(),
};

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nameOf = (p) => p?.display_name || p?.username || "Пользователь";
const initials = (s) => (s || "?").trim().slice(0, 1).toUpperCase();
const fmtTime = (d) => new Date(d).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const fmtDay = (d) => new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const colorFor = (id = "") => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; };

function setAvatar(el, label, seed, url, online = false) {
  el.textContent = url ? "" : initials(label);
  el.style.background = url ? `url("${url}") center/cover` : colorFor(seed);
  el.classList.toggle("online", online);
}
function otherMember(conv) {
  return conv.conversation_members.find((m) => m.user_id !== state.me.id)?.profiles;
}
function convTitle(conv) {
  if (conv.is_group) return conv.title || "Группа";
  return nameOf(otherMember(conv));
}
function profileById(id) {
  for (const c of state.convs) {
    const m = c.conversation_members.find((x) => x.user_id === id);
    if (m?.profiles) return m.profiles;
  }
  return state.profilesCache.get(id);
}

/* ---------------- auth ---------------- */
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
    const username = $("auth-username").value.trim().toLowerCase();
    const { data: taken } = await sb.from("profiles").select("id").eq("username", username).maybeSingle();
    if (taken) { msg.textContent = "Это имя уже занято"; return; }
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

$("btn-logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };

let started = false;
sb.auth.onAuthStateChange((_evt, session) => {
  if (session && !started) { started = true; setTimeout(() => start(session.user), 0); }
  if (!session) { $("auth").classList.remove("hidden"); $("app").classList.add("hidden"); }
});

/* ---------------- boot ---------------- */
async function start(user) {
  let { data: me } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!me) { // trigger may lag a moment
    await new Promise((r) => setTimeout(r, 800));
    ({ data: me } = await sb.from("profiles").select("*").eq("id", user.id).single());
  }
  state.me = me;
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("me-name").textContent = nameOf(me);
  $("me-username").textContent = "@" + me.username;
  setAvatar($("me-avatar"), nameOf(me), me.id, me.avatar_url);

  await loadConversations();
  subscribeRealtime();
  subscribePresence();
  sb.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", me.id).then(() => {});
}

/* ---------------- conversations ---------------- */
async function loadConversations() {
  const { data, error } = await sb
    .from("conversations")
    .select("id,is_group,title,last_message_at,created_by,conversation_members(user_id,last_read_at,profiles(id,username,display_name,avatar_url,last_seen_at))")
    .order("last_message_at", { ascending: false });
  if (error) { console.error(error); return; }
  state.convs = data;
  await Promise.all(data.map(refreshConvMeta));
  renderConvList();
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
    ul.innerHTML = `<li class="muted small" style="cursor:default">Пока нет чатов. Найдите пользователя по имени выше.</li>`;
    return;
  }
  for (const c of sorted) {
    const li = document.createElement("li");
    if (c.id === state.activeId) li.classList.add("active");
    const last = state.lastMsg[c.id];
    const other = otherMember(c);
    const title = convTitle(c);
    let preview = last ? (last.content || "📎 Вложение") : "Нет сообщений";
    if (last && last.sender_id === state.me.id) preview = "Вы: " + preview;
    else if (last && c.is_group) preview = nameOf(profileById(last.sender_id)) + ": " + preview;
    const unread = state.unread[c.id] || 0;
    li.innerHTML = `
      <div class="avatar"></div>
      <div class="conv-info">
        <div class="conv-top"><span class="bold preview">${esc(title)}</span><span class="muted small">${last ? fmtTime(last.created_at) : ""}</span></div>
        <div class="conv-top"><span class="muted small preview">${esc(preview)}</span>${unread ? `<span class="badge">${unread}</span>` : ""}</div>
      </div>`;
    setAvatar(li.querySelector(".avatar"), title, c.is_group ? c.id : other?.id, c.is_group ? null : other?.avatar_url,
      !c.is_group && other && state.online.has(other.id));
    li.onclick = () => openConversation(c.id);
    ul.appendChild(li);
  }
}

/* ---------------- user search / DM ---------------- */
async function searchUsers(q) {
  q = q.trim();
  if (!q) return [];
  const { data } = await sb.from("profiles").select("id,username,display_name,avatar_url")
    .or(`username.ilike.%${q.replace(/[%,()]/g, "")}%,display_name.ilike.%${q.replace(/[%,()]/g, "")}%`)
    .neq("id", state.me.id).limit(10);
  (data || []).forEach((p) => state.profilesCache.set(p.id, p));
  return data || [];
}
function renderUserList(ul, users, onPick) {
  ul.innerHTML = "";
  if (!users.length) { ul.innerHTML = `<li class="muted small">Никого не найдено</li>`; return; }
  for (const u of users) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="avatar"></div><div><div class="bold">${esc(nameOf(u))}</div><div class="muted small">@${esc(u.username)}</div></div>`;
    setAvatar(li.querySelector(".avatar"), nameOf(u), u.id, u.avatar_url, state.online.has(u.id));
    li.onclick = () => onPick(u);
    ul.appendChild(li);
  }
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
    renderUserList(ul, users, async (u) => {
      ul.classList.add("hidden");
      $("user-search").value = "";
      const { data: convId, error } = await sb.rpc("get_or_create_dm", { other_user: u.id });
      if (error) return alert(error.message);
      if (!state.convs.find((c) => c.id === convId)) await loadConversations();
      openConversation(convId);
    });
  }, 250);
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search")) $("search-results").classList.add("hidden");
});

/* ---------------- groups ---------------- */
$("btn-new-group").onclick = () => {
  state.groupSelected.clear();
  $("group-title").value = ""; $("group-search").value = "";
  $("group-results").innerHTML = ""; renderChips();
  $("group-modal").classList.remove("hidden");
  $("group-title").focus();
};
$("group-cancel").onclick = () => $("group-modal").classList.add("hidden");
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
  if (!title) return alert("Введите название");
  if (!state.groupSelected.size) return alert("Добавьте хотя бы одного участника");
  const { data: convId, error } = await sb.rpc("create_group", { group_title: title, member_ids: [...state.groupSelected.keys()] });
  if (error) return alert(error.message);
  $("group-modal").classList.add("hidden");
  await loadConversations();
  openConversation(convId);
};

/* ---------------- chat ---------------- */
async function openConversation(id) {
  const conv = state.convs.find((c) => c.id === id);
  if (!conv) return;
  state.activeId = id;
  state.unread[id] = 0;
  $("app").classList.add("in-chat");
  $("chat-empty").classList.add("hidden");
  $("chat-view").classList.remove("hidden");
  renderChatHeader();
  renderConvList();

  const box = $("messages");
  box.innerHTML = `<div class="empty">Загрузка…</div>`;
  const { data: msgs } = await sb.from("messages").select("*").eq("conversation_id", id)
    .order("created_at", { ascending: false }).limit(200);
  if (state.activeId !== id) return;
  box.innerHTML = "";
  lastRenderedDay = null;
  (msgs || []).reverse().forEach(appendMessage);
  if (!msgs?.length) box.innerHTML = `<div class="empty">Напишите первое сообщение 👋</div>`;
  box.scrollTop = box.scrollHeight;
  markRead(id);
  joinTypingChannel(id);
  $("msg-input").focus();
}

function renderChatHeader() {
  const conv = state.convs.find((c) => c.id === state.activeId);
  if (!conv) return;
  const other = otherMember(conv);
  const title = convTitle(conv);
  $("chat-title").textContent = title;
  if (conv.is_group) {
    const n = conv.conversation_members.length;
    const on = conv.conversation_members.filter((m) => state.online.has(m.user_id)).length;
    $("chat-sub").textContent = `${n} участник(ов)` + (on ? `, ${on} в сети` : "");
  } else {
    const online = other && state.online.has(other.id);
    $("chat-sub").textContent = online ? "в сети" : other?.last_seen_at ? "был(а) " + fmtDay(other.last_seen_at) + " " + fmtTime(other.last_seen_at) : "@" + (other?.username || "");
  }
  setAvatar($("chat-avatar"), title, conv.is_group ? conv.id : other?.id, conv.is_group ? null : other?.avatar_url,
    !conv.is_group && other && state.online.has(other.id));
}
$("btn-back").onclick = () => { state.activeId = null; $("app").classList.remove("in-chat"); leaveTypingChannel(); renderConvList(); };

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
  const conv = state.convs.find((c) => c.id === m.conversation_id);
  const mine = m.sender_id === state.me.id;
  const div = document.createElement("div");
  div.className = "bubble" + (mine ? " mine" : "");
  div.dataset.id = m.id;
  div.innerHTML = renderBubble(m, conv, mine);
  bindBubble(div, m);
  box.appendChild(div);
}
function renderBubble(m, conv, mine) {
  let html = "";
  if (conv?.is_group && !mine) html += `<div class="author">${esc(nameOf(profileById(m.sender_id)))}</div>`;
  if (m.attachment_url) {
    const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(m.attachment_url);
    html += isImg ? `<a href="${esc(m.attachment_url)}" target="_blank" rel="noopener"><img src="${esc(m.attachment_url)}" alt="" /></a>`
                  : `<a href="${esc(m.attachment_url)}" target="_blank" rel="noopener">📎 ${esc(decodeURIComponent(m.attachment_url.split("/").pop().replace(/^\d+-/, "")))}</a>`;
  }
  if (m.content) html += `<div class="text">${esc(m.content)}</div>`;
  html += `<div class="meta">${m.edited_at ? "изм. " : ""}${fmtTime(m.created_at)}</div>`;
  if (mine) html += `<div class="actions">${m.content ? `<button data-a="edit">✎</button>` : ""}<button data-a="del">🗑</button></div>`;
  return html;
}
function bindBubble(div, m) {
  div.querySelector('[data-a="edit"]')?.addEventListener("click", async () => {
    const text = prompt("Изменить сообщение", m.content);
    if (text == null || !text.trim() || text === m.content) return;
    const { error } = await sb.from("messages").update({ content: text.trim(), edited_at: new Date().toISOString() }).eq("id", m.id);
    if (error) alert(error.message);
  });
  div.querySelector('[data-a="del"]')?.addEventListener("click", async () => {
    if (!confirm("Удалить сообщение?")) return;
    const { error } = await sb.from("messages").delete().eq("id", m.id);
    if (error) alert(error.message); else removeMessageEl(m.id);
  });
}
function removeMessageEl(id) {
  document.querySelector(`.bubble[data-id="${id}"]`)?.remove();
}

$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("msg-input");
  const content = input.value.trim();
  if (!content || !state.activeId) return;
  input.value = "";
  const { error } = await sb.from("messages").insert({ conversation_id: state.activeId, content });
  if (error) { alert(error.message); input.value = content; }
};

$("file-input").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.activeId) return;
  if (file.size > 20 * 1024 * 1024) return alert("Максимум 20 МБ");
  const safe = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${state.me.id}/${Date.now()}-${safe}`;
  const { error: upErr } = await sb.storage.from("attachments").upload(path, file, { contentType: file.type });
  if (upErr) return alert(upErr.message);
  const { data } = sb.storage.from("attachments").getPublicUrl(path);
  const content = $("msg-input").value.trim() || null;
  $("msg-input").value = "";
  const { error } = await sb.from("messages").insert({ conversation_id: state.activeId, content, attachment_url: data.publicUrl });
  if (error) alert(error.message);
};

async function markRead(convId) {
  await sb.from("conversation_members").update({ last_read_at: new Date().toISOString() })
    .eq("conversation_id", convId).eq("user_id", state.me.id);
}

/* ---------------- typing (broadcast) ---------------- */
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
$("msg-input").addEventListener("input", () => {
  if (!state.typingChannel || Date.now() - lastTypingSent < 1500) return;
  lastTypingSent = Date.now();
  state.typingChannel.send({ type: "broadcast", event: "typing", payload: { user_id: state.me.id, name: nameOf(state.me) } });
});

/* ---------------- presence ---------------- */
function subscribePresence() {
  const ch = sb.channel("online", { config: { presence: { key: state.me.id } } });
  ch.on("presence", { event: "sync" }, () => {
    state.online = new Set(Object.keys(ch.presenceState()));
    renderConvList();
    renderChatHeader();
  }).subscribe(async (status) => {
    if (status === "SUBSCRIBED") await ch.track({ at: Date.now() });
  });
  window.addEventListener("beforeunload", () => {
    sb.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", state.me.id);
  });
}

/* ---------------- realtime DB changes ---------------- */
function subscribeRealtime() {
  sb.channel("db-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, async ({ new: m }) => {
      let conv = state.convs.find((c) => c.id === m.conversation_id);
      if (!conv) { await loadConversations(); conv = state.convs.find((c) => c.id === m.conversation_id); if (!conv) return; }
      conv.last_message_at = m.created_at;
      state.lastMsg[m.conversation_id] = m;
      if (m.conversation_id === state.activeId) {
        const box = $("messages");
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
        appendMessage(m);
        if (nearBottom || m.sender_id === state.me.id) box.scrollTop = box.scrollHeight;
        if (m.sender_id !== state.me.id) { markRead(m.conversation_id); delete state.typingUsers[m.sender_id]; renderTyping(); }
      } else if (m.sender_id !== state.me.id) {
        state.unread[m.conversation_id] = (state.unread[m.conversation_id] || 0) + 1;
        notify(conv, m);
      }
      renderConvList();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, ({ new: m }) => {
      const el = document.querySelector(`.bubble[data-id="${m.id}"]`);
      if (el) {
        const conv = state.convs.find((c) => c.id === m.conversation_id);
        el.innerHTML = renderBubble(m, conv, m.sender_id === state.me.id);
        bindBubble(el, m);
      }
      if (state.lastMsg[m.conversation_id]?.id === m.id) { state.lastMsg[m.conversation_id] = m; renderConvList(); }
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, async ({ old }) => {
      removeMessageEl(old.id);
      const convId = Object.keys(state.lastMsg).find((k) => state.lastMsg[k]?.id === old.id);
      if (convId) { await refreshConvMeta(state.convs.find((c) => c.id === convId)); renderConvList(); }
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversation_members", filter: `user_id=eq.${state.me.id}` }, () => loadConversations())
    .subscribe();
}

/* ---------------- notifications ---------------- */
if ("Notification" in window && Notification.permission === "default") {
  document.addEventListener("click", () => Notification.requestPermission(), { once: true });
}
function notify(conv, m) {
  if (!("Notification" in window) || Notification.permission !== "granted" || document.hasFocus()) return;
  const who = nameOf(profileById(m.sender_id));
  const n = new Notification(conv.is_group ? `${convTitle(conv)} — ${who}` : who, { body: m.content || "📎 Вложение" });
  n.onclick = () => { window.focus(); openConversation(conv.id); };
}

/* ---------------- init ---------------- */
setMode("login");
const { data: { session } } = await sb.auth.getSession();
if (!session) $("auth").classList.remove("hidden");
