import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: process.env.HTTPS ? true : 'localhost' },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
