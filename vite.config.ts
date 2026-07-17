import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: fileURLToPath(new URL('./electron/preload.ts', import.meta.url)),
      },
    }),
  ],
})
