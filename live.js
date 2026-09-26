import {
  sb, $, hooks, state, prefs, esc, nameOf, fmtDay, fmtTime, profileById, convById, activeConv,
  convTitle, settingsOf, cacheProfile, toast, showList, beep, download,
} from "./state.js";
import { decryptMessage, plainOf } from "./e2e.js";
import { loadConversations, renderConvList, renderChatHeader } from "./convs.js";
import { appendMessage, refreshRow, removeLocal, renderPinnedBar, markReadDebounced, scrollBottom } from "./msgs.js";

/* ---------------- realtime ---------------- */
export function subscribeAll() {
  sb.channel("db-msgs")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, onInsert)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, onUpdate)
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, (p) => {
      const id = p.old?.id;
      if (!id) return;
      removeLocal(id);
      renderConvList();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, onReaction)
    .on("postgres_changes", { event: "*", schema: "public", table: "pinned_messages" }, (p) => {
      const cid = p.new?.conversation_id || p.old?.conversation_id;
      if (cid && cid === state.activeId) hooks.loadPinned?.(cid);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => loadConversations())
    .on("postgres_changes", { event: "*", schema: "public", table: "conversation_members" }, () => loadConversations())
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles" }, (p) => {
      if (!p.new?.id) return;
      cacheProfile(p.new);
      renderConvList();
      if (state.activeId) renderChatHeader();
    })
    .subscribe((status) => setConn(status === "SUBSCRIBED"));
}

function setConn(ok) {
  const el = $("conn-status");
  if (!el) return;
  el.textContent = ok ? "● онлайн" : "○ переподключение…";
  el.classList.toggle("ok", ok);
}

async function onInsert(payload) {
  const m = payload.new;
  if (!m?.conversation_id) return;
  let conv = convById(m.conversation_id);
  if (!conv) { await loadConversations(); conv = convById(m.conversation_id); if (!conv) return; }
  if (!profileById(m.sender_id)) {
    const { data } = await sb.from("profiles").select("id,username,display_name,avatar_url,status_emoji,public_key,last_seen_at,bio").eq("id", m.sender_id).maybeSingle();
    if (data) cacheProfile(data);
  }
  state.lastMsg[m.conversation_id] = m;
  conv.last_message_at = m.created_at;

  if (m.conversation_id === state.activeId) {
    await decryptMessage(m).catch(() => {});
    const wasBottom = hooks.atBottom?.();
    appendMessage(m);
    if (wasBottom) scrollBottom(true);
    else { state.newCount++; $("new-count").textContent = state.newCount; $("btn-scroll-down").classList.remove("hidden"); }
    if (m.sender_id !== state.me.id) { markReadDebounced(); notify(conv, m); }
  } else if (m.sender_id !== state.me.id) {
    state.unread[m.conversation_id] = (state.unread[m.conversation_id] || 0) + 1;
    notify(conv, m);
  }
  renderConvList();
}

async function onUpdate(payload) {
  const m = payload.new;
  if (m.conversation_id !== state.activeId) return;
  const list = state.msgs.get(state.activeId) || [];
  const i = list.findIndex((x) => x.id === m.id);
  if (i < 0) return;
  const fresh = { ...m };
  await decryptMessage(fresh).catch(() => {});
  list[i] = fresh;
  refreshRow(m.id);
}

function onReaction(payload) {
  const r = payload.new || payload.old;
  if (!r?.message_id) return;
  const list = state.reactions.get(r.message_id) || [];
  if (payload.eventType === "DELETE" || payload.event === "DELETE") {
    state.reactions.set(r.message_id, list.filter((x) => !(x.user_id === r.user_id && x.emoji === r.emoji)));
  } else if (!list.some((x) => x.user_id === r.user_id && x.emoji === r.emoji)) {
    state.reactions.set(r.message_id, [...list, r]);
  }
  refreshRow(r.message_id);
}

/* ---------------- notifications ---------------- */
function notify(conv, m) {
  if (settingsOf(conv.id).muted) return;
  beep();
  if (!prefs.notify || document.visibilityState === "visible") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const who = nameOf(profileById(m.sender_id));
  const text = m.is_encrypted ? "🔒 Зашифрованное сообщение" : (m.content || "📎 Вложение");
  try {
    const n = new Notification(conv.is_group ? convTitle(conv) + " · " + who : who, { body: String(text).slice(0, 120), icon: "./icon.svg" });
    n.onclick = () => { window.focus(); hooks.openConversation?.(conv.id); n.close(); };
  } catch (_) {}
}
export function askNotifyPermission() {
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
}

