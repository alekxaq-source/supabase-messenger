import {
  sb, $, hooks, state, prefs, savePrefs, STATUS_EMOJIS, USERNAME_RE, esc, nameOf, setAvatar,
  cacheProfile, profileById, toast, openModal, closeModal, closeAllModals, download, showList, ask,
} from "./state.js";
import { ensureIdentity, newIdentity, importIdentity, fingerprint } from "./e2e.js";
import { loadSideData, loadConversations, renderConvList, bindConvUi, searchUsers, startDm, showUser, toggleBlock } from "./convs.js";
import { bindMsgUi, openConversation, jumpToMessage } from "./msgs.js";
import { subscribeAll, startPresence, bindLive, askNotifyPermission } from "./live.js";

hooks.ask = ask;

const PROFILE_COLS = "id,username,display_name,avatar_url,bio,last_seen_at,public_key,status_emoji";
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

/* ---------------- theme + font ---------------- */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("theme", t);
}
function setFont(px) {
  prefs.font = px;
  document.documentElement.style.fontSize = px + "px";
  savePrefs();
}

/* ---------------- auth ---------------- */
let mode = "login";
function setMode(m) {
  mode = m;
  $("tab-login").classList.toggle("active", m === "login");
  $("tab-signup").classList.toggle("active", m === "signup");
  $("auth-username").classList.toggle("hidden", m !== "signup");
  $("auth-submit").textContent = m === "login" ? "Войти" : "Создать аккаунт";
  $("auth-msg").textContent = "";
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const msg = $("auth-msg");
  msg.textContent = "Подождите…";
  $("auth-submit").disabled = true;
  try {
    if (mode === "signup") {
      const username = $("auth-username").value.trim().toLowerCase();
      if (!USERNAME_RE.test(username)) { msg.textContent = "@id: 3–32 символа, только латиница, цифры и _"; return; }
      const { data: free } = await sb.rpc("username_available", { name: username });
      if (free === false) { msg.textContent = "Такой @id уже занят"; return; }
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username, display_name: username } } });
      if (error) { msg.textContent = error.message; return; }
      if (!data.session) { msg.textContent = "Аккаунт создан. Подтвердите email и войдите."; setMode("login"); return; }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { msg.textContent = "Неверный email или пароль"; return; }
    }
    msg.textContent = "";
  } finally {
    $("auth-submit").disabled = false;
  }
}

async function forgot() {
  const email = $("auth-email").value.trim();
  if (!email) { $("auth-msg").textContent = "Введите email выше"; return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  $("auth-msg").textContent = error ? error.message : "Письмо для сброса пароля отправлено";
}

/* ---------------- me / profile ---------------- */
function renderMe() {
  setAvatar($("me-avatar"), nameOf(state.me), state.me.id, state.me.avatar_url, true);
  $("me-name").textContent = nameOf(state.me);
  $("me-emoji").textContent = state.me.status_emoji || "";
  $("me-username").textContent = state.me.username ? "@" + state.me.username : "";
}

function openProfile() {
  const me = state.me;
  setAvatar($("pf-avatar"), nameOf(me), me.id, me.avatar_url);
  $("pf-name").value = me.display_name || "";
  $("pf-username").value = me.username || "";
  $("pf-bio").value = me.bio || "";
  $("pf-uuid").textContent = me.id;
  $("pf-username-hint").textContent = "";
  $("pf-msg").textContent = "";
  const row = $("pf-emoji-row");
  row.innerHTML = "";
  for (const e of STATUS_EMOJIS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn" + ((me.status_emoji || "") === e ? " on" : "");
    b.textContent = e || "—";
    b.onclick = async () => {
      await sb.from("profiles").update({ status_emoji: e }).eq("id", me.id);
      me.status_emoji = e;
      renderMe();
      openProfile();
    };
    row.appendChild(b);
  }
  openModal("profile-modal");
}

async function saveProfile() {
  const me = state.me;
  const display_name = $("pf-name").value.trim();
  const username = $("pf-username").value.trim().toLowerCase();
  const bio = $("pf-bio").value.trim();
  if (username && !USERNAME_RE.test(username)) { $("pf-msg").textContent = "@id: 3–32 символа, латиница/цифры/_"; return; }
  const { error } = await sb.from("profiles").update({ display_name, username, bio }).eq("id", me.id);
  if (error) { $("pf-msg").textContent = "Не сохранилось (возможно, @id занят)"; return; }
  Object.assign(me, { display_name, username, bio });
  renderMe();
  renderConvList();
  $("pf-msg").textContent = "Сохранено ✓";
  toast("Профиль обновлён");
}

async function uploadAvatar(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast("Фото больше 5 МБ"); return; }
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = state.me.id + "/avatar-" + Date.now() + "." + ext;
  const { error } = await sb.storage.from("avatars").upload(path, file, { contentType: file.type || undefined, upsert: true });
  if (error) { toast("Не удалось загрузить фото"); return; }
  const url = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  await sb.from("profiles").update({ avatar_url: url }).eq("id", state.me.id);
  state.me.avatar_url = url;
  setAvatar($("pf-avatar"), nameOf(state.me), state.me.id, url);
  renderMe();
  renderConvList();
  toast("Фото обновлено");
}

