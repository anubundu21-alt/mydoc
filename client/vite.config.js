import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // listen on all interfaces so previews / other devices can reach it
    allowedHosts: true, // accept preview/tunnel hostnames, not just "localhost"
    proxy: { '/api': 'http://localhost:4000' },
  },
});
