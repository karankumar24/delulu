# delulu

Carry a Claude Code session into a fresh one without replaying it.

Half of what it writes is read straight from your repository and your transcript, quoted word for word, and checked again when it is loaded. The other half is the agent writing from memory. The document says which is which, on the page, every time.

Here is [what a handoff looks like](docs/example-handoff.md).

## The problem

A session ends and the next one starts blank. You re-explain what you were doing, what you already ruled out, and why the obvious approach is wrong.

`claude --resume` solves that by giving you the session back. It does it by replaying the transcript into your new context window, which spends the exact thing you needed the fresh session for. Every tool result, every file you read, every dead end, all of it back in the window before you type a word.

delulu takes the other route. It reads the session once, writes down what actually matters, and loads that instead.

## Two commands

**`/delulu:handoff`** at the end of a session. It reads the repo and the transcript itself, then asks you what it cannot know, and seals the result under a short name you will recognise later.

**`/delulu:resume`** in the fresh session. It loads the last handoff, or one you name. The new session picks up the thread and you explain nothing.

Nothing runs in the background, nothing is registered to fire on its own, and delulu does nothing at all until you type one of those two commands.

## The line down the middle

The document is split down the middle, on purpose.

Above the line is what delulu read for itself: the branch and commit from disk, your own messages quoted verbatim with line references back into the transcript, and the tool errors that actually happened. None of it is a model's recollection.

Below the line is the agent writing from memory: where the conversation stopped, what it made of the session, what it thinks you should do next. Useful, and not proof of anything.

Every locked decision carries the line number where you said it, and the words you used. delulu re-checks those citations when the handoff is written and again when it is loaded, and prints any that do not trace back to something you actually said. A decision that rests on a button you pressed rather than a sentence you typed is reported as exactly that.

The split exists because a handoff usually goes wrong by being confidently wrong, not by leaving something out.

## What that costs

A handoff is small next to the session it replaces, but it is not a page of notes. Expect a few thousand words. `delulu resume` tells you how big one is before it loads it.

If a handoff told you everything, it would just be the transcript again, and you would be spending the context you were trying to save.

## Standing rules

Some of what you decide is true for one session and then spent. Other things hold until you say otherwise. delulu keeps those two apart, and the second kind travels into every later session, still quoting the words you used when you set it, until you take it back.

Without that, a rule you set once quietly stops being carried, and you find yourself saying it again a week later without noticing you already had.

## What it reads, and where it goes

delulu reads your session transcript from disk and writes to `.delulu-handoff/` in your repository. Nothing is sent anywhere. The folder and everything in it are readable only by you. API keys, tokens and database passwords are stripped out of every file it writes.

Email addresses go too, apart from your own, the one git already knows you commit under. Yours is kept because an address is often the point of the sentence it sits in. Anyone else's is replaced, and if git cannot tell who you are, all of them are.

Your handoffs hold your own messages verbatim. That is the point of them, and it is worth knowing before you commit one somewhere public.

## Install

Requires Node 22 or newer.

In Claude Code:

```
/plugin marketplace add karankumar24/delulu
```

```
/plugin install delulu@delulu
```

If the two commands do not appear straight away, `/reload-plugins`.

Handoffs are written to `.delulu-handoff/` in the repository they belong to. The first capture in a repository adds that line to your `.gitignore` for you and tells you it did.

The `delulu` command lives on `PATH` inside Claude Code's Bash tool, which is where the two slash commands run it. Nothing is installed into your own shell, so typing `delulu` in your terminal answers `command not found`. That is expected, and not a failed install.

**Nothing here has ever been run on Windows.** A `.cmd` shim ships beside the `sh` script, and the path handling takes its separator from the path rather than from the machine, tested against Windows-shaped paths, but tested on a Mac. Whether a capture works end to end on Windows is unknown until somebody runs it there. If that is you, please open an issue either way.

## Honest limits

delulu is tuned on real use, but all of that use is one person's, across their own projects. Nobody else's sessions have been measured yet. If you work in longer or shorter bursts than whoever built this, the sizes it aims for may not suit you.

Handoffs do get deleted. Every capture keeps the fifteen newest and tells you which ones it removed. Unfinished ones are left alone, since they still hold your words and you might come back to them.

If a handoff comes out too big to hand over in one go, delulu says so when it saves it, and trims it with a notice when it loads.

Your first handoff is as complete as any later one. What you do not have on day one is anything that reaches back further, like a decision that points at an earlier handoff, or a rule you locked weeks ago still travelling in your own words. That starts on your second.

## Development

The plugin a user installs is `plugin/`, and it is self-contained. Two files in it are **generated** from `app/src/`: `plugin/hook/handoff.mjs` and `plugin/hook/resume.mjs`. Edit the source and rebuild, or the next build will revert your change. The third, `plugin/hook/cli.mjs`, is the dispatcher: hand-written, and edited in place.

```
cd app && npm ci && npm test
```

`npm run build` regenerates those two bundles and writes nowhere else. Commit them with your change; CI fails if they drift from the source.

`npm run dev` and `npm run sync` additionally mirror your working copy into the installed delulu at `~/.claude/plugins/cache/delulu/`, so a fresh session runs what you just edited. The mirror goes one way and it deletes: anything the install has that your working copy does not is removed from the install. Your clone is never touched.

MIT.
