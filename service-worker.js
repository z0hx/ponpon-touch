// キャッシュはcache-firstなので、配信物を更新したらここを上げること
// (上げないとインストール済み端末に新しいapp.js/index.htmlが届かない)
// app.js の APP_VERSION と同じ値にそろえる。
const APP_VERSION = "1.1.2";
const CACHE_NAME = "ponpon-touch-v" + APP_VERSION;
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // HTTPキャッシュ経由で古いファイルを取り込まないよう cache: "reload" で取得する
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(CORE_ASSETS.map((url) => new Request(url, { cache: "reload" })))
    )
  );
  // ここでは skipWaiting しない。遊んでいる最中に勝手に再読み込みが走らないよう、
  // 保護者が「更新する」を押したとき(SKIP_WAITING)か、アプリを閉じたときに切り替わる。
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => cached);
    })
  );
});
