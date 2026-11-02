import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', '**/out/', '**/.vscode-test/'] },
  ...tseslint.configs.recommended,
  {
    files: ['extensions/*/src/**/*.ts'],
    rules: {
      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
    },
  },
);
