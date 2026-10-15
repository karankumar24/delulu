# delulu

Claude Code plugin: `/delulu:handoff` saves one session, `/delulu:resume` loads it in a fresh one. README says what it is; this file holds what the README and CONTRIBUTING do not.

## Layout
- `app/src/cli/save.ts` is the handoff script, `app/src/cli/load.ts` the resume script, `app/src/transcript/` reads transcripts and git. Tests sit beside the code.
- `plugin/` is the only folder users install. `plugin/hook/handoff.mjs` and `resume.mjs` are generated from `app/src`: rebuild, never hand-edit.
- `plugin/commands/*.md` are the two slash-command prompts.

## Commands (run in `app/`, Node 22+)
- `npm test` runs vitest. CI runs Node 22 and 24.
- `npm run typecheck`
- `npx knip --production --no-progress` (CI runs it). `knip.json` lists `src/cli/corpus-check.ts` as a non-production entry; removing it makes knip report that file unused.
- `npm run build` rebuilds both bundles. Commit them with the source change: `shipped.test.ts` fails when they drift.
- `npm run corpus` checks extraction against every transcript under `~/.claude/projects`. No model calls.
- `npm run dev` builds, then copies `plugin/` into every folder under `~/.claude/plugins/cache/delulu/delulu/` and deletes files the repo no longer has.

## Refreshing the local install
The `delulu` marketplace is the directory `~/Downloads/delulu`. After committing: `claude plugin marketplace update delulu`, then `claude plugin update delulu@delulu`, then restart. `npm run dev` only copies files; it does not record a new version.

## Constraints
- A handoff covers only the session it saves; nothing is copied from older handoffs. The newest 15 are kept.
- Commits use the repo-local identity `Karan Kumar <136443459+karankumar24@users.noreply.github.com>`. No Claude co-author trailer.
