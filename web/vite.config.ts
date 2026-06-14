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
    // v0.22.0 — manual chunk split, function form.
    //
    // The old object form `manualChunks: { recharts: ['recharts'] }` was an
    // active footgun: naming recharts as a chunk root made Rollup sweep recharts'
    // OWN dependencies into that chunk too — including react-dom. The entry then
    // had to statically import the 540 kB "recharts" chunk just to get React, so
    // recharts sat on the first-paint critical path on every load (verified: the
    // 543 kB chunk contained react-dom, and index.html modulepreloaded it).
    //
    // The function form fixes that by pinning React to its OWN eager chunk so it
    // can't be absorbed. recharts is then a pure leaf reached only through the
    // lazy chart chunks (LazySparkline / lazy ForecastCard / lazy CircuitModal /
    // lazy TrendChart / lazy pages), so it loads on demand when a chart first
    // mounts and never blocks first paint.
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React core stays eager (first paint needs it). Its own stable chunk
          // also means app-code changes don't bust React's long-term cache.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-is)[\\/]/.test(id)) {
            return 'react-vendor';
          }
          // recharts + its charting deps (d3-*, victory-vendor, react-smooth,
          // etc). NOT React — that's the whole point. One deferred chunk so a
          // chart mount is a single request, off the first-paint path.
          if (
            /[\\/]node_modules[\\/](recharts|recharts-scale|react-smooth|d3-[^\\/]+|victory-vendor|internmap|robust-predicates|delaunator|decimal\.js-light|fast-equals)[\\/]/.test(
              id,
            )
          ) {
            return 'recharts';
          }
        },
      },
    },
    // recharts is the only chunk over the default 500 kB warning; it is now
    // genuinely off the critical path (lazy), so bump the threshold to 600 kB
    // instead of churning over it.
    chunkSizeWarningLimit: 600,
  },
});
