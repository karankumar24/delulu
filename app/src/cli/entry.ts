// Is this module the PROGRAM, or did something merely import it?
//
// `handoff.ts` and `resume.ts` both end in a bare top-level `main()`, so importing either one RAN
// it. That is not hypothetical: on 2026-08-15 a test one-liner did
//     node -e "const {checkCitations}=await import('$PWD/hook/handoff.mjs')..."
// purely to reach a symbol, and the import performed a full capture against the real repo, writing
// `.delulu-handoff/2026-08-15T02-28-30`. Nobody noticed. Two sessions later a payload described
// that folder as a capture where "the interview was never finished" — a session the user never
// had, filed as their abandoned work. Twelve more such folders were written the same way on
// 2026-08-21. `resume` is the worse of the two to import, because loading also unlinks the PENDING
// marker: importing it MUTATES.
//
// The two cases are NOT symmetric, and the first draft of this file got that wrong.
//
// NO `process.argv[1]` AT ALL means this is `node -e`, `node --eval`, the REPL, or stdin — never a
// program run. Measured on node v22: `node -e "..."` gives `argv` of length 1, while `node file.mjs`
// gives the script path at [1]. Every real path into this CLI sets it: `hook/cli.mjs` spawns
// `execFileSync(process.execPath, [join(here, script), ...args])`, and running `node handoff.mjs`
// by hand sets it too. The 2026-08-15 incident was `node -e` — so treating a missing entry as
// "run it" would leave the exact bug this file exists to close wide open. Missing entry => NOT the
// program.
//
// A COMPARISON THAT THROWS is the ambiguous case, and there this DEGRADES OPEN. `argv[1]` exists,
// so some program is running and we merely cannot prove it is not this one. Guessing "imported"
// there would turn the CLI into a silent no-op — and a silent no-op is precisely what lets an agent
// conclude delulu worked and hand-write a payload under delulu's letterhead. Writing an unwanted
// folder is recoverable; reporting success while doing nothing is the failure this tool exists to
// prevent.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Pass `import.meta.url` from the module that owns `main()`. */
export function isProgram(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // realpath on both sides so a symlinked install, or `./handoff.mjs` vs an absolute path, still
  // compares equal — a spelling difference must never be read as "this was imported".
  try { return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return true; }
}
