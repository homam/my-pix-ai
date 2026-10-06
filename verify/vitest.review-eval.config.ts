import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Opt-in, paid: the composite review against known-defect fixtures (verify/src/review.eval.ts). */
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, '..') } },
  test: {
    include: ['verify/src/review.eval.ts'],
    root: resolve(__dirname, '..'),
    environment: 'node',
    testTimeout: 120_000,
  },
});
