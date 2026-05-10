import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Base ignore patterns (replaces .eslintignore in flat config)
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/web/vendor/**',
      'apps/mcp/server.bundle.js',
      'apps/web/.vercel/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Project-wide tweaks — keep MINIMAL. Only override things that matter.
  {
    rules: {
      // The codebase intentionally uses console.log/error in server boot,
      // worker logs, and CLI tools. Don't make people fight that.
      'no-console': 'off',
      // We use `unknown` and explicit casts in a few intentional places
      // (opaque spec, unknown DB rows). Allow them; flag truly bad ones in review.
      '@typescript-eslint/no-explicit-any': 'warn',
      // `_var` convention for intentionally-unused parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Test files: relax a few rules where they get in the way.
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Node scripts (.mjs) — give them full Node globals so process/console/setTimeout
  // don't trigger no-undef errors.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  // ALWAYS LAST: turn off all stylistic rules in favour of Prettier.
  prettier,
);
