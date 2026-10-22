import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Puerto 5182: el 5173 es del shell de espacio, 5180 de notas y 5181 de
// archivador en desarrollo.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: { port: 5182, strictPort: true },
  preview: { port: 5182 },
})
