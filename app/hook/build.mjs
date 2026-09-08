// Bundle the zero-dep ESM runtimes the /delulu:* commands run:
//   plugin/hook/handoff.mjs  <- src/cli/handoff.ts  (capture a session)
//   plugin/hook/resume.mjs   <- src/cli/resume.ts   (restore it in a fresh session)
//
// Output lands in `plugin/`, the ONLY directory the marketplace ships (`source: ./plugin`).
// The dev tree — src/, the tests, the configs — stays out of every user's install.
//   node hook/build.mjs
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// `absWorkingDir` pins the paths esbuild bakes into the output. Without it the SAME source
// built from the repo root and from `app/` produced two different files, because esbuild
// records module paths relative to the process's cwd. A build whose bytes depend on where you
// were standing cannot be checked against what is committed, which is what `shipped.test.ts`
// does.
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', absWorkingDir: appRoot };

const entries = [
  ['src/cli/handoff.ts', '../plugin/hook/handoff.mjs'],
  ['src/cli/resume.ts', '../plugin/hook/resume.mjs'],
];
for (const [src, out] of entries) {
  await build({ ...common, entryPoints: [resolve(appRoot, src)], outfile: resolve(appRoot, out) });
  console.log(`built ${out}`);
}
