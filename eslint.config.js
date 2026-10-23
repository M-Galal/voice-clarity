// ESLint 10 flat config. eslint-config-expo is not used because its React and import plugins
// (eslint-plugin-react 7.37, eslint-plugin-import 2.32) and eslint-plugin-expo support ESLint 9 at most.
const { defineConfig } = require('eslint/config');
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const globals = require('globals');

module.exports = defineConfig([
  { ignores: ['dist/**', 'android/**', 'ios/**', 'node_modules/**', 'modules/*/build/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'],
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser, __DEV__: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
]);
