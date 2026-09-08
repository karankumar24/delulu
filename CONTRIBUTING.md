# Contributing

Thanks for looking. This is a single-maintainer project, so the honest summary is
that issues get read and answered, and pull requests get read carefully but may
take a while.

## Before you write code

Open an issue first if the change is more than a fix. It saves you building
something I then ask you to rebuild, and most of what delulu does has a reason
behind it that is easier to explain than to guess at.

Bug reports are more useful than they sound. If a handoff came out wrong, say
what you expected and what you got. You do not need to attach the handoff, and
you should read it before you do, because it holds your own messages.

## Running the tests

You need Node 22 or newer.

```
cd app && npm ci && npm test
```

The tests are the specification here. Almost every one is named after the
behaviour it protects rather than the function it calls, and most exist because
something went wrong once. If you change behaviour, the test that fails will
usually tell you what you broke and why it mattered.

## The part that catches people out

The plugin a user installs is `plugin/`, and two files in it are generated from
`app/src/`: `plugin/hook/handoff.mjs` and `plugin/hook/resume.mjs`. Edit the
source, then run `npm run build`, and commit the rebuilt bundles with your
change. CI fails if they drift from the source, because a fix that is not
rebuilt ships to nobody while every test still passes.

The third file, `plugin/hook/cli.mjs`, is hand written and edited in place.

`npm run dev` and `npm run sync` also mirror your working copy into the delulu
installed at `~/.claude/plugins/cache/delulu/`, which is convenient when you
want a fresh session to run what you just edited. Be aware that the mirror goes
one way and it deletes: anything the install has that your working copy does not
is removed from the install. Your clone is never touched. If you have delulu
installed and you are working from a throwaway clone, use `npm run build`
instead.

## Style

Match what is already there. Comments explain why something is the way it is,
not what the line does, and several of them exist to stop a future change
quietly undoing a fix.

Keep user facing text plain. No statistics, no internal measurements, no war
stories from development. Someone reading the output should not have to know
anything about how it was built.

## Security

Do not open a public issue for anything that looks like a way to make delulu
leak content it should have redacted. Report it privately instead. SECURITY.md
says how.
