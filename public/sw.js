/* Service worker: fresh when the network allows, instant when it does not.
 *
 * Same approach as WorldOfWar. Pages are answered from the network, but never
 * wait longer than SLOW_NETWORK_MS: after that the cached copy is served while
 * the request keeps going and refreshes the cache for next launch. Vite's hashed
 * files under assets/ never change once built, so those come straight from cache.
 *
 * No version to bump by hand: the build replaces __BUILD_ID__ with a hash of
 * everything in dist/ (see vite.config.ts). Any change to the site changes this
 * file, which makes the browser install the new worker, retire the old cache,
 * and (via the controllerchange hook in src/lib/serviceWorker.ts) reload the page.
 */
const BUILD = '__BUILD_ID__';
const CACHE = 'chesstrainer-' + BUILD;
const SLOW_NETWORK_MS = 3000;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  './data/puzzles.json',
  './data/calendar.json',
  './data/workbooks.json',
];

/* The bundle's file names change every build, so read them out of index.html. */
async function bundleFiles() {
  const res = await fetch('./index.html', { cache: 'reload' });
  const html = await res.text();
  const found = html.match(/\.?\/?assets\/[^"'\s)]+/g) || [];
  return [...new Set(found.map((p) => './' + p.replace(/^\.?\//, '')))];
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const urls = [...SHELL, ...(await bundleFiles())];
      /* cache: 'reload' skips the HTTP cache. GitHub Pages lets browsers keep files
       * for 10 minutes, and a new worker must not fill its cache with the old build. */
      await Promise.all(
        urls.map(async (url) => {
          const res = await fetch(url, { cache: 'reload' });
          if (res.ok) await cache.put(url, res);
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('chesstrainer-') && k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'version' && e.source) {
    e.source.postMessage({ type: 'sw-version', version: BUILD, cache: CACHE });
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  /* Only this app's own files; the scope already excludes /api and /engine. */
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/assets/')) {
    e.respondWith(cacheFirst(req));
  } else {
    e.respondWith(networkFirst(req));
  }
});

function save(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  return save(req, await fetch(req));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function networkFirst(req) {
  /* Always start the network request; even when we answer from cache below it
   * keeps running and refreshes the cache, so the next launch is current. */
  const fromNetwork = fetch(req)
    .then((res) => save(req, res))
    .catch(() => null);

  const cached = await caches.match(req, { ignoreSearch: true });

  if (!cached) {
    const res = await fromNetwork;
    if (res) return res;
    /* Offline with nothing cached: for a navigation, the app shell beats an error. */
    if (req.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    return Response.error();
  }

  const res = await Promise.race([fromNetwork, delay(SLOW_NETWORK_MS).then(() => null)]);
  return res || cached;
}
