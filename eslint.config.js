import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  // ── Ignores ──────────────────────────────────────────────
  { ignores: ['dist/', 'src-tauri/', 'node_modules/', 'target/', '*.config.js', '*.config.ts', 'scripts/', 'src/__tests__/', 'src/components/__tests__/', 'src/lib/__tests__/', 'tests/'] },

  // ── Base JS rules ────────────────────────────────────────
  js.configs.recommended,

  // ── TypeScript (type-aware) ──────────────────────────────
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── React Hooks + Refresh ────────────────────────────────
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // ── Project-specific overrides ───────────────────────────
  {
    rules: {
      // Allow explicit any where genuinely needed (Tauri invoke, third-party libs)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Unused vars: error, but allow _ prefix for intentional ignores
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Floating promises common with Tauri invoke() fire-and-forget
      '@typescript-eslint/no-floating-promises': 'warn',
      // Allow non-null assertions for Tauri state guaranteed after init
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Prefer nullish coalescing but don't error on ||
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      // Allow string concatenation in templates
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Allow async functions without await (event handlers, callbacks)
      '@typescript-eslint/require-await': 'off',
      // Allow unsafe member access on any-typed values (common with invoke() results)
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      // Allow void for fire-and-forget
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { attributes: false },
      }],
      // Disable base rule in favor of TS version
      'no-unused-vars': 'off',
      // New react-hooks v7 rules — warn only, too strict for existing patterns
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
    },
  },

  // ── shadcn/ui components — generated code, relax rules ───
  {
    files: ['src/components/ui/**'],
    rules: {
      'react-hooks/purity': 'off',
    },
  },

  // ── Test files: relax rules ──────────────────────────────
  {
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
