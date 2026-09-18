import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://localhost:8787';

// base './' keeps every asset path relative, so the built site works from any
// GitHub Pages subpath without knowing the repo name at build time.
export default defineConfig({
  base: './',
  plugins: [react()],
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