/* ---------------- typing + presence ---------------- */
export function bindTyping(convId) {
  if (state.typingChannel) { sb.removeChannel(state.typingChannel); state.typingChannel = null; }
  state.typingUsers = {};
  renderTyping();
  const ch = sb.channel("typing:" + convId, { config: { broadcast: { self: false } } });
  ch.on("broadcast", { event: "typing" }, ({ payload }) => {
    if (!payload?.user || payload.user === state.me.id) return;
    state.typingUsers[payload.user] = Date.now();
    renderTyping();
  }).subscribe();
  state.typingChannel = ch;
}
function renderTyping() {
  const now = Date.now();
  const names = Object.entries(state.typingUsers)
    .filter(([, t]) => now - t < 4000)
    .map(([u]) => nameOf(profileById(u)));
  $("typing").textContent = names.length ? names.join(", ") + (names.length > 1 ? " печатают…" : " печатает…") : "";
}
setInterval(renderTyping, 1500);

let lastSent = 0;
export function sendTyping() {
  if (!prefs.typing || !state.typingChannel) return;
  const now = Date.now();
  if (now - lastSent < 1800) return;
  lastSent = now;
  state.typingChannel.send({ type: "broadcast", event: "typing", payload: { user: state.me.id } });
}

export function startPresence() {
  const ch = sb.channel("presence-all", { config: { presence: { key: state.me.id } } });
  ch.on("presence", { event: "sync" }, () => {
    state.online = new Set(Object.keys(ch.presenceState() || {}));
    renderConvList();
    if (state.activeId) renderChatHeader();
  }).subscribe(async (s) => { if (s === "SUBSCRIBED") await ch.track({ at: Date.now() }); });

  const touch = () => sb.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", state.me.id);
  touch();
  setInterval(touch, 60000);
  window.addEventListener("beforeunload", touch);
}

/* ---------------- voice messages ---------------- */
let rec = null, chunks = [], recStart = 0, recTimer = null;
export function bindVoice() {
  const btn = $("btn-voice");
  if (!btn) return;
  btn.onclick = async () => {
    if (rec) return stopRec(true);
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("Браузер не поддерживает запись"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => stream.getTracks().forEach((t) => t.stop());
      rec.start();
      recStart = Date.now();
      $("rec-bar").classList.remove("hidden");
      recTimer = setInterval(() => {
        const s = Math.floor((Date.now() - recStart) / 1000);
        $("rec-time").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      }, 250);
    } catch (_) { toast("Нет доступа к микрофону"); }
  };
  $("rec-stop").onclick = () => stopRec(true);
  $("rec-cancel").onclick = () => stopRec(false);
}
function stopRec(send) {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(recTimer);
  $("rec-bar").classList.add("hidden");
  r.onstop = () => {
    r.stream?.getTracks?.().forEach((t) => t.stop());
    if (!send || !chunks.length) return;
    const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
    const ext = (blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm");
    hooks.sendFile?.(new File([blob], "voice." + ext, { type: blob.type }), "voice");
  };
  try { r.stop(); } catch (_) {}
}

/* ---------------- lightbox ---------------- */
export function bindLightbox() {
  hooks.openLightbox = (url) => {
    state.imgIndex = Math.max(0, state.images.indexOf(url));
    show();
  };
  function show() {
    const url = state.images[state.imgIndex];
    if (!url) return;
    $("lb-img").src = url;
    $("lb-download").href = url;
    $("lightbox").classList.remove("hidden");
  }
  $("lb-prev").onclick = (e) => { e.stopPropagation(); state.imgIndex = (state.imgIndex - 1 + state.images.length) % state.images.length; show(); };
  $("lb-next").onclick = (e) => { e.stopPropagation(); state.imgIndex = (state.imgIndex + 1) % state.images.length; show(); };
  window.addEventListener("keydown", (e) => {
    if ($("lightbox").classList.contains("hidden")) return;
    if (e.key === "ArrowLeft") $("lb-prev").click();
    if (e.key === "ArrowRight") $("lb-next").click();
  });
}

/* ---------------- global message search ---------------- */
export function bindGlobalSearch() {
  $("btn-global-search").onclick = () => {
    showList("Поиск по всем чатам", [], {
      searchable: true,
      placeholder: "Текст сообщения…",
      onSearch: async (q) => {
        q = (q || "").trim();
        if (q.length < 2) return [];
        const { data } = await sb.from("messages")
          .select("id,conversation_id,sender_id,content,created_at,is_encrypted")
          .ilike("content", "%" + q + "%")
          .eq("is_encrypted", false)
          .order("created_at", { ascending: false })
          .limit(30);
        return (data || []).map((m) => {
          const c = convById(m.conversation_id);
          return {
            title: m.content,
            sub: (c ? convTitle(c) : "Чат") + " · " + nameOf(profileById(m.sender_id)) + " · " + fmtDay(m.created_at) + " " + fmtTime(m.created_at),
            onPick: async () => {
              await hooks.openConversation?.(m.conversation_id);
              setTimeout(() => hooks.jumpToMessage?.(m.id), 400);
            },
          };
        });
      },
    });
  };
}

export function bindLive() {
  hooks.sendTyping = sendTyping;
  hooks.bindTyping = bindTyping;
  bindVoice();
  bindLightbox();
  bindGlobalSearch();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.activeId) markReadDebounced(); });
}
