<div align="center">

<img src="docs/banner.png" alt="delulu" width="720">

# delulu is the solulu

**End a Claude Code session, open a fresh one, and pick up right where you stopped.**

<a href="https://github.com/karankumar24/delulu/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/karankumar24/delulu/ci.yml?branch=main&style=flat-square&label=ci" alt="ci"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>

</div>

---

Sessions end. The context fills up, you hit a limit, or it's late. The next one starts blank, and you explain everything again. delulu saves the session you're in and hands it to the next one.

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

**`/delulu:handoff`** when you're done. It saves the session to a folder in your repo.

**`/delulu:resume`** in the next session. It loads the latest save, tells you what changed in the repo since, and carries on.

Neither one asks you anything, and nothing runs in the background.

## What carries over

- The agent's summary: where things stand, what was decided, and what's next. The next agent checks it against git before trusting it.
- The state of your repo.
- Every message you sent, word for word. For a `!` shell command, the command is kept but not its output.

[See a full example.](docs/example-handoff.md)

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

Everything stays on your machine, in `.delulu-handoff/` in your repo, and delulu adds that folder to your `.gitignore`. Common key and password formats are redacted (images are not), but your messages are copied as you wrote them, so read a handoff before you share it. [SECURITY.md](SECURITY.md) has the details.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup. MIT licensed.
