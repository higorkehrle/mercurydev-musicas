import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser only talks to Vite (127.0.0.1:5173); /api and /login are proxied to the server.
// The OAuth callback goes straight to the server (SPOTIFY_REDIRECT_URI) and the cookie is valid for host 127.0.0.1.
const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': api, '/login': api },
  },
  preview: { host: '127.0.0.1', port: 5173 },
});
