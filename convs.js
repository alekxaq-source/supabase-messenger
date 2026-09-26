import {
  sb, $, hooks, state, WALLPAPERS, esc, nameOf, fmtListTime, setAvatar, cacheProfile,
  profileById, convById, activeConv, otherMember, convTitle, settingsOf, lastSeenText,
  toast, openModal, closeModal, download, showList, ask, renderText,
} from "./state.js";
import { decryptMessage, plainOf, convKey, e2eEnabled, randomSalt, fingerprint } from "./e2e.js";

/* ---------------- conversation settings ---------------- */
export async function setCS(convId, patch) {
  const cur = { ...settingsOf(convId), ...patch, conversation_id: convId, user_id: state.me.id };
  state.cs.set(convId, cur);
  const { error } = await sb.from("conv_settings").upsert(
    { user_id: state.me.id, conversation_id: convId, ...patch, updated_at: new Date().toISOString() },
    { onConflict: "user_id,conversation_id" }
  );
  if (error) console.warn(error);
}

export async function loadSideData() {
  const [cs, bl, sv] = await Promise.all([
    sb.from("conv_settings").select("*").eq("user_id", state.me.id),
    sb.from("blocks").select("blocked").eq("blocker", state.me.id),
    sb.from("saved_messages").select("message_id").eq("user_id", state.me.id),
  ]);
  state.cs = new Map((cs.data || []).map((r) => [r.conversation_id, r]));
  state.blocked = new Set((bl.data || []).map((r) => r.blocked));
  state.saved = new Set((sv.data || []).map((r) => r.message_id));
}

/* ---------------- load + render list ---------------- */
const PROFILE_COLS = "id,username,display_name,avatar_url,bio,last_seen_at,public_key,status_emoji";

export async function loadConversations() {
  const { data, error } = await sb
    .from("conversations")
    .select("id,is_group,title,created_by,created_at,last_message_at,e2e,e2e_salt,conversation_members(user_id,role,last_read_at,profiles(" + PROFILE_COLS + "))")
    .order("last_message_at", { ascending: false });
  if (error) { console.warn(error); return; }
  state.convs = data || [];
  for (const c of state.convs) for (const m of c.conversation_members || []) if (m.profiles) cacheProfile(m.profiles);
  await loadPreviews();
  renderConvList();
}

async function loadPreviews() {
  const ids = state.convs.map((c) => c.id);
  state.lastMsg = {}; state.unread = {};
  if (!ids.length) return;
  const { data } = await sb
    .from("messages")
    .select("id,conversation_id,sender_id,content,attachment_url,kind,is_encrypted,created_at")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false })
    .limit(500);
  for (const m of data || []) {
    if (!state.lastMsg[m.conversation_id]) state.lastMsg[m.conversation_id] = m;
    const c = convById(m.conversation_id);
    const mine = c?.conversation_members?.find((x) => x.user_id === state.me.id);
    const lr = mine?.last_read_at;
    if (m.sender_id !== state.me.id && (!lr || new Date(m.created_at) > new Date(lr)))
      state.unread[m.conversation_id] = (state.unread[m.conversation_id] || 0) + 1;
  }
  for (const m of Object.values(state.lastMsg)) {
    const c = convById(m.conversation_id);
    if (m.is_encrypted && (!c?.is_group || state.keys.has(c.id))) await decryptMessage(m).catch(() => {});
  }
}

export function previewOf(convId) {
  const m = state.lastMsg[convId];
  if (!m) return "Нет сообщений";
  const who = m.sender_id === state.me.id ? "Вы: " : "";
  if (m.kind === "voice") return who + "🎤 Голосовое сообщение";
  if (m.attachment_url && !m.content) return who + "📎 Файл";
  const text = plainOf(m);
  return who + (text || "📎 Файл");
}

