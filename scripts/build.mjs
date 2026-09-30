// Bundles the CLI into one file, dist/cli.js, with a shebang. No runtime dependencies are bundled
// because there are none: everything comes from Node's standard library.
import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  define: { __SWARMSAY_CLI_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
});
await chmod('dist/cli.js', 0o755);
