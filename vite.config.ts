import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const API = 'http://localhost:8787';

/**
 * Stamps dist/sw.js with a hash of every other file in the build. Any change to
 * the published site therefore changes sw.js, which is what makes installed
 * copies of the app pick up the new worker and reload (see public/sw.js).
 */
function stampServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name !== 'sw.js') files.push(full);
        }
      };
      walk(outDir);
      const hash = createHash('sha256');
      for (const file of files.sort()) {
        hash.update(relative(outDir, file));
        hash.update(readFileSync(file));
      }
      const swPath = join(outDir, 'sw.js');
      const sw = readFileSync(swPath, 'utf8');
      writeFileSync(swPath, sw.replace("'__BUILD_ID__'", `'${hash.digest('hex').slice(0, 12)}'`));
    },
  };
}

// base './' keeps every asset path relative, so the built site works from any
// GitHub Pages subpath without knowing the repo name at build time.
export default defineConfig({
  base: './',
  plugins: [react(), stampServiceWorker()],
  server: {
    port: 5173,
    strictPort: true,
    // Cross-origin isolation lets the multi-threaded Stockfish build boot.
    // Everything here is same-origin or proxied, so require-corp is safe.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/engine': { target: API, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});
