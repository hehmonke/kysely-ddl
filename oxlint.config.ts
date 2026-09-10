// Shared rule set without project-specific plugins; type-aware rules run through oxlint-tsgolint.
import { defineConfig } from 'oxlint';

export default defineConfig({
  ignorePatterns: ['**/node_modules', '**/dist'],
  jsPlugins: ['eslint-plugin-perfectionist', 'eslint-plugin-unused-imports', '@stylistic/eslint-plugin'],
  categories: {
    correctness: 'warn',
    suspicious: 'warn',
    perf: 'warn',
  },
  options: {
    typeAware: true,
  },
  rules: {
    'perfectionist/sort-exports': ['error', { type: 'natural' }],
    'perfectionist/sort-imports': [
      'error',
      {
        groups: [
          'value-builtin',
          'value-external',
          ['value-internal', 'type-internal'],
          ['value-parent', 'type-parent'],
          ['value-sibling', 'type-sibling'],
          ['value-index', 'type-index'],
          'type-import',
          'ts-equals-import',
          'unknown',
        ],
        type: 'natural',
        internalPattern: ['^src'],
        environment: 'bun',
      },
    ],
    'perfectionist/sort-named-exports': ['error', { type: 'natural' }],
    'perfectionist/sort-named-imports': ['error', { type: 'natural' }],
    'perfectionist/sort-decorators': ['error', { type: 'natural' }],

    'unused-imports/no-unused-imports': 'error',

    '@stylistic/padding-line-between-statements': [
      'error',
      { blankLine: 'always', prev: '*', next: 'return' },
      { blankLine: 'always', prev: '*', next: 'if' },
      { blankLine: 'always', prev: '*', next: 'for' },
    ],

    'eslint/eqeqeq': ['error', 'always'],
    'eslint/curly': 'error',
    'eslint/no-console': 'error',
    'eslint/prefer-const': ['error', { destructuring: 'any' }],
    'eslint/no-await-in-loop': 'off',
    'eslint/no-empty': 'off',
    'eslint/no-inner-declarations': ['error', 'both'],
    'eslint/no-unneeded-ternary': 'error',
    'eslint/no-duplicate-imports': 'error',
    'eslint/yoda': 'warn',
    'eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
    'eslint/no-unused-expressions': 'off',
    'eslint/no-unused-vars': [
      'error',
      {
        args: 'none',
        ignoreRestSiblings: true,
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    'eslint/no-shadow': 'off',
    'eslint/preserve-caught-error': 'off',

    'unicorn/require-post-message-target-origin': 'off',
    'unicorn/no-new-array': 'off',
    'unicorn/no-empty-file': 'off',
    'unicorn/prefer-add-event-listener': 'off',

    'oxc/no-map-spread': 'off',
    'oxc/no-async-endpoint-handlers': 'off',
  },
  overrides: [
    {
      files: ['*.ts', '*.tsx'],
      rules: {
        'typescript/no-unnecessary-condition': 'warn',
        'typescript/no-non-null-assertion': 'warn',
        'typescript/strict-boolean-expressions': [
          'error',
          {
            allowNullableObject: false,
            allowNullableBoolean: false,
            allowNullableString: false,
            allowNullableNumber: false,
            allowAny: false,
          },
        ],
        'typescript/no-inferrable-types': ['warn', { ignoreParameters: true }],
        'typescript/no-unsafe-type-assertion': 'off',
        'typescript/restrict-template-expressions': ['error', { allowNever: true }],
        'typescript/no-unnecessary-type-arguments': 'off',
        'typescript/no-unnecessary-template-expression': 'off',
        'typescript/no-extraneous-class': 'off',
      },
    },
    {
      files: ['*.test.ts', 'test/**'],
      rules: {
        'typescript/await-thenable': 'off',
        'typescript/no-non-null-assertion': 'off',
      },
    },
    {
      // Scripts: stdout is their interface.
      files: ['scripts/**'],
      rules: {
        'eslint/no-console': 'off',
      },
    },
  ],
});
