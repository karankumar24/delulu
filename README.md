# delulu

Pick up a Claude Code session in a fresh one, as if you never left.

A long session ends: the context fills up, you hit a limit, or the day is over. The next session starts blank, and you spend its start explaining what you were doing, what you already ruled out, and what you asked for that still holds. delulu saves what matters from one session and hands it to the next, compactly, so the new one starts almost empty and still knows where you were.

Here is [what a handoff looks like](docs/example-handoff.md).

## Two commands

**`/delulu:handoff`** at the end of a session. The agent writes a short note: where things stand, what it found, the next step, and what not to do. delulu adds what it can read for itself from the transcript and the repo, and saves one file.

**`/delulu:resume`** in a fresh session. It loads the newest handoff, says what changed in the repo since it was saved, and tells the agent how to carry on. Add a few words after the command to load an older handoff by its date, or to say what you want to do first.

Neither command asks you anything. Nothing runs in the background, and nothing is registered to fire on its own: delulu does nothing until you type one of the two.

## What a handoff holds

- **The last agent's summary.** Its own view of the session. The next agent is told to check anything it calls done, committed or pushed against git before relying on it.
- **Standing rules.** Things you asked for that hold until you take them back. They travel into every later handoff in your own words. A rule only leaves when the agent writes down why, and one that goes missing without a reason is put back.
- **The repo when saved.** Branch, commit, uncommitted files, and the commits made during the session.
- **The last exchange.** The agent's final reply before you saved.
- **Subagents and background tasks.** What was sent off, and how each one ended.
- **Your messages, newest first.** Word for word, with your answers to the agent's questions.

A handoff aims to fit in one read. When a session is long, the least useful detail is shortened first; your own words never are. Line numbers point back into the transcript, so the next agent can read further when it needs to.

## What it reads, and where it goes

delulu reads your session transcript from disk and writes to `.delulu-handoff/` in your repository. Nothing is sent anywhere. The folder and everything in it are readable only by you, and the first save adds `.delulu-handoff/` to your `.gitignore`. The fifteen newest handoffs are kept.

API keys, tokens and passwords are hidden from everything it writes. So are email addresses, apart from your own and any you typed yourself. Images you sent are saved beside the handoff exactly as they were, not redacted. [SECURITY.md](SECURITY.md) has the details.

Your handoffs hold your own messages word for word. That is the point of them, and worth knowing before you share one.

## Install

Requires Node 22 or newer. In Claude Code:

```
/plugin marketplace add karankumar24/delulu
```

```
/plugin install delulu@delulu
```

If the two commands do not appear straight away, run `/reload-plugins`.

delulu has not been run on Windows yet. Its path handling is tested, but only on macOS. If you try it there, please open an issue either way.

## Limits

- A handoff carries one session. Something you explained in an older session reaches the next one only through the standing rules or the agent's note.
- Redaction matches known shapes of secrets. It will not catch a secret with no recognisable shape, or one described in words.
- The summary is only as good as the agent that wrote it, which is why the next agent is told to check it.

## Development

```
cd app && npm ci && npm test
```

What a user installs is `plugin/`: the two slash commands and the two scripts they run, `plugin/hook/handoff.mjs` and `plugin/hook/resume.mjs`. Those scripts are built from `app/src/` by `npm run build`. Commit them with your change; CI fails if they differ from the source.

`npm run dev` builds and then mirrors your working copy into the installed plugin at `~/.claude/plugins/cache/delulu/`, so a fresh session runs what you just changed. The mirror removes files from the install that your working copy no longer has. Your clone is never touched.

MIT.
