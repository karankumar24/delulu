# Security

## What delulu does with your data

delulu reads your Claude Code session transcript from disk and writes to `.delulu-handoff/` in your
repository. Nothing is sent anywhere. There is no network call in the shipped code, no telemetry, and no
server.

The handoff folder is created `0700` and every file inside it `0600`. The first capture in a
repository adds `.delulu-handoff/` to your `.gitignore` and says that it did.

## What is redacted, and what is not

Redaction runs as each document is built, on the text delulu takes out of your transcript and your
repository before it goes in: your own messages, the tool errors, the file paths it names, and each
subagent's final result. It is not a pass over the finished file. Every string that reaches
`payload.md`, `context.md`, `index.md` or `citations.json` by that route is matched for:

- API keys and tokens (`sk-`, `sk_live_`, `ghp_`, `github_pat_`, `xox*-`, `AKIA`/`ASIA`, `AIza`)
- JWTs, `Bearer` tokens, and PEM private-key blocks, header through footer
- passwords inside connection strings (`scheme://user:pass@host`)
- explicit assignments to secret-sounding names (`*_KEY=`, `*SECRET=`, `*TOKEN=`, `*PASSWORD=`),
  where the value is long enough to be one
- email addresses, except the one in your own `git config user.email`

One thing that route does not reach: the first line of `payload.md`, `context.md` and `index.md`
names your repository's own directory, and that name is printed as it is on disk. A repository in a
directory called `alice@example.com` puts that address at the top of all three.

**This is pattern matching, not understanding.** It will not catch a secret with no recognisable
shape, a credential described in prose, or a key a model paraphrased. Treat a handoff as a document
containing your own words, because that is exactly what it is.

Handoffs hold your messages verbatim. That is the point of them. Read one before you share it.

## Reporting a vulnerability

If you find a way to make delulu write a secret it should have redacted, leak content outside the
repository, or write outside `.delulu-handoff/`, please report it **privately** rather than in a
public issue. Use GitHub's private vulnerability reporting on this repository, under Security,
Report a vulnerability.

A redaction bypass is worth reporting even if it looks minor. There is no bug bounty; this is a
single-maintainer project and you will get an honest answer about whether and when it will be fixed.
