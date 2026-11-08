import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    target: 'es2022',
    // No source maps in production, and minified output.
    sourcemap: false,
    minify: 'esbuild',
    chunkSizeWarningLimit: 900,
  },
  esbuild: { legalComments: 'none' },
});
