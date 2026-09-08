**What this changes, and why**

**Checklist**

- [ ] `cd app && npm ci && npm test` passes
- [ ] If I edited `app/src/`, I ran `npm run build` and committed the rebuilt
      `plugin/hook/handoff.mjs` and `plugin/hook/resume.mjs`. CI fails if these
      drift from the source.
- [ ] User facing text stays plain: no statistics, no internal measurements, no
      notes about how it was built.

**Anything you are unsure about**

Say so here rather than leaving it out. It is more useful than a tidy summary.
