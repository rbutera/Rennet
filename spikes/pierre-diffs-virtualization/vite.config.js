import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  preview: { port: 5199, strictPort: true },
  build: { target: 'es2022' },
  // Pierre ships pre-bundled ESM; letting Vite optimize it keeps dev-server
  // module counts sane so the "initial render" number isn't dominated by
  // waterfall module fetches.
  optimizeDeps: { include: ['@pierre/diffs/react', 'shiki'] },
});
