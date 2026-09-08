#!/usr/bin/env node
// Entry point for delulu's two live commands. The /delulu:* slash-command prompts
// (commands/handoff.md, commands/resume.md) invoke THIS file:
//   node .../hook/cli.mjs handoff [--restate <ts>]   -> capture this session
//   node .../hook/cli.mjs resume  [--list | <ts>]    -> restore it in a fresh session
// Both delegate to their bundled zero-dep runtimes (built by app/hook/build.mjs), so this
// dispatcher stays free of the TS engine.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);

// Surface the child's exit code. Swallowing it made every `process.exitCode = 1` inside
// handoff.mjs and resume.mjs dead in production — this dispatcher is the ONLY entry point users
// reach, since both slash commands invoke it — so a run that wrote nothing at all still reported
// success. Those non-zero exits exist for one reason: a silent failure is what let an agent
// conclude the CLI had worked and hand-write a payload under delulu's letterhead.
// The message still reaches the user either way (stdio is inherited); this only stops the LIE.
const run = (script, args) => {
  try {
    execFileSync(process.execPath, [join(here, script), ...args], { stdio: 'inherit' });
  } catch (e) {
    process.exitCode = typeof e?.status === 'number' ? e.status : 1;
  }
};

if (cmd === 'handoff') run('handoff.mjs', rest);
else if (cmd === 'resume') run('resume.mjs', rest);
else {
  // A MISTYPED command is not the same as no command, and both used to print usage and exit 0.
  // That is the dispatcher's own documented sin one level up: `delulu frobnicate` reported success,
  // so anything reading the exit code — a script, a hook, an agent deciding whether the capture
  // happened — was told a command it never ran had worked. Same reasoning as the unknown-flag
  // refusal in handoff and resume: name what was not understood, and fail.
  const usage = 'delulu — usage:\n  cli.mjs handoff [--restate <ts>]\n  cli.mjs resume [--list | <ts>]';
  if (cmd === undefined) console.log(usage);
  else {
    console.log(`delulu — unknown command \`${cmd}\`. Nothing was run.\n${usage}`);
    process.exitCode = 1;
  }
}