export function visibleConvs() {
  return state.convs
    .filter((c) => {
      const s = settingsOf(c.id);
      if (!!s.archived !== !!state.showArchived) return false;
      if (!c.is_group) {
        const o = otherMember(c);
        if (o && state.blocked.has(o.id)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const pa = settingsOf(a.id).pinned ? 1 : 0, pb = settingsOf(b.id).pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at);
    });
}

export function renderConvList() {
  const box = $("conv-list");
  if (!box) return;
  const list = visibleConvs();
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<div class="muted small pad">' + (state.showArchived ? "В архиве пусто" : "Пока нет чатов. Найдите человека по имени выше.") + "</div>";
  }
  for (const c of list) {
    const s = settingsOf(c.id);
    const other = c.is_group ? null : otherMember(c);
    const row = document.createElement("div");
    row.className = "conv" + (c.id === state.activeId ? " active" : "");
    const av = document.createElement("div");
    av.className = "avatar";
    setAvatar(av, convTitle(c), c.is_group ? c.id : other?.id, c.is_group ? null : other?.avatar_url, other ? state.online.has(other.id) : false);
    const tags = [];
    if (c.is_group) tags.push('<span class="tag">группа</span>');
    if (s.pinned) tags.push("📌");
    if (s.muted) tags.push("🔇");
    if (c.e2e || (!c.is_group && e2eEnabled(c))) tags.push("🔒");
    const n = state.unread[c.id] || 0;
    row.innerHTML =
      '<div class="grow ellipsis"><div class="row-top"><span class="bold ellipsis">' + esc(convTitle(c)) +
      (other?.status_emoji ? " " + esc(other.status_emoji) : "") + "</span> " + tags.join(" ") +
      '<span class="muted small nowrap">' + (c.last_message_at ? fmtListTime(c.last_message_at) : "") + "</span></div>" +
      '<div class="muted small ellipsis">' + esc(previewOf(c.id)) + "</div></div>" +
      (n ? '<span class="badge">' + (n > 99 ? "99+" : n) + "</span>" : "");
    row.prepend(av);
    row.onclick = () => hooks.openConversation?.(c.id);
    box.appendChild(row);
  }
  const total = Object.entries(state.unread).reduce((a, [id, v]) => a + (settingsOf(id).muted ? 0 : v), 0);
  document.title = (total ? "(" + total + ") " : "") + "Messenger";
}

/* ---------------- user search / dm ---------------- */
export async function searchUsers(q) {
  q = (q || "").trim();
  if (q.length < 2) return [];
  const { data } = await sb
    .from("profiles")
    .select(PROFILE_COLS)
    .or("username.ilike.%" + q + "%,display_name.ilike.%" + q + "%")
    .neq("id", state.me.id)
    .limit(20);
  return (data || []).map(cacheProfile);
}

function userRow(p, onClick) {
  const row = document.createElement("div");
  row.className = "conv";
  const av = document.createElement("div");
  av.className = "avatar";
  setAvatar(av, nameOf(p), p.id, p.avatar_url, state.online.has(p.id));
  row.innerHTML =
    '<div class="grow ellipsis"><div class="bold ellipsis">' + esc(nameOf(p)) + (p.status_emoji ? " " + esc(p.status_emoji) : "") +
    '</div><div class="muted small ellipsis">@' + esc(p.username || "") + "</div></div>";
  row.prepend(av);
  row.onclick = onClick;
  return row;
}

export function renderUserList(box, users, onPick) {
  box.innerHTML = "";
  if (!users.length) { box.innerHTML = '<div class="muted small pad">Никого не найдено</div>'; return; }
  for (const p of users) box.appendChild(userRow(p, () => onPick(p)));
}

export async function startDm(userId) {
  const { data, error } = await sb.rpc("get_or_create_dm", { other_user: userId });
  if (error) { toast("Не удалось открыть чат"); return; }
  await loadConversations();
  hooks.openConversation?.(data);
  $("user-search").value = "";
  $("search-results").classList.add("hidden");
}

