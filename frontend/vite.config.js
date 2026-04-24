import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    // Drop the production bundle straight into the backend package so the
    // Dockerfile can COPY it in a single step without extra build context.
    outDir: '../backend/dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/model': { target: 'http://localhost:8000', changeOrigin: true },
      '/api':   { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
})
