/**
 * Registers public/sw.js on the published site so the app works offline and
 * updates itself. Skipped in dev, where Vite and the local API need every
 * request to go straight to the network.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  /* Whether a worker was already driving this page before we registered. */
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    /* A newer build just took over. Reload once so the page is not a mix of old
     * and new files. On the very first install there is nothing to replace. */
    if (hadController && !reloading) {
      reloading = true;
      window.location.reload();
    }
  });

  /* updateViaCache 'none' fetches sw.js past the HTTP cache, which GitHub Pages
   * sets to 10 minutes; otherwise an update could be missed for that long. */
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
    .then((reg) => {
      reg.update();
      /* Home-screen apps are often resumed rather than relaunched, so check again
       * whenever the app comes back to the foreground. */
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {
      /* Offline support is optional. */
    });
}
