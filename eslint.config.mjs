// Flat ESLint config (ESLint v9). TS rules are scoped to TS files; see CONTRIBUTING.md.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'docs/interface-mockup.html',
      'apps/web/next-env.d.ts',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
  },
);