export async function showUser(userId) {
  let p = profileById(userId);
  if (!p) {
    const { data } = await sb.from("profiles").select(PROFILE_COLS).eq("id", userId).maybeSingle();
    if (!data) { toast("Профиль не найден"); return; }
    p = cacheProfile(data);
  }
  setAvatar($("up-avatar"), nameOf(p), p.id, p.avatar_url, state.online.has(p.id));
  $("up-name").textContent = nameOf(p);
  $("up-emoji").textContent = p.status_emoji || "";
  $("up-username").textContent = p.username ? "@" + p.username : "";
  $("up-status").textContent = lastSeenText(p);
  $("up-bio").textContent = p.bio || "";
  $("up-fp").textContent = "";
  if (p.public_key) fingerprint(p.public_key).then((f) => { $("up-fp").textContent = "Отпечаток ключа: " + f; });
  const blocked = state.blocked.has(p.id);
  $("up-block").textContent = blocked ? "Разблокировать" : "Заблокировать";
  $("up-block").onclick = () => toggleBlock(p.id);
  $("up-message").onclick = () => { closeModal("user-modal"); startDm(p.id); };
  const dm = state.convs.find((c) => !c.is_group && otherMember(c)?.id === p.id);
  $("up-delete-chat").classList.toggle("hidden", !dm);
  $("up-delete-chat").onclick = async () => {
    if (!dm) return;
    if (!confirm("Удалить переписку у себя и у собеседника?")) return;
    await sb.rpc("clear_chat", { conv: dm.id });
    closeModal("user-modal");
    toast("Переписка очищена");
    hooks.reopen?.(dm.id);
  };
  openModal("user-modal");
}

export async function toggleBlock(userId) {
  if (state.blocked.has(userId)) {
    await sb.from("blocks").delete().eq("blocker", state.me.id).eq("blocked", userId);
    state.blocked.delete(userId);
    toast("Пользователь разблокирован");
  } else {
    await sb.from("blocks").insert({ blocker: state.me.id, blocked: userId });
    state.blocked.add(userId);
    toast("Пользователь заблокирован");
  }
  closeModal("user-modal");
  renderConvList();
}

/* ---------------- groups ---------------- */
function renderGroupSelected() {
  const box = $("group-selected");
  box.innerHTML = "";
  for (const [id, p] of state.groupSelected) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = esc(nameOf(p)) + " ✕";
    chip.onclick = () => { state.groupSelected.delete(id); renderGroupSelected(); };
    box.appendChild(chip);
  }
}

export function openGroupModal() {
  state.groupSelected = new Map();
  $("group-title").value = "";
  $("group-search").value = "";
  $("group-results").innerHTML = "";
  renderGroupSelected();
  openModal("group-modal");
}

export async function openGroupInfo() {
  const c = activeConv();
  if (!c?.is_group) return;
  $("gi-title").value = c.title || "";
  $("gi-count").textContent = (c.conversation_members || []).length + " участник(ов)";
  const box = $("gi-members");
  box.innerHTML = "";
  for (const m of c.conversation_members || []) {
    const p = profileById(m.user_id) || { id: m.user_id };
    const row = userRow(p, () => { closeModal("ginfo-modal"); showUser(m.user_id); });
    if (m.role === "admin") row.querySelector(".bold").innerHTML += ' <span class="tag">админ</span>';
    box.appendChild(row);
  }
  $("gi-add-results").innerHTML = "";
  $("gi-add-search").value = "";
  openModal("ginfo-modal");
}

async function createGroup() {
  const title = $("group-title").value.trim();
  if (!title) { toast("Введите название группы"); return; }
  if (!state.groupSelected.size) { toast("Добавьте хотя бы одного участника"); return; }
  const { data, error } = await sb.rpc("create_group", { group_title: title, member_ids: [...state.groupSelected.keys()] });
  if (error) { toast("Ошибка создания группы"); return; }
  closeModal("group-modal");
  await loadConversations();
  hooks.openConversation?.(data);
}

export async function leaveConversation() {
  const c = activeConv();
  if (!c) return;
  if (!confirm("Выйти из группы?")) return;
  await sb.from("conversation_members").delete().eq("conversation_id", c.id).eq("user_id", state.me.id);
  closeModal("ginfo-modal");
  state.activeId = null;
  $("chat-view").classList.add("hidden");
  $("chat-empty").classList.remove("hidden");
  await loadConversations();
}

