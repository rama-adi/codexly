import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// The browser harness runs the renderer in plain Vite. CODEXLY_HARNESS keeps the
// Electron plugin out of the dev server, so `pnpm dev:harness` never spawns a
// desktop window. Builds never set it.
const harnessOnly = process.env['CODEXLY_HARNESS'] === '1'

const electronPlugin = () =>
  electron({
    main: {
      entry: 'electron/main.ts',
    },
    preload: {
      input: {
        preload: fileURLToPath(new URL('./electron/preload.ts', import.meta.url)),
        'selection-preload': fileURLToPath(
          new URL('./electron/capture/selection-preload.ts', import.meta.url),
        ),
      },
      vite: {
        build: {
          rollupOptions: {
            output: { inlineDynamicImports: false },
          },
        },
      },
    },
  })

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [react(), tailwindcss(), ...(harnessOnly ? [] : [electronPlugin()])],
})
