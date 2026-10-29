import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'dist/',
      '.astro/',
      'node_modules/',
      'design/',
      'data/',
      '.cache/',
      'playwright-report/',
      'test-results/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  ...astro.configs['jsx-a11y-strict'],
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    // An image's onerror (AppIcon's fallback to the tile) isn't a user interaction; the strict
    // preset counts load events as one. Mouse and keyboard handlers stay covered.
    files: ['**/*.astro'],
    rules: {
      'astro/jsx-a11y/no-noninteractive-element-interactions': [
        'error',
        {
          handlers: ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyDown', 'onKeyUp'],
        },
      ],
    },
  },
];
