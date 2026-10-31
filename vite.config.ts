import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The renderer. Electron serves dist/renderer over canon://app/ (see src/main/main.ts);
// in `npm run dev` it proxies that protocol to this dev server instead.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'chrome140' },
  server: { port: 5173, strictPort: true, hmr: { protocol: 'ws', host: 'localhost', port: 5173 } },
})
