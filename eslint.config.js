// ESLint flat config (v9+). Permissive baseline — catches real bugs (TS-style
// type drift handled by tsc, runtime hazards caught here) without flagging
// the prop-resync useEffect pattern we deliberately use in
// ProfilePersonalInfo / ProfileInterestsGoals. Tighten over time.

import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'backend/dist/**',
      'mcp/dist/**',
      'supabase/functions/**',
      'cli/**',
      'scripts/**',
      'tests/**',
      'mcp/**',
      'backend/**',
      '**/*.d.ts',
      'tsconfig.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2024,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // TypeScript handles undefined identifier detection better than ESLint
      // (it knows about types vs values, ambient declarations, etc).
      'no-undef': 'off',
      // React 18 new-JSX-transform: components don't need `import React` to use
      // JSX. The recommended config flags React.FormEvent etc. without an
      // import — but those are TS types and tsc validates them.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      // The prop-resync useEffect pattern documented in audit RISKY-1 lives
      // in the Profile section components and intentionally calls setState
      // from an effect when parent props change. Downgrade to warn until we
      // refactor to derived state.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
