<div align="center">

<img src="docs/banner.png" alt="delulu" width="720">

# delulu is the solulu

**End a Claude Code session, open a fresh one, and pick up right where you stopped.**

<a href="https://github.com/karankumar24/delulu/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/karankumar24/delulu/ci.yml?branch=main&style=flat-square&label=ci" alt="ci"></a>
<a href="#install"><img src="https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square" alt="Claude Code plugin"></a>
<a href="#install"><img src="https://img.shields.io/badge/node-22%2B-339933?style=flat-square" alt="Node 22+"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>

</div>

---

Sessions end. The context fills up, you hit a limit, or it's just late. The next one starts blank, and you end up explaining everything again. delulu saves the session you're in and hands it to the next one.

<table>
<tr>
<th width="50%">A fresh session</th>
<th width="50%">A fresh session with delulu</th>
</tr>
<tr>
<td valign="top">

> **You:** ok where were we
>
> **Claude:** I don't have any context from previous sessions. Could you tell me what you were working on?

</td>
<td valign="top">

> **You:** /delulu:resume
>
> **Claude:** Picking up the rate limiter from Sep 15: the sliding-window fix is committed but not pushed. Next is the test for a burst that straddles two windows.

</td>
</tr>
</table>

## Two commands

**`/delulu:handoff`** when you're done. The agent names the session and writes a short summary. delulu adds what it can read for itself from the transcript and the repo, and saves it all as one file.

**`/delulu:resume`** in the next session. It loads the newest handoff, tells you what changed in the repo since, flags any work done after the save, and carries on. Add a handoff's name to load a specific one, or `--list` to see them all.

Neither command asks you anything, and nothing runs in the background.

## What carries over

- **The agent's summary**: where things stand, what it found, what was decided, the next step, and what not to do. It's marked unchecked, so the next agent confirms anything done or pushed against git.
- **The repo**: branch, commit, uncommitted files, and the commits made in the session.
- **The agent's last reply**, and how each subagent or background task ended.
- **Every message you sent**, word for word, with your answers to its questions.

A handoff holds one session, the one you saved. Nothing piles up from older ones. [See a full example.](docs/example-handoff.md)

## Install

Needs Node 22 or newer. In Claude Code:

```
/plugin marketplace add karankumar24/delulu
```

```
/plugin install delulu@delulu
```

If the commands don't show up, run `/reload-plugins`.

## Your data

- delulu reads your session from disk and writes to `.delulu-handoff/` in your repo. Nothing is sent anywhere.
- That folder is readable only by you, and the first save adds it to `.gitignore`. The 15 newest handoffs are kept.
- API keys, tokens, passwords and email addresses are redacted, except your own email and any you typed. Images are saved as you sent them.
- Your messages are copied word for word, so read a handoff before you share it. [SECURITY.md](SECURITY.md) has the details.

## Good to know

- Redaction matches known shapes of secrets. It won't catch one written out in plain words.
- The summary is the last agent's own view, which is why the next one checks it.
- Each folder keeps its own handoffs, and so does each git worktree.
- Not tried on Windows yet. If you run it there, please open an issue either way.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup. MIT licensed.
