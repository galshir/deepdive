import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.vsix'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['src/webview/**/*.tsx', 'src/webview/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // The webview must never touch Node or VS Code APIs, and core must stay VS Code-free so it is testable.
    files: ['src/webview/**/*'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['vscode', 'mysql2*', '../../core/*', '../core/*', 'node:*'] }] },
  },
  {
    files: ['src/core/**/*', 'src/shared/**/*'],
    rules: { 'no-restricted-imports': ['error', { paths: ['vscode'] }] },
  },
);