/* ---------------- chat header + menu ---------------- */
export function renderChatHeader() {
  const c = activeConv();
  if (!c) return;
  const other = c.is_group ? null : otherMember(c);
  setAvatar($("chat-avatar"), convTitle(c), c.is_group ? c.id : other?.id, c.is_group ? null : other?.avatar_url, other ? state.online.has(other.id) : false);
  $("chat-title").textContent = convTitle(c) + (other?.status_emoji ? " " + other.status_emoji : "");
  const enc = c.is_group ? !!c.e2e : e2eEnabled(c);
  $("lock-badge").classList.toggle("hidden", !enc);
  const s = settingsOf(c.id);
  $("chat-sub").textContent = c.is_group
    ? (c.conversation_members || []).length + " участник(ов)" + (s.muted ? " · 🔇" : "")
    : lastSeenText(other) + (s.muted ? " · 🔇" : "");
  applyWallpaper();
  const menu = $("chat-menu");
  menu.querySelector('[data-m="mute"]').textContent = s.muted ? "🔔 Включить уведомления" : "🔇 Отключить уведомления";
  menu.querySelector('[data-m="pin"]').textContent = s.pinned ? "📌 Открепить чат" : "📌 Закрепить чат";
  menu.querySelector('[data-m="archive"]').textContent = s.archived ? "📥 Убрать из архива" : "🗄 В архив";
  menu.querySelector('[data-m="lock"]').textContent = enc ? "🔓 Выключить шифрование" : "🔒 Включить шифрование";
}

export function applyWallpaper() {
  const s = settingsOf(state.activeId);
  const w = WALLPAPERS.find((x) => x.name === s.wallpaper);
  $("messages").style.background = w?.css || "";
}

async function pickWallpaper() {
  showList("Фон чата", WALLPAPERS.map((w) => ({
    title: w.name,
    sub: "",
    onPick: async () => { await setCS(state.activeId, { wallpaper: w.name }); applyWallpaper(); },
  })));
}

async function toggleEncryption() {
  const c = activeConv();
  if (!c) return;
  if (c.is_group) {
    if (c.e2e) {
      await sb.from("conversations").update({ e2e: false }).eq("id", c.id);
      c.e2e = false;
      state.keys.delete(c.id);
      localStorage.removeItem("gkey_" + c.id);
      toast("Шифрование группы выключено");
    } else {
      const pass = await ask("Пароль шифрования группы", "Сообщите его участникам любым надёжным способом — без пароля они не прочтут сообщения.", { password: true });
      if (!pass) return;
      const salt = c.e2e_salt || randomSalt();
      await sb.from("conversations").update({ e2e: true, e2e_salt: salt }).eq("id", c.id);
      c.e2e = true; c.e2e_salt = salt;
      localStorage.setItem("gkey_" + c.id, pass);
      state.keys.delete(c.id);
      await convKey(c);
      toast("Шифрование группы включено");
    }
  } else {
    if (state.e2eOff.has(c.id)) state.e2eOff.delete(c.id);
    else state.e2eOff.add(c.id);
    localStorage.setItem("e2eOff", JSON.stringify([...state.e2eOff]));
    toast(state.e2eOff.has(c.id) ? "Шифрование выключено для этого чата" : "Шифрование включено");
  }
  renderChatHeader();
  renderConvList();
}

async function exportChat() {
  const c = activeConv();
  const msgs = state.msgs.get(c.id) || [];
  const lines = msgs.map((m) => "[" + new Date(m.created_at).toLocaleString("ru-RU") + "] " + nameOf(profileById(m.sender_id)) + ": " + (plainOf(m) || "(вложение)") + (m.attachment_url ? " " + m.attachment_url : ""));
  download("chat-" + convTitle(c).replace(/[^\wа-яА-Я-]+/g, "_") + ".txt", lines.join("\n"));
  toast("Файл сохранён");
}

