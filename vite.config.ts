import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5199, strictPort: false, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 60000 },
} as never);
