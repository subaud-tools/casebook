// The linter for internal/casebook/web/: the family's base (build/, copied
// from tools-common by `npm run build-files`). casebook has more test files
// than the default project's cap of eight, and its .ts keeps no-undef on.

import base from './build/eslint.base.mjs';

export default base({
  root: import.meta.dirname,
  ignores: ['kit.d.ts'],
  maxTestFiles: 24,
  ambientGlobals: false,
});
