import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.js', '.discord-ai-interface/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      ecmaVersion: 'latest', sourceType: 'module', globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', setTimeout: 'readonly' },
    },
  },
);
