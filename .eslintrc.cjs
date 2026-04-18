/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: [
    'node_modules',
    'dist',
    'coverage',
    '*.tsbuildinfo',
    'pnpm-lock.yaml',
  ],
  rules: {},
  overrides: [
    {
      // Worktree + path-construction modules must wrap path.join() in path.resolve()
      // to guarantee absolute paths. Best-effort lint enforcement; runtime
      // assertAbs() (Task 1.1) is the authoritative contract. See ADR-0002, ADR-0013.
      files: ['**/worktree*.ts', '**/paths*.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "CallExpression[callee.object.name='path'][callee.property.name='join']:not(CallExpression[callee.object.name='path'][callee.property.name='resolve'] > CallExpression[callee.object.name='path'][callee.property.name='join'])",
            message:
              "Use path.resolve(path.join(...)) (or path.resolve directly) so the result is always absolute. See ADR-0002.",
          },
        ],
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'path',
                importNames: ['join'],
                message:
                  'Import path as a namespace and wrap path.join in path.resolve. See ADR-0002.',
              },
              {
                name: 'node:path',
                importNames: ['join'],
                message:
                  'Import node:path as a namespace and wrap path.join in path.resolve. See ADR-0002.',
              },
            ],
          },
        ],
      },
    },
  ],
};
