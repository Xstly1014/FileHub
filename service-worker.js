const CACHE = "filehub-shell-v8";
const SHELL = ["./", "index.html", "css/tokens.css", "css/app.css", "css/workspace.css", "css/detail.css", "css/features.css", "css/dark.css", "css/motion.css", "js/data.js", "js/labdata.js", "js/api.js", "js/ai.js", "js/router.js", "js/workspace.js", "js/detail.js", "js/features.js", "js/feature-api.js", "js/app.js"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => { if (event.request.method !== "GET") return; event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });
