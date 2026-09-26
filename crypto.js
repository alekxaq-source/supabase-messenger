/* End-to-end encryption helpers (WebCrypto).
   DM: ECDH P-256 -> AES-GCM 256. Group: PBKDF2(password, salt) -> AES-GCM 256. */
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const hasCrypto = !!(window.crypto && crypto.subtle);

export async function createIdentity() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { priv: JSON.stringify(priv), pub: JSON.stringify(pub) };
}
export function loadPriv(userId) { return localStorage.getItem("e2e_priv_" + userId); }
export function savePriv(userId, jwk) { localStorage.setItem("e2e_priv_" + userId, jwk); }
export async function pubFromPriv(privJwk) {
  const j = JSON.parse(privJwk);
  const pub = { kty: j.kty, crv: j.crv, x: j.x, y: j.y, ext: true };
  return JSON.stringify(pub);
}
async function importPriv(privJwk) {
  return crypto.subtle.importKey("jwk", JSON.parse(privJwk), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
}
async function importPub(pubJwk) {
  return crypto.subtle.importKey("jwk", JSON.parse(pubJwk), { name: "ECDH", namedCurve: "P-256" }, false, []);
}
export async function deriveDmKey(privJwk, pubJwk) {
  const [a, b] = await Promise.all([importPriv(privJwk), importPub(pubJwk)]);
  return crypto.subtle.deriveKey({ name: "ECDH", public: b }, a, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export function randomSalt() { return b64(crypto.getRandomValues(new Uint8Array(16))); }
export async function deriveGroupKey(password, saltB64) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: unb64(saltB64), iterations: 200000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return "e1:" + b64(iv) + "." + b64(ct);
}
export async function decryptText(key, payload) {
  if (typeof payload !== "string" || !payload.startsWith("e1:")) return payload;
  const [ivs, cts] = payload.slice(3).split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivs) }, key, unb64(cts));
  return dec.decode(pt);
}
export async function fingerprint(pubJwk) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(pubJwk));
  return [...new Uint8Array(h)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase().match(/.{1,4}/g).join(" ");
}
