import { defineConfig } from 'vitest/config'

// Testes unitários: não precisam de banco.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})
