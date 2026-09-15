// Whether a module was run as a program or only imported, so importing save.ts or load.ts never saves
// or loads anything.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Pass `import.meta.url` from the module that owns `main()`. No `argv[1]` means `node -e` or a REPL,
 * so imported. A comparison that throws means run, since a silent no-op is worse than an extra save.
 */
export function isProgram(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // realpath on both sides, so a symlinked install or a relative path still compares equal.
  try { return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return true; }
}
