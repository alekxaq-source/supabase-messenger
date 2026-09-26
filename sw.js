const CACHE = "messenger-v4";
const ASSETS = [
  "./", "./index.html", "./style.css", "./extra.css", "./config.js",
  "./state.js", "./e2e.js", "./crypto.js", "./convs.js", "./msgs.js", "./live.js", "./app.js",
  "./manifest.webmanifest", "./icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => { caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});
