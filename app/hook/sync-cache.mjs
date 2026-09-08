// Keep the INSTALLED plugin cache in sync with this repo after a build, so a FRESH Claude Code
// session runs the code you just edited — not a stale cached copy. (The plugin runs from
// ~/.claude/plugins/cache/delulu/delulu/<ver>/, a separate copy of the repo; editing the repo
// alone does nothing until that cache is refreshed — the footgun this closes.)
// Solo-dev convenience: if no delulu cache is installed (CI / another machine), it silently no-ops.
//   node hook/sync-cache.mjs        (also runs automatically after `npm run build`)
import { readdirSync, existsSync, copyFileSync, statSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..');
// The shipped runtime honours CLAUDE_CONFIG_DIR (see src/cli/resolve-log.ts); this script did
// not, so on a relocated config it mirrored into a directory nothing reads and still printed
// success. An empty or whitespace-only value means unset, matching the runtime exactly.
const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
const cacheBase = join(configDir, 'plugins', 'cache', 'delulu', 'delulu');

if (!existsSync(cacheBase)) {
  console.log('sync-cache: no delulu plugin cache installed — skipped.');
  process.exit(0);
}

const versions = readdirSync(cacheBase).filter((v) => {
  try { return statSync(join(cacheBase, v)).isDirectory(); } catch { return false; }
});

// (repo-relative SOURCE dir, cache-relative DESTINATION dir, file filter) triples.
//
// The two differ, and that is the point of the `plugin/` split: the repo keeps everything a user
// runs under `plugin/`, which the marketplace ships as the plugin root (`source: ./plugin`). The
// installed cache IS that root, so `plugin/hook` mirrors to plain `hook`. Getting this pairing
// wrong would write a `plugin/` directory INSIDE the install, where nothing looks for it.
const groups = [
  ['plugin/hook', 'hook', (f) => f.endsWith('.mjs')],     // built runtimes + the cli.mjs dispatcher
  ['plugin/commands', 'commands', (f) => f.endsWith('.md')], // the /delulu:* slash-command prompts
  ['plugin/bin', 'bin', (f) => !f.startsWith('.')],       // `delulu`, the real command — see below
];

let copied = 0;
const removed = [];
for (const v of versions) {
  for (const [srcRel, dstRel, ok] of groups) {
    const srcDir = join(repoRoot, srcRel);
    const dstDir = join(cacheBase, v, dstRel);
    if (!existsSync(srcDir)) continue;
    // The destination is CREATED when missing, not skipped. bin/ postdates every existing install,
    // so skipping an absent directory silently left `delulu` a shell alias on this machine and a
    // command-not-found for everyone else — the exact failure the shim exists to end.
    if (!existsSync(dstDir)) { try { mkdirSync(dstDir, { recursive: true }); } catch { continue; } }
    const want = readdirSync(srcDir).filter(ok);
    for (const f of want) {
      try {
        copyFileSync(join(srcDir, f), join(dstDir, f));
        // The executable bit is the whole point of bin/ and copyFileSync makes no promise about
        // carrying it. A copied-but-unexecutable shim fails as "permission denied" from PATH,
        // which reads like a broken install rather than a mode.
        if (dstRel === 'bin') chmodSync(join(dstDir, f), 0o755);
        copied++;
      } catch { /* skip unreadable */ }
    }
    // Sync means MIRROR, not "copy and hope". Copying only meant a file deleted or renamed in the
    // repo kept running from the installed cache forever, while the build reported success — a
    // renamed slash command would leave BOTH installed, the old one still working and pointing at
    // stale behaviour.
    //
    // DEGRADE CLOSED, deliberately. If the source listing is empty, every cached file looks
    // orphaned and a naive mirror wipes the install; an empty source is far more likely to be a
    // wrong path or an unreadable directory than a genuine "delete everything". delulu's other
    // delete path (prune) shipped a defect that destroyed the newest handoffs by trusting a sort,
    // so this one trusts nothing and does nothing when the evidence is thin. Bounded to the two
    // directories above and the same extension filter, and never silent.
    if (!want.length) continue;
    for (const f of readdirSync(dstDir).filter(ok)) {
      if (want.includes(f)) continue;
      try { unlinkSync(join(dstDir, f)); removed.push(`${v}/${dstRel}/${f}`); } catch { /* leave it */ }
    }
  }
}
const gone = removed.length ? ` · removed ${removed.length} stale file(s): ${removed.join(', ')}` : '';
console.log(`sync-cache: ${copied} file(s) copied into ${versions.length} cache install(s) [${versions.join(', ')}]${gone}.`);
