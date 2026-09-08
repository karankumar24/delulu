# An example handoff

This is what `/delulu:handoff` produces, and what `/delulu:resume` loads in the next session. The
real tool generated it from a short made-up session about a rate limiter, and then the interview
sections were filled in the way a capture fills them. Nothing below is edited to flatter it. The
structure, the wording, and the split down the middle are what you actually get.

The thing to look at is the line marked in the middle. Above it, delulu read the repository and
your transcript for itself. Below it, an agent is writing from memory. Both halves are worth
reading, but only one of them is evidence, and the file tells you which.

---

# delulu handoff — ratelimiter · 2026-09-07T07-38-37

## What I checked myself — read from the real repo and disk when this was captured
- Branch `main` @ `f197512` · tree **1 uncommitted entry**
- Full session ≈ **3KB** (this conversation). This handoff carries the engine-verified blocks here + a compressed, *unverified* agent summary — a fraction of the full transcript. For the literal transcript, run `claude --resume`.

## What you said — every message you sent, in order, straight from the transcript
_Engine-extracted, not the agent's paraphrase. `L<n>` is the line in the raw transcript — read around it to recover any of this in full._

- `L1` "the rate limiter drops requests in bursts even when the caller is well under the limit. figure out why before changing anything"
- `L6` "so its the window not the count. dont just bump the number"
- `L8` _(your pick — the agent's own recommendation)_ "Rolling window with a timestamp log (Recommended)" — asked: "The fix?"
- `L9` "also this has to stay O(1) memory per caller, we have 200k of them. thats not negotiable"
- `L13` "good. leave the redis migration alone for now, thats next week"
- `L15` _(your pick — the agent's own recommendation)_ "Commit, do not push (Recommended)" — asked: "Commit?"

- **Agent's last reply (gist):** Committed as fix(limiter): a fixed window charged a boundary-spanning caller twice.

## What broke — tool errors from this session, pulled from the transcript, each with where it stands now (errors from subagents aren't here; they live in each subagent's own transcript)
- `L3` `Bash` `npx vitest run src/limiter.test.ts` failed: "Exit code 1 FAIL src/limiter.test.ts > allows 60 in a rolling minute AssertionError: expected 47 to be 60" — cleared later at `L11`

---
> **Everything below this line is the last session's agent writing from memory, and delulu could not check any of it.** What is above the line it can prove: it read the repo and the disk, and it quoted you word for word. What is below is a colleague's handwritten note — worth reading, not worth trusting on its own. Before you act on anything that matters, and especially on "committed", "pushed", "done" or "tests pass", check it against what delulu actually read above.

## What holds until you say otherwise
- Per-caller memory stays O(1). There are 200k callers. `L9`: "this has to stay O(1) memory per caller, we have 200k of them. thats not negotiable" — cannot be a check: a test pins the data structure that exists today, and this governs the one that replaces it.

## Where we left off
The burst drops were never a threshold problem, and you said so before I did — `L6`, "so its the
window not the count. dont just bump the number". The limiter used a fixed window that resets on the
wall-clock minute, so a caller whose traffic straddles a boundary is charged for both halves and
sees 47 of its 60 accepted.

We had settled on a rolling window and then you killed the obvious implementation of it: a timestamp
log per caller is O(n) and there are 200k callers. What replaced it is a sliding-window counter —
the previous window's count, the current one's, and a weight — which is O(1) and is what is now
committed and green. The conversation stopped right after that, with the commit made and not pushed.

## What else went wrong
- The first fix proposed was a timestamp log, which reads as the textbook rolling window and is the
  wrong shape at 200k callers. It was never written, only proposed, and the memory constraint
  arrived at `L9` before any code did.
- No dead ends beyond that. The single test failure is above and cleared at `L11`.

## What you decided this session
- A rolling window, not a higher limit. `L6`: "dont just bump the number"
- Sliding-window counter over a timestamp log, to hold O(1). `L9`: "this has to stay O(1) memory per caller"
- The Redis migration is out of scope this week. `L13`: "leave the redis migration alone for now, thats next week"
- Commit locally, do not push. `L15`: "Commit, do not push (Recommended)" — the agent's own recommendation, not your words

## What I made of it (unchecked)
- The sliding-window weight makes the boundary approximate rather than exact. At 60/min the error is
  under one request, which I judged acceptable and you did not weigh in on. If the limit is ever
  raised, that assumption is worth re-checking.
- I did not look at whether any other module reads `LIMIT` directly and would now disagree with the
  limiter about what a window is.

## Start here
**Grep for `LIMIT` outside `src/limiter.ts` and see whether anything else still assumes a fixed
window.** Not `file:line` — line numbers rot; the identifier does not.

Why this is first: the fix changed what a window means, and that meaning was previously implicit in
a single constant that other modules may read. If something else counts against the wall-clock
minute, the bug still exists, one layer out, and the green test will not see it.

Do NOT re-derive: the fixed-window diagnosis is settled, the timestamp-log approach is dead on the
memory constraint, and the Redis migration is deliberately out of scope until next week.

## More, if you need it
- `.delulu-handoff/2026-09-07T07-38-37/index.md` — map of the prior session (line-refs); to recover ANY detail verbatim, Read the raw transcript around that line instead of reloading it all

---
Pick it up from **Start here**. Ask me about anything that's missing before you get going.
