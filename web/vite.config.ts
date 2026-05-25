import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // v0.9.5 — relative base URL so the built bundle works under any mount
  // point. Direct LAN access at :8787 serves from `/`; HA Ingress serves
  // from `/api/hassio_ingress/<token>/`. With base:'./' the built assets
  // reference each other relatively (./assets/index-XYZ.js) so both work
  // without per-deployment configuration.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // bind to 0.0.0.0 so phones / other devices on the LAN can connect
    strictPort: true,
    proxy: {
      // Vite runs the proxy server-side, so the backend can stay on localhost.
      // v0.9.17-dev — overridable via VITE_API_TARGET so the dev server can
      // be pointed at the deployed HA Pi (`homeassistant.local:8787`) for
      // in-browser debugging. Default keeps the original `127.0.0.1`.
      '/api': process.env.VITE_API_TARGET || 'http://127.0.0.1:8787',
      '/ws': {
        target: (process.env.VITE_API_TARGET || 'http://127.0.0.1:8787').replace(/^http/, 'ws'),
        ws: true,
      },
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
