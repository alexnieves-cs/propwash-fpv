import { defineConfig } from 'vite';

// GitHub Pages serves the site from /propwash-fpv/, built with `npm run build:pages` (mode "pages").
// Local dev, preview and `npm run build` keep relative paths so dist/ works from anywhere.
export default defineConfig(({ mode }: { mode: string }) => ({
  base: mode === 'pages' ? '/propwash-fpv/' : './',
  server: { port: 5199, strictPort: false, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    // Rapier ships its WebAssembly inlined as base64, so its chunk is large on its own.
    chunkSizeWarningLimit: 4500,
    rollupOptions: {
      output: {
        // Split the two big libraries out of the app code so they cache separately.
        manualChunks(id: string) {
          if (id.includes('node_modules/@dimforge/')) return 'rapier';
          if (id.includes('node_modules/three/')) return 'three';
          return undefined;
        },
      },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 60000 },
}) as never);
