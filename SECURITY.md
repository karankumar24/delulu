# Security

## What delulu does with your data

delulu reads your Claude Code session transcript from disk, runs `git` in your repository, and writes to
`.delulu-handoff/` in that repository. Nothing is sent anywhere. There is no network call in the shipped
code, no telemetry, and no server.

The handoff folder is created `0700` and every file inside it `0600`. The first save in a repository
adds `.delulu-handoff/` to your `.gitignore` and says that it did.

## What is redacted, and what is not

Before a handoff is written, the text delulu takes from your session is redacted: the agent's note,
your messages and answers, the agent's last reply, how the session ended, what
each subagent was sent to do and how it ended, and the subjects of commits made during the session.
Redaction runs before anything is shortened, so a cut can never leave part of a key behind. It matches:

- API keys and tokens (`sk-`, `sk_live_`, `sb_secret_`, `ghp_` and the other GitHub prefixes,
  `github_pat_`, `xox*-`, `AKIA`/`ASIA`, `AIza`, `ya29.`)
- Slack and Discord webhook URLs
- JWTs, `Bearer` tokens, and PEM private-key blocks
- passwords inside connection strings (`scheme://user:pass@host`)
- values assigned to secret-sounding names (`*_KEY=`, `*SECRET=`, `*TOKEN=`, `*PASSWORD=`) that look
  like secrets
- email addresses, except the one in your `git config user.email` and any you typed yourself

Some things are written as they are: the name of your repository's folder, the branch name, and file
paths such as the transcript's location.

Images are not redacted at all. A screenshot you paste into a session is saved into the handoff's
`images/` folder exactly as you sent it, because redaction reads text and cannot read a picture.

**This is pattern matching, not understanding.** It will not catch a secret with no recognisable
shape, a credential described in words, or a key a model paraphrased. A handoff holds your own
messages word for word. Read one before you share it.

## Reporting a vulnerability

If you find a way to make delulu write a secret it should have redacted, leak content outside the
repository, or write outside `.delulu-handoff/`, please report it privately rather than in a public
issue. Use GitHub's private vulnerability reporting on this repository, under Security, Report a
vulnerability.

A redaction bypass is worth reporting even if it looks minor. There is no bug bounty; this is a
single-maintainer project and you will get an honest answer about whether and when it will be fixed.
