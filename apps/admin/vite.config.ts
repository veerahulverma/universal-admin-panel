import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const api = process.env.STEWARD_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5173,
    // Server-rendered paths: API, hosted payment pages, referral links (/r/:code) and unsubscribe links (/u/:token).
    // Trailing slashes matter: a bare '/r' would also capture console routes such as /reports and /revenue.
    proxy: Object.fromEntries(['/api/', '/pay/', '/r/', '/u/'].map((p) => [p, { target: api, changeOrigin: false }])),
  },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
});
