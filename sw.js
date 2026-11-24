// Service worker: guarda a "casca" do app para abrir rápido e offline.
// Os dados vêm sempre da API do GitHub (o app guarda a última cópia no localStorage).
const VERSAO = "garimpo-v16";
const CASCA = ["./", "index.html", "style.css?v=16", "app.js?v=16", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;  // API do GitHub passa direto
  // rede primeiro (pega versões novas), cache como reserva offline
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copia = r.clone(); caches.open(VERSAO).then((c) => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request))
  );
});
