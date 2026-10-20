// Bundles the boisestate command, zod and all, into one file. A plugin
// installs straight from git with no npm install, so dist/ is committed.

import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/boisestate.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  legalComments: 'none',
  minify: true,
  logLevel: 'warning',
});
