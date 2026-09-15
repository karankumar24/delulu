// Mirrors plugin/ into the installed plugin cache, so a fresh Claude Code session runs what you just
// built. Opt-in through `npm run sync` or `npm run dev`; does nothing where no delulu cache is installed.
import { readdirSync, existsSync, copyFileSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..');
// A blank CLAUDE_CONFIG_DIR means unset, as in src/cli/resolve-log.ts.
const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
const cacheBase = join(configDir, 'plugins', 'cache', 'delulu', 'delulu');

if (!existsSync(cacheBase)) {
  console.log('sync-cache: no delulu plugin cache installed, skipped.');
  process.exit(0);
}

const versions = readdirSync(cacheBase).filter((v) => {
  try { return statSync(join(cacheBase, v)).isDirectory(); } catch { return false; }
});

// The install is the plugin/ folder itself, so plugin/hook mirrors to hook.
const groups = [
  ['plugin/hook', 'hook', (f) => f.endsWith('.mjs')],
  ['plugin/commands', 'commands', (f) => f.endsWith('.md')],
];

let copied = 0;
const removed = [];
for (const v of versions) {
  for (const [srcRel, dstRel, ok] of groups) {
    const srcDir = join(repoRoot, srcRel);
    const dstDir = join(cacheBase, v, dstRel);
    if (!existsSync(srcDir)) continue;
    if (!existsSync(dstDir)) { try { mkdirSync(dstDir, { recursive: true }); } catch { continue; } }
    const want = readdirSync(srcDir).filter(ok);
    for (const f of want) {
      try {
        copyFileSync(join(srcDir, f), join(dstDir, f));
        copied++;
      } catch { /* skip unreadable */ }
    }
    // Files the repo no longer has are removed, but never when the source is empty: that is more likely
    // a wrong path than an order to wipe the install.
    if (!want.length) continue;
    for (const f of readdirSync(dstDir).filter(ok)) {
      if (want.includes(f)) continue;
      try { unlinkSync(join(dstDir, f)); removed.push(`${v}/${dstRel}/${f}`); } catch { /* leave it */ }
    }
  }
}
const gone = removed.length ? ` · removed ${removed.length} stale file(s): ${removed.join(', ')}` : '';
console.log(`sync-cache: ${copied} file(s) copied into ${versions.length} cache install(s) [${versions.join(', ')}]${gone}.`);
