---
description: "Save this session so a fresh one picks up where it stopped"
argument-hint: "optional: anything the next session should know"
allowed-tools: Bash(node:*), Write
---

Save this session for the next one. Do not ask the user anything.

1. Write your summary of this session to `.delulu-handoff/note-${CLAUDE_SESSION_ID}.md` in the project folder with the Write tool. Cover this session only, short and specific:
   - First line: `name: ` and 2 to 5 plain words saying what this session was about, like `name: ladder fix live check`. It is how the user will find this handoff again.
   - Where things stand. Use real dates, never words like "tonight" or "earlier".
   - What we found: conclusions the next session would otherwise have to work out again.
   - Decided this session: only what was reasoned through and settled in this session, each with the user's own words that settled it, quoted briefly, when there were any. A pick from a question decides only what that question asked; never widen it into a general rule. Leave out anything from earlier sessions unless it was settled again in this one.
   - The next step.
   - What not to do, and what did not work.

2. Run this command and show the user its output:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/hook/handoff.mjs"
   ```

That is all. Do not edit the handoff it writes.
