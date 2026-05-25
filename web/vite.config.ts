import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // bind to 0.0.0.0 so phones / other devices on the LAN can connect
    strictPort: true,
    proxy: {
      // Vite runs the proxy server-side, so the backend can stay on localhost.
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    // v0.8.1 — manual chunk split. recharts is the single biggest dep
    // (~300 kB minified) and is only used by chart-heavy cards. Pulling
    // it into its own vendor chunk lets the initial Dashboard skip it
    // entirely; React.lazy() on the routes loads it on first nav to
    // a page that needs it.
    rollupOptions: {
      output: {
        // React itself stays in the main chunk (it's needed for first paint).
        // Only recharts gets its own split — it's the single biggest dep
        // (~540 kB minified, ~163 kB gzipped) and is only used by chart-heavy
        // pages, which are now lazy-loaded.
        manualChunks: {
          recharts: ['recharts'],
        },
      },
    },
    // recharts is the only chunk over the default 500 kB warning; that one is
    // legitimately on its lazy-load critical path so we bump the threshold to
    // 600 kB instead of churning over it.
    chunkSizeWarningLimit: 600,
  },
});
