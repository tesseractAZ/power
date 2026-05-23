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
});
