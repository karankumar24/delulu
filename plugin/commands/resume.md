---
description: "Carry on from where your last session stopped"
argument-hint: "optional: a handoff name, or what you want to do first"
allowed-tools: Bash(node:*), Read
---

Run this command and read all of its output:

```
node "${CLAUDE_PLUGIN_ROOT}/hook/resume.mjs" $ARGUMENTS
```

Then follow the "How to carry on" steps it prints. If it says the handoff continues in a file, read the rest before you reply.
