import { defineConfig } from 'vitest/config'

// Testes de integração: rodam contra um PostgreSQL 16 de verdade.
// O banco de teste é recriado do zero em globalSetup, a partir de TEST_DATABASE_URL.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
