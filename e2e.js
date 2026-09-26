import * as C from "./crypto.js";
import { sb, $, state, ask, convById, otherMember } from "./state.js";

export const hasCrypto = C.hasCrypto;

export async function ensureIdentity() {
  if (!C.hasCrypto) return;
  let priv = C.loadPriv(state.me.id);
  if (!priv) {
    const id = await C.createIdentity();
    priv = id.priv;
    C.savePriv(state.me.id, priv);
  }
  state.priv = priv;
  const pub = await C.pubFromPriv(priv);
  if (state.me.public_key !== pub) {
    await sb.from("profiles").update({ public_key: pub }).eq("id", state.me.id);
    state.me.public_key = pub;
  }
  C.fingerprint(pub).then((f) => { $("set-fp").textContent = "\u041e\u0442\u043f\u0435\u0447\u0430\u0442\u043e\u043a \u0432\u0430\u0448\u0435\u0433\u043e \u043a\u043b\u044e\u0447\u0430: " + f; });
}
export function newIdentity() {
  localStorage.removeItem("e2e_priv_" + state.me.id);
  state.priv = null;
  state.keys.clear();
  return ensureIdentity();
}
export function importIdentity(privJwk) {
  C.savePriv(state.me.id, privJwk);
  state.keys.clear();
  return ensureIdentity();
}
export const randomSalt = C.randomSalt;
export const fingerprint = C.fingerprint;
export const encryptText = C.encryptText;

export async function convKey(conv) {
  if (!conv || !C.hasCrypto || !state.priv) return null;
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
      key = await C.deriveGroupKey(pass, conv.e2e_salt);
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
      key = await C.deriveDmKey(state.priv, pub);
    }
  } catch (e) {
    console.warn("key error", e);
    return null;
  }
  if (key) state.keys.set(conv.id, key);
  return key;
}
export const e2eEnabled = (conv) => !!conv && !state.e2eOff.has(conv.id);

export async function decryptMessage(m) {
  if (!m.is_encrypted || m.plain !== undefined) return m;
  const key = await convKey(convById(m.conversation_id));
  if (!key) { m.plain = null; return m; }
  try { m.plain = await C.decryptText(key, m.content); }
  catch (_) { m.plain = null; }
  return m;
}
export function plainOf(m) {
  if (!m) return "";
  if (!m.is_encrypted) return m.content || "";
  if (m.plain) return m.plain;
  return "\u{1F512} \u0417\u0430\u0448\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u043d\u043e\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435";
}
export async function prepareOutgoing(conv, text) {
  const key = await convKey(conv);
  if (key && e2eEnabled(conv) && text) {
    return { content: await C.encryptText(key, text), is_encrypted: true };
  }
  return { content: text || null, is_encrypted: false };
}
