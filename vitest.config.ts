import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Unit tests run offline (no MySQL/Redis). Integration tests that require
    // live infra are gated behind env and skipped by default (see test/README note).
    globals: false,
  },
})