function inviteLink() {
  const u = state.me.username;
  return location.origin + location.pathname + (u ? "#u=" + u : "");
}

/* ---------------- settings ---------------- */
function openSettings() {
  $("set-font").value = prefs.font;
  $("set-sound").checked = prefs.sound;
  $("set-notify").checked = prefs.notify;
  $("set-typing").checked = prefs.typing;
  $("set-enter").checked = prefs.enter;
  $("blocked-list").classList.add("hidden");
  openModal("settings-modal");
}

async function showBlocked() {
  const ul = $("blocked-list");
  ul.classList.remove("hidden");
  ul.innerHTML = '<li class="muted small">Загрузка…</li>';
  const ids = [...state.blocked];
  if (!ids.length) { ul.innerHTML = '<li class="muted small">Никто не заблокирован</li>'; return; }
  const { data } = await sb.from("profiles").select(PROFILE_COLS).in("id", ids);
  ul.innerHTML = "";
  for (const p of data || []) {
    cacheProfile(p);
    const li = document.createElement("li");
    li.innerHTML = '<span class="grow ellipsis">' + esc(nameOf(p)) + "</span>";
    const b = document.createElement("button");
    b.className = "chip-btn small";
    b.textContent = "Разблокировать";
    b.onclick = async () => { await toggleBlock(p.id); showBlocked(); };
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function bindSettings() {
  $("btn-settings").onclick = openSettings;
  $("set-font").oninput = (e) => setFont(+e.target.value);
  $("set-sound").onchange = (e) => { prefs.sound = e.target.checked; savePrefs(); };
  $("set-typing").onchange = (e) => { prefs.typing = e.target.checked; savePrefs(); };
  $("set-enter").onchange = (e) => { prefs.enter = e.target.checked; savePrefs(); };
  $("set-notify").onchange = (e) => { prefs.notify = e.target.checked; savePrefs(); if (e.target.checked) askNotifyPermission(); };
  $("set-blocked").onclick = showBlocked;
  $("set-key-export").onclick = () => {
    const priv = localStorage.getItem("e2e_priv_" + state.me.id);
    if (!priv) { toast("Ключ не найден"); return; }
    download("messenger-key-" + (state.me.username || "me") + ".json", priv, "application/json");
    toast("Ключ сохранён. Храните его в надёжном месте.");
  };
  $("set-key-import").onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const txt = await f.text();
      await importIdentity(JSON.parse(txt));
      toast("Ключ загружен");
      if (state.activeId) openConversation(state.activeId);
    } catch (_) { toast("Файл ключа не подходит"); }
  };
  $("set-key-new").onclick = async () => {
    if (!confirm("Создать новый ключ? Старые зашифрованные сообщения станут нечитаемыми.")) return;
    await newIdentity();
    toast("Новый ключ создан");
    if (state.activeId) openConversation(state.activeId);
  };
  $("set-password").onclick = async () => {
    const p1 = await ask("Новый пароль", "Минимум 6 символов", { password: true });
    if (!p1) return;
    if (p1.length < 6) { toast("Слишком короткий пароль"); return; }
    const { error } = await sb.auth.updateUser({ password: p1 });
    toast(error ? "Не удалось сменить пароль" : "Пароль изменён");
  };
}

/* ---------------- pwa ---------------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvt = e;
  $("set-install")?.classList.remove("hidden");
});
function bindInstall() {
  $("set-install").onclick = async () => {
    if (!installEvt) { toast("Добавьте сайт на главный экран через меню браузера"); return; }
    installEvt.prompt();
    installEvt = null;
    $("set-install").classList.add("hidden");
  };
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

/* ---------------- deep links ---------------- */
async function handleHash() {
  const h = location.hash.slice(1);
  if (!h) return;
  const p = new URLSearchParams(h);
  const uname = p.get("u");
  if (uname) {
    history.replaceState(null, "", location.pathname);
    const { data } = await sb.from("profiles").select(PROFILE_COLS).eq("username", uname.toLowerCase()).maybeSingle();
    if (!data) { toast("Пользователь @" + uname + " не найден"); return; }
    if (data.id === state.me.id) return;
    cacheProfile(data);
    showUser(data.id);
    return;
  }
  const conv = p.get("c");
  if (conv) {
    await openConversation(conv);
    const m = p.get("m");
    if (m) setTimeout(() => jumpToMessage(m), 500);
  }
}

