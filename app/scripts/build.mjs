// Bundles the two scripts the slash commands run into plugin/hook, the only folder the plugin ships.
//   node scripts/build.mjs
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// esbuild records module paths relative to absWorkingDir, so the bytes do not depend on where this runs.
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', absWorkingDir: appRoot };

const entries = [
  ['src/cli/save.ts', '../plugin/hook/handoff.mjs'],
  ['src/cli/load.ts', '../plugin/hook/resume.mjs'],
];
for (const [src, out] of entries) {
  await build({ ...common, entryPoints: [resolve(appRoot, src)], outfile: resolve(appRoot, out) });
  console.log(`built ${out}`);
}
