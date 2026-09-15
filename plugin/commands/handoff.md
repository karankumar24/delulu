---
description: "Save this session so a fresh one picks up where it stopped"
argument-hint: "optional: anything the next session should know"
allowed-tools: Bash(node:*), Write
---

Save this session for the next one. Do not ask the user anything.

1. Write your summary to `.delulu-handoff/note.md` in the project folder with the Write tool. Keep it short and specific:
   - Where things stand. Use full dates and times, never words like "tonight" or "earlier".
   - What we found: conclusions the next session would otherwise have to work out again.
   - The next step, and the user's decision or rule that constrains it, with its line number if you know it.
   - What not to do, and what did not work.

   Then a section headed `## Standing rules`: every rule from the handoff this session loaded that still holds, copied exactly, plus any new rule the user set this session, in their own words. A rule is something the user wants to hold until they take it back.

   If the user contradicted or took back a rule this session, in any words, leave it out of that list. Add it under `## Dropped rules` as `- <the rule, copied exactly> Dropped because: <what the user said, and where>`. A rule left out without a reason is put back.

2. Run this command and show the user its output:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/hook/handoff.mjs"
   ```

That is all. Do not edit the handoff it writes.
