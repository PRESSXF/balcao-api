import { defineConfig } from 'vite'

// O console é servido pela própria API em "/". Em desenvolvimento, o Vite
// repassa as chamadas para a API local na porta 4280.
export default defineConfig({
  root: 'console',
  base: '/',
  publicDir: 'public',
  build: { outDir: '../dist/console', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5190,
    proxy: {
      '/v1': 'http://localhost:4280',
      '/demo': 'http://localhost:4280',
      '/docs': 'http://localhost:4280',
    },
  },
})
