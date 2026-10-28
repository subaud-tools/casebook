// The family page tools' eslint config: defect classes only, no opinions.
// Copied from tools-common (localweb/page/build/) by a tool's build and
// checked against the version it pins, so edit it there. A tool's own
// eslint.config.mjs is one call:
//
//   import base from './<copied>/eslint.base.mjs';
//   export default base({ root: import.meta.dirname, ignores: ['kit.d.ts'] });
//
// The packages it imports (eslint, globals, typescript-eslint) are the tool's
// own devDependencies, resolved from where the copy sits.

import globals from 'globals';
import tseslint from 'typescript-eslint';

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-const-assign': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-sparse-arrays': 'error',
  'no-unreachable': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-fallthrough': 'error',
  'no-cond-assign': ['error', 'always'],
  'getter-return': 'error',
};

/**
 * The config for a tool's web directory.
 *
 * @param {object} opts
 * @param {string} opts.root the tool's web directory (its import.meta.dirname),
 *   where tsconfig.json is.
 * @param {string[]} [opts.ignores] what to leave unlinted beyond node_modules/
 *   (a copied kit.d.ts).
 * @param {string[]} [opts.testFiles] files tsconfig.json leaves out (test files
 *   with node: imports) linted in a default project; [] for none.
 * @param {number} [opts.maxTestFiles] how many files may match testFiles,
 *   when more than typescript-eslint's default of eight do; an error with
 *   testFiles [].
 * @param {boolean} [opts.ambientGlobals] the page's types are ambient globals
 *   (wire.d.ts, kit.d.ts), so no-undef is off for .ts and tsc checks names.
 * @returns {import('eslint').Linter.Config[]}
 */
export default function base({
  root,
  ignores = [],
  testFiles = ['*.test.ts'],
  maxTestFiles,
  ambientGlobals = true,
} = {}) {
  if (!root) throw new Error('eslint.base.mjs: pass root: import.meta.dirname');
  if (maxTestFiles && !testFiles.length)
    throw new Error(
      'eslint.base.mjs: maxTestFiles caps how many files match testFiles, and testFiles is []',
    );
  const projectService = testFiles.length
    ? {
        allowDefaultProject: testFiles,
        ...(maxTestFiles
          ? {
              maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING:
                maxTestFiles,
            }
          : {}),
      }
    : true;
  return [
    {
      ignores: ['node_modules/', ...ignores],
    },
    ...tseslint.configs.recommendedTypeChecked.map((c) => ({
      ...c,
      files: ['**/*.ts'],
    })),
    {
      files: ['**/*.ts'],
      languageOptions: {
        parserOptions: { projectService, tsconfigRootDir: root },
        globals: { ...globals.browser },
      },
      rules: {
        ...rules,
        ...(ambientGlobals ? { 'no-undef': 'off' } : {}),
        // The TS plugin's no-unused-vars (from recommendedTypeChecked)
        // supersedes the base rule; both on would report twice.
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-unsafe-declaration-merging': 'off',
        '@typescript-eslint/no-empty-object-type': 'off',
        '@typescript-eslint/no-floating-promises': 'warn',
        '@typescript-eslint/no-misused-promises': 'warn',
        '@typescript-eslint/no-base-to-string': 'warn',
        '@typescript-eslint/unbound-method': 'warn',
      },
    },
    {
      files: ['**/*.mjs'],
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: { ...globals.node, ...globals.browser },
      },
      rules,
    },
  ];
}
