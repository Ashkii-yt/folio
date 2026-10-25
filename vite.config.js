import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const API_PORT = process.env.PORT || 4317;

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'server/public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false } },
  },
});