async function clearChat() {
  const c = activeConv();
  if (!c || !confirm("Удалить все сообщения этого чата? Действие необратимо.")) return;
  const { error } = await sb.rpc("clear_chat", { conv: c.id });
  if (error) { toast("Не удалось очистить"); return; }
  toast("Чат очищен");
  hooks.reopen?.(c.id);
}

/* ---------------- wiring ---------------- */
export function bindConvUi() {
  try { state.e2eOff = new Set(JSON.parse(localStorage.getItem("e2eOff") || "[]")); } catch (_) {}

  let t;
  $("user-search").oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = $("user-search").value;
      const box = $("search-results");
      if (q.trim().length < 2) { box.classList.add("hidden"); return; }
      box.classList.remove("hidden");
      renderUserList(box, await searchUsers(q), (p) => showUser(p.id));
    }, 280);
  };

  $("btn-new-group").onclick = openGroupModal;
  $("group-create").onclick = createGroup;
  let gt;
  $("group-search").oninput = () => {
    clearTimeout(gt);
    gt = setTimeout(async () => {
      renderUserList($("group-results"), await searchUsers($("group-search").value), (p) => {
        state.groupSelected.set(p.id, p);
        renderGroupSelected();
        $("group-search").value = "";
        $("group-results").innerHTML = "";
      });
    }, 280);
  };

  $("btn-archive").onclick = () => {
    state.showArchived = !state.showArchived;
    $("btn-archive").classList.toggle("on", state.showArchived);
    renderConvList();
  };

  $("btn-chat-info").onclick = () => {
    const c = activeConv();
    if (!c) return;
    if (c.is_group) openGroupInfo();
    else { const o = otherMember(c); if (o) showUser(o.id); }
  };
  $("chat-head-info").onclick = () => $("btn-chat-info").click();

  $("btn-chat-menu").onclick = (e) => { e.stopPropagation(); $("chat-menu").classList.toggle("hidden"); };
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#chat-menu") && !e.target.closest("#btn-chat-menu")) $("chat-menu").classList.add("hidden");
  });
  $("chat-menu").onclick = async (e) => {
    const m = e.target.closest("[data-m]")?.dataset.m;
    if (!m) return;
    $("chat-menu").classList.add("hidden");
    const s = settingsOf(state.activeId);
    if (m === "mute") { await setCS(state.activeId, { muted: !s.muted }); renderChatHeader(); renderConvList(); }
    if (m === "pin") { await setCS(state.activeId, { pinned: !s.pinned }); renderConvList(); }
    if (m === "archive") { await setCS(state.activeId, { archived: !s.archived }); renderConvList(); toast(s.archived ? "Убрано из архива" : "Чат в архиве"); }
    if (m === "wallpaper") pickWallpaper();
    if (m === "export") exportChat();
    if (m === "clear") clearChat();
    if (m === "lock") toggleEncryption();
  };

  $("gi-rename").onclick = async () => {
    const c = activeConv();
    const title = $("gi-title").value.trim();
    if (!c || !title) return;
    const { error } = await sb.from("conversations").update({ title }).eq("id", c.id);
    if (error) { toast("Переименовать может только админ"); return; }
    c.title = title;
    renderChatHeader(); renderConvList();
    toast("Название изменено");
  };
  let at;
  $("gi-add-search").oninput = () => {
    clearTimeout(at);
    at = setTimeout(async () => {
      renderUserList($("gi-add-results"), await searchUsers($("gi-add-search").value), async (p) => {
        const c = activeConv();
        const { error } = await sb.rpc("add_group_members", { conv: c.id, member_ids: [p.id] });
        if (error) { toast("Не удалось добавить"); return; }
        toast(nameOf(p) + " добавлен(а)");
        await loadConversations();
        openGroupInfo();
      });
    }, 280);
  };
  $("gi-leave").onclick = leaveConversation;

  hooks.renderConvList = renderConvList;
  hooks.renderChatHeader = renderChatHeader;
  hooks.loadConversations = loadConversations;
  hooks.showUser = showUser;
  hooks.setCS = setCS;
}