/* ---------------- boot ---------------- */
async function start(session) {
  const uid = session.user.id;
  let { data: me } = await sb.from("profiles").select(PROFILE_COLS).eq("id", uid).maybeSingle();
  if (!me) {
    await sb.from("profiles").insert({ id: uid, username: null, display_name: session.user.email?.split("@")[0] || "user" });
    ({ data: me } = await sb.from("profiles").select(PROFILE_COLS).eq("id", uid).maybeSingle());
  }
  state.me = cacheProfile(me || { id: uid });
  hide("auth");
  show("app");
  $("conn-status").classList.remove("hidden");
  renderMe();
  setFont(prefs.font);

  document.querySelector(".lb-prev")?.setAttribute("id", "lb-prev");
  document.querySelector(".lb-next")?.setAttribute("id", "lb-next");

  bindConvUi();
  bindMsgUi();
  bindLive();
  bindSettings();
  bindInstall();

  await ensureIdentity().catch(() => {});
  await loadSideData();
  await loadConversations();
  subscribeAll();
  startPresence();
  if (prefs.notify) askNotifyPermission();
  handleHash();
  window.addEventListener("hashchange", handleHash);
}

function bindStatic() {
  $("tab-login").onclick = () => setMode("login");
  $("tab-signup").onclick = () => setMode("signup");
  $("auth-form").addEventListener("submit", onAuthSubmit);
  $("btn-forgot").onclick = forgot;

  $("btn-theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("btn-logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };
  $("btn-my-profile").onclick = openProfile;
  $("pf-save").onclick = saveProfile;
  $("pf-avatar-input").onchange = (e) => { uploadAvatar(e.target.files?.[0]); e.target.value = ""; };
  $("pf-avatar-remove").onclick = async () => {
    await sb.from("profiles").update({ avatar_url: null }).eq("id", state.me.id);
    state.me.avatar_url = null;
    setAvatar($("pf-avatar"), nameOf(state.me), state.me.id, null);
    renderMe();
    renderConvList();
  };
  $("pf-copy-uuid").onclick = () => { navigator.clipboard?.writeText(state.me.id); toast("ID скопирован"); };
  $("pf-share").onclick = async () => {
    if (!state.me.username) { toast("Сначала задайте @id"); return; }
    const link = inviteLink();
    if (navigator.share) { try { await navigator.share({ title: "Messenger", url: link }); return; } catch (_) {} }
    navigator.clipboard?.writeText(link);
    toast("Ссылка скопирована");
  };
  $("pf-qr").onclick = () => {
    if (!state.me.username) { toast("Сначала задайте @id"); return; }
    const src = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + encodeURIComponent(inviteLink());
    $("pf-msg").innerHTML = '<img src="' + src + '" width="140" height="140" alt="QR">';
  };

  let ut;
  $("pf-username").oninput = () => {
    clearTimeout(ut);
    const v = $("pf-username").value.trim().toLowerCase();
    const hint = $("pf-username-hint");
    if (!v) { hint.textContent = ""; return; }
    if (!USERNAME_RE.test(v)) { hint.textContent = "3–32 символа: a–z, 0–9, _"; return; }
    hint.textContent = "Проверяем…";
    ut = setTimeout(async () => {
      if (v === state.me.username) { hint.textContent = "Это ваш текущий @id"; return; }
      const { data } = await sb.rpc("username_available", { name: v });
      hint.textContent = data === false ? "Занято ✗" : "Свободно ✓";
    }, 400);
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeAllModals(); $("chat-menu")?.classList.add("hidden"); $("emoji-picker")?.classList.add("hidden"); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("user-search")?.focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && state.activeId) { e.preventDefault(); $("btn-chat-search").click(); }
  });
}

bindStatic();
setMode("login");

const { data: { session } } = await sb.auth.getSession();
if (session) await start(session);
else show("auth");

sb.auth.onAuthStateChange(async (event, s) => {
  if (event === "SIGNED_IN" && s && !state.me) await start(s);
  if (event === "SIGNED_OUT") location.reload();
});
