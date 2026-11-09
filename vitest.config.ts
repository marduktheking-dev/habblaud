import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'server/**/*.test.ts',
      'shared/**/*.test.ts',
      'client/src/**/*.test.ts',
      'mod/habblaud-voice/tests/**/*.test.ts',
    ],
    environment: 'node',
  },
});
