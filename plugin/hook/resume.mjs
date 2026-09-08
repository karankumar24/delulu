// src/cli/resume.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync3, readFileSync as readFileSync4, unlinkSync, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { join as join5 } from "node:path";

// src/engine/repo-key.ts
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// src/engine/git-env.ts
var REPO_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES"
];
function gitEnv() {
  const env = { ...process.env };
  for (const k of REPO_LOCATION_VARS) delete env[k];
  return env;
}

// src/engine/repo-key.ts
function repoKey(dir) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      env: gitEnv(),
      encoding: "utf8",
      timeout: 5e3,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    if (top) return realpathSync(top);
  } catch {
  }
  const here = realpathSync(dir);
  return discoverRoot(here) ?? here;
}
function discoverRoot(from) {
  let dir = from;
  let dev;
  try {
    dev = statSync(dir).dev;
  } catch {
    return void 0;
  }
  for (; ; ) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects")) && existsSync(join(dir, "refs"))) {
      return basename(dir) === ".git" ? dirname(dir) : dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return void 0;
    try {
      if (statSync(parent).dev !== dev) return void 0;
    } catch {
      return void 0;
    }
    dir = parent;
  }
}

// src/engine/repo-files.ts
function namesSameRepoFile(named, changed) {
  const forms = named.includes("/") ? [named] : [named, named.replace(/\\/g, "/")];
  return forms.some((n) => n === changed || changed.endsWith(`/${n}`) || n.endsWith(`/${changed}`));
}

// src/cli/entry.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { fileURLToPath } from "node:url";
function isProgram(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync2(entry) === realpathSync2(fileURLToPath(moduleUrl));
  } catch {
    return true;
  }
}

// src/cli/handoff-name.ts
import { existsSync as existsSync2, readFileSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
var STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/;
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var NAME_CAP = 48;
function stampWhen(stamp, now) {
  const m = STAMP.exec(stamp);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const when = new Date(y, mo - 1, d, h, mi, s);
  if (when.getFullYear() !== y || when.getMonth() !== mo - 1 || when.getDate() !== d) return null;
  const day = `${MONTHS[mo - 1]} ${d}${y === now.getFullYear() ? "" : ` ${y}`}`;
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(when)) / 864e5);
  const age = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return { day, age };
}
function cleanName(raw) {
  const one = raw.replace(/[\r\n]+/g, " ").replace(/["`]/g, "").replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > NAME_CAP ? `${one.slice(0, NAME_CAP - 1).trimEnd()}\u2026` : one;
}
function readName(base, ts) {
  try {
    return cleanName(readFileSync(join2(base, ts, "name.txt"), "utf8"));
  } catch {
    return null;
  }
}
function handoffLabel(base, ts, now) {
  const name = readName(base, ts);
  if (name) return name;
  const when = stampWhen(ts, now);
  return when ? `${when.day} handoff` : ts;
}
var CARRIED_REF = /`(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?):L(\d+)`/g;
function nameCarriedRefs(text, base, now) {
  return text.replace(CARRIED_REF, (whole, stamp, line) => {
    const name = readName(base, stamp);
    if (name) return `\`${name} \xB7 L${line}\``;
    const when = existsSync2(join2(base, stamp)) ? stampWhen(stamp, now) : null;
    return when ? `\`${when.day} handoff \xB7 L${line}\`` : whole;
  });
}
var TITLE = /^(# delulu handoff(?: —|:) .+?) · (\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?)$/m;
function nameTitle(text, base, now) {
  return text.replace(TITLE, (whole, head, stamp) => {
    const label = readName(base, stamp) ?? stampWhen(stamp, now)?.day;
    return label ? `${head} \xB7 ${label}` : whole;
  });
}

// src/cli/citations.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/cli/payload.ts
var BASH_OUTPUT_CLIFF = 3e4;
var SAFE_DELIVERY_BYTES = 27e3;
var PREAMBLE_RESERVE = 3600;
var SAFE_PAYLOAD_BYTES = SAFE_DELIVERY_BYTES - PREAMBLE_RESERVE;
var SECTION = {
  /** Engine-written: read from real git and disk at capture. */
  state: "What I checked myself",
  /** Engine-written: the user's own messages, verbatim. */
  said: "What you said",
  /** Engine-written: tool errors, extracted from the transcript. */
  broke: "What broke",
  /**
   * Agent-written, cited like `decided` — and the ONLY block that outlives the session that wrote
   * it. Its name carries its own caveat, exactly as `read`'s parenthetical does, and for the same
   * reason: this block's sharpest failure is a rule that stopped being true still arriving with a
   * verbatim citation attached, which reads as MORE authoritative than a fresh judgement precisely
   * because it has provenance. "until you say otherwise" is the mitigation — it tells the reader,
   * every time they read it, that the only thing keeping this line here is that nobody revoked it.
   */
  holds: "What holds until you say otherwise",
  /** Agent-written: the live conversation, where it stopped. */
  thread: "Where we left off",
  /** Agent-written: the failures no tool recorded. */
  elseWrong: "What else went wrong",
  /**
   * Agent-written, every line cites where the user said it — and it DIES at the session boundary,
   * which is what "this session" in the name is for.
   *
   * It used to be called `What you decided` and it held both lifetimes at once: a permanent rule and
   * a one-session task directive, in one block, emptied every session. Measured on this repo's own
   * library, decisions that crossed a session boundary ran 0, 0, 0, 0, then 4 of 18 once the engine
   * carried them. "Continuity is the product" was locked on 2026-08-17, appeared in NO later
   * handoff, and was restated across five sessions in thirteen days.
   */
  decided: "What you decided this session",
  /** Agent-written and NOT checked. The parenthetical is the trust boundary, not decoration. */
  read: "What I made of it (unchecked)",
  /** Agent-written: the one thing to do first. */
  next: "Start here",
  /** Pointers to the deep files. */
  more: "More, if you need it",
  /** Only in context.md. */
  subagents: "What the subagents found"
};
var CLOSER = `Pick it up from **${SECTION.next}**`;
var DELIVERY_DROP_ORDER = [
  SECTION.read,
  SECTION.elseWrong,
  SECTION.broke,
  SECTION.decided,
  SECTION.said,
  SECTION.more
];
var BLOCK_SHARES = {
  // WHERE THE PREAMBLE RESERVE WAS PAID FROM. Correcting the reserve from a remembered 2,000 to a
  // measured 3,600 took 1,600 bytes out of this table, and it matters which blocks paid.
  //
  // The three ENGINE blocks did not. `said`, `broke` and `state` carry facts, and facts do not
  // compress: `said` guarantees every message is carried by SHORTENING rather than deleting, and
  // cutting its share to 6,400 was tried and broke exactly that — a long session lost nine messages
  // outright instead of quoting all sixty more briefly. A budget that silences the user to pay for
  // the sentence describing the budget has the priority backwards.
  //
  // So the six AGENT-written prose blocks absorbed it, roughly in proportion, because prose is the
  // thing that can say the same amount in less. `holds` is exempt among them: a test pins it above
  // 3,396, and shrinking the standing-rules block to pay for a preamble is the trade this module
  // exists to refuse.
  [SECTION.said]: 8e3,
  [SECTION.holds]: 3600,
  [SECTION.broke]: 2e3,
  [SECTION.read]: 1900,
  [SECTION.thread]: 1800,
  [SECTION.decided]: 1700,
  [SECTION.next]: 1450,
  [SECTION.elseWrong]: 1250,
  [SECTION.state]: 1100,
  // Held at 600 rather than cut with the rest of the prose. Since the pointers were costed FIRST,
  // context.md and index.md are costed FIRST and in full, and the subagent gists take whatever is
  // left — so this share is not a ceiling on prose, it is the room the gists live in. Trimmed to
  // 500 the pointers consumed all of it and every gist disappeared, which is a block silently
  // losing its content rather than shortening it. The extra 100 came from `read` instead, the most
  // compressible thing in the file: the agent's own unchecked conclusions.
  [SECTION.more]: 600
};
function deliveryBytes(text) {
  return Buffer.byteLength(text, "utf8");
}
var AGENT_ZONE = "\n---\n> **Everything below";
var esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var SECTION_END = new RegExp(`\\n##\\s|${esc(AGENT_ZONE)}|\\n---\\n${esc(CLOSER.slice(0, 20))}`);
function headingRe(name) {
  return new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*$`, "m");
}
var DECIDED_BEFORE_SPLIT = "What you decided";
var ALSO_KNOWN_AS = {
  [SECTION.decided]: [DECIDED_BEFORE_SPLIT]
};
function headingsFor(name) {
  return [name, ...ALSO_KNOWN_AS[name] ?? []];
}
var KNOWN_HEADINGS = [
  ...new Set(Object.values(SECTION).flatMap((n) => headingsFor(n)))
].sort((a, b) => b.length - a.length);
function sectionOf(head) {
  const text = head.replace(/^##\s+/, "").trim();
  return KNOWN_HEADINGS.find((n) => text.startsWith(n)) ?? text;
}
var RULING_SECTIONS = [SECTION.holds, ...headingsFor(SECTION.decided)];
function sectionBodies(payload, names) {
  const byLongest = [...names].sort((a, b) => b.length - a.length);
  const out = [];
  for (const m of payload.matchAll(/^##\s+[^\n]*$/gm)) {
    if (m.index === void 0) continue;
    const name = byLongest.find((n) => headingRe(n).test(m[0]));
    if (name === void 0) continue;
    const rest = payload.slice(m.index + m[0].length);
    const end = rest.search(SECTION_END);
    out.push({ name, head: m[0], body: end === -1 ? rest : rest.slice(0, end) });
  }
  return out;
}
var CANNOT_BE_A_CHECK = /[—,]\s*cannot be a check:\s*(\S.*?)\s*$/;
function carryReason(line) {
  return CANNOT_BE_A_CHECK.exec(line)?.[1];
}
var CARRY_REASON_MARKER = "cannot be a check:";
var RULE_SHAPE = /\b(?:always|never|must|mustn't|do not|don't|no longer|from now on|every time|by default|under no circumstances|only ever)\b/i;
var NAMES_A_THING = /`[^`\n]*[/.][^`\n]*`|`[0-9a-f]{7,40}`/;
var SURVIVED_A_HOP = /`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?:L\d+`/;
function classifyRuling(line, from) {
  if (from !== void 0 && headingRe(SECTION.holds).test(`## ${from}`)) return "rules";
  const filedAsSpent = from !== void 0 && headingsFor(SECTION.decided).some((h) => headingRe(h).test(`## ${from}`));
  if (!filedAsSpent && SURVIVED_A_HOP.test(line)) return "rules";
  if (RULE_SHAPE.test(line)) return "rules";
  if (NAMES_A_THING.test(line)) return "session";
  return "unsorted";
}
function rulingHeadings(payload) {
  return sectionBodies(payload, RULING_SECTIONS).filter((s) => s.body.trim()).map((s) => s.name);
}
function rulingBlockNames(payload) {
  const filled = rulingHeadings(payload);
  if (filled.length) return filled;
  const present = sectionBodies(payload, RULING_SECTIONS).map((b) => b.name);
  return present.length ? present : [DECIDED_BEFORE_SPLIT];
}
function namedBlocks(names) {
  const order = (n) => {
    const i = RULING_SECTIONS.indexOf(n);
    return i === -1 ? RULING_SECTIONS.length : i;
  };
  const named = names.length ? [...new Set(names)].sort((a, b) => order(a) - order(b)) : [SECTION.decided];
  return named.map((n) => `"${n}"`).join(" and ");
}
var STATE_HEADING = `## ${SECTION.state}`;
function isIncompletePayload(text) {
  return payloadProblem(text) !== "";
}
function payloadProblem(text) {
  if (!text.trim()) return "the payload file is empty";
  if (!text.includes(STATE_HEADING)) return "this file is missing the block delulu always writes first, so it is either cut short or not a delulu handoff";
  if (!text.includes(AGENT_ZONE)) return "the payload stops before the agent-written sections, it looks truncated";
  if (text.includes("<!-- delulu:fill")) return "some sections were never filled in";
  if (!text.includes(CLOSER)) return "the payload has no closing line, so it is cut short, the sections after the cut are missing, not empty";
  const withCloser = text.slice(text.indexOf(AGENT_ZONE));
  const closerAt = withCloser.lastIndexOf(CLOSER);
  const zone = closerAt === -1 ? withCloser : withCloser.slice(0, closerAt).replace(/\n---\n$/, "\n");
  const parts = zone.split(/^(##\s[^\n]*)$/m);
  let blanks = 0;
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i + 1]?.trim()) continue;
    if (RULING_SECTIONS.some((n) => headingRe(n).test(parts[i]))) continue;
    blanks++;
  }
  return blanks ? `${blanks} section(s) were left blank` : "";
}

// src/cli/citations.ts
function parseCitationRecord(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const src = parsed;
  const out = { userLines: [], utterances: {}, truncated: {}, recommended: {}, absent: [] };
  const absent = [];
  for (const k of ["userLines", "utterances", "truncated", "recommended"])
    if (!(k in src) || src[k] === void 0) absent.push(k);
  out.absent = absent;
  if (Array.isArray(src.userLines)) out.userLines = src.userLines.filter((n) => typeof n === "number");
  const asRecord = (v) => v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v).filter(([k]) => /^\d+$/.test(k)) : [];
  for (const [k, v] of asRecord(src.utterances)) {
    if (typeof v === "string") out.utterances[Number(k)] = v;
    else if (Array.isArray(v)) out.utterances[Number(k)] = v.filter((x) => typeof x === "string");
  }
  for (const [k, v] of asRecord(src.truncated)) if (typeof v === "number") out.truncated[Number(k)] = v;
  for (const [k, v] of asRecord(src.recommended))
    if (Array.isArray(v)) out.recommended[Number(k)] = v.filter((x) => typeof x === "string");
  return out;
}
var UNRUN = {
  userLines: "which lines you spoke on was never recorded, so no citation below could be checked at all",
  utterances: "what you actually said was never recorded, so no quote below could be checked against your words",
  truncated: "whether a message was stored clipped was never recorded, so a real quote from a long message can come back as uncheckable",
  recommended: "whose words a decision is in, yours, or a label the agent wrote and marked for you, was never recorded"
};
var MIN_FRAGMENT = 8;
var MIN_OPENING = 4;
function normalizeForCompare(s) {
  return s.replace(/(?:…|\.\.\.)\s*$/, "").replace(/\\(["'])/g, "$1").replace(/[‘’‛]/g, "'").replace(/[“”‟]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}
function straightenQuotes(s) {
  return s.replace(/[“”„‟]/g, '"');
}
var MAX_QUOTE_DELIMS = 64;
function quotedCandidates(text) {
  const s = straightenQuotes(text);
  const quotes = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '"') quotes.push(i);
  if (quotes.length > MAX_QUOTE_DELIMS) return null;
  const out = /* @__PURE__ */ new Set();
  for (let a = 0; a < quotes.length; a++)
    for (let b = a + 1; b < quotes.length; b++) {
      const frag = s.slice(quotes[a] + 1, quotes[b]).trim();
      if (frag) out.add(frag);
    }
  return [...out];
}
var SESSION_STAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}";
var CARRIED_REF2 = new RegExp(`(?<![A-Za-z0-9])(${SESSION_STAMP}):L(\\d+)(?![A-Za-z0-9])`, "g");
var STAMP_ONLY = new RegExp(`^${SESSION_STAMP}$`);
var REF_SPAN = new RegExp(`^\`(?:${SESSION_STAMP}:)?L\\d+\`$`);
function refScan(text) {
  const spans = text.replace(/`[^`]*`/g, (span) => REF_SPAN.test(span) ? span : " ".repeat(span.length));
  const quotable = text.replace(/`[^`]*`/g, (span) => span.includes('"') ? " ".repeat(span.length) : span);
  const carried = [];
  const scan = spans.replace(CARRIED_REF2, (m, session, n, at) => {
    carried.push({ session, line: Number(n), end: at + m.length });
    return " ".repeat(m.length);
  });
  const matches = [...scan.matchAll(/(?<![A-Za-z0-9])L(\d+)(?![A-Za-z0-9])/g)];
  const ends = [...matches.map((m) => (m.index ?? 0) + m[0].length), ...carried.map((c) => c.end)];
  return {
    scan,
    quotable,
    refs: matches.map((m) => Number(m[1])),
    carried: carried.map(({ session, line }) => ({ session, line })),
    firstEnd: ends.length ? Math.min(...ends) : 0
  };
}
function linesInBody(body) {
  const MARKER = /^(?:[-*+]\s+|\d+[.)]\s+)/;
  const FILL = /^<!--\s*delulu:fill\b/;
  const src = body.split("\n");
  const visible = [];
  for (let i = 0; i < src.length; i++) {
    const t = src[i].trim();
    if (!t.startsWith("<!--")) {
      visible.push(src[i]);
      continue;
    }
    if (!FILL.test(t)) continue;
    let j = i;
    while (j < src.length && !src[j].includes("-->")) j++;
    if (j >= src.length) continue;
    const span = src.slice(i, j + 1);
    if (span.some((l) => {
      const s = refScan(l);
      return MARKER.test(l.trim()) || s.refs.length > 0 || s.carried.length > 0;
    })) continue;
    const tail = src[j].slice(src[j].indexOf("-->") + 3);
    if (tail.trim() && !tail.trim().startsWith("<!--")) visible.push(tail);
    i = j;
  }
  const out = [];
  for (const raw of visible) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    if (MARKER.test(t) || !out.length) out.push(t.replace(MARKER, ""));
    else out[out.length - 1] += ` ${t}`;
  }
  return out;
}
function decidedEntries(payload) {
  const out = [];
  for (const { name, body } of sectionBodies(payload, RULING_SECTIONS))
    for (const text of linesInBody(body)) out.push({ text, section: name });
  return out;
}
function checkCitations(payload, userLines, utterances = {}, truncated = {}, opts = {}) {
  const report = { ok: 0, verified: 0, bad: [], misquoted: [], uncited: [], unverifiable: [], unchecked: [], agentWorded: [], carried: [], unrecorded: [] };
  const entries = decidedEntries(payload);
  if (!entries.length) return report;
  for (const field of opts.absent ?? []) {
    const why = UNRUN[field];
    if (why) report.unrecorded.push(why);
  }
  const valid = new Set(userLines);
  const here = { userLines, utterances, truncated, recommended: opts.recommended ?? {} };
  const saidAt = (rec, n) => {
    const v = rec.utterances[n];
    if (typeof v === "string") return [v];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  };
  const seen = /* @__PURE__ */ new Map();
  const recordFor = (session) => {
    if (!opts.carried) return null;
    if (!seen.has(session)) seen.set(session, opts.carried(session));
    return seen.get(session) ?? null;
  };
  for (const { text: l, section } of entries) {
    const { quotable, refs, carried } = refScan(l);
    const text = l.replace(/^[-*]\s+/, "");
    if (!refs.length && !carried.length) {
      report.uncited.push({ text, section });
      continue;
    }
    const resolved = carried.map((c) => ({ ...c, record: recordFor(c.session) }));
    const missing = [...new Set(resolved.filter((r) => !r.record).map((r) => r.session))];
    const primary = refs.length ? { line: refs[0] } : { line: carried[0].line, session: carried[0].session, unresolved: missing.includes(carried[0].session) || void 0 };
    const bad = userLines.length ? refs.filter((n) => !valid.has(n)) : [];
    if (bad.length) {
      report.bad.push({ text, line: bad[0], section });
      continue;
    }
    const badCarried = resolved.find((r) => r.record && !r.record.userLines.includes(r.line));
    if (badCarried) {
      report.bad.push({ text, line: badCarried.line, session: badCarried.session, section });
      continue;
    }
    const proven = resolved.find((r) => r.record);
    if (proven) report.carried.push({ text, line: proven.line, session: proven.session, section });
    if (!userLines.length && !resolved.some((r) => r.record)) {
      report.ok++;
      report.unverifiable.push({ text, ...primary, unresolved: true, why: missing.length ? missingWhy(missing) : NO_RECORD });
      continue;
    }
    const fragments = quotedCandidates(quotable);
    if (fragments === null) {
      report.ok++;
      report.unverifiable.push({ text, ...primary, why: "that line carries too many quote marks to pair up" });
      continue;
    }
    const said = [];
    const collect = (rec, n, session) => {
      const rc = rec.recommended[n] ?? [];
      for (const t of saidAt(rec, n)) said.push({ text: t, line: n, session, recommended: rc.includes(t) });
    };
    for (const n of refs) collect(here, n);
    for (const r of resolved) if (r.record) collect(r.record, r.line, r.session);
    const usable = fragments.filter((f) => normalizeForCompare(f));
    if (!usable.length) {
      report.ok++;
      continue;
    }
    if (!said.length) {
      report.ok++;
      if (missing.length) report.unverifiable.push({ text, ...primary, why: missingWhy(missing) });
      continue;
    }
    const matched = said.filter((s) => usable.some((f) => quoteMatches(f, s.text)));
    if (matched.length) {
      report.ok++;
      if (matched.every((s) => s.recommended)) {
        const m = matched[0];
        report.agentWorded.push({ text, line: m.line, session: m.session, label: m.text, section });
      } else report.verified++;
    } else if (missing.length) {
      report.ok++;
      report.unverifiable.push({ text, ...primary, why: missingWhy(missing) });
    } else if (usable.every((f) => normalizeForCompare(f).length < MIN_FRAGMENT)) {
      report.ok++;
      report.unchecked.push({ text, ...primary, fragment: usable[0] });
    } else if (refs.some((n) => truncated[n]) || resolved.some((r) => r.record?.truncated[r.line])) {
      report.ok++;
      report.unverifiable.push(refs.length ? { text, line: refs[refs.length - 1] } : { text, line: carried[carried.length - 1].line, session: carried[carried.length - 1].session });
    } else {
      report.misquoted.push({ text, ...primary, fragment: usable[0], section });
    }
  }
  return report;
}
var NO_RECORD = "no record of what you said was stored beside this handoff, so nothing could be checked against it";
function missingWhy(missing) {
  return `the record for the handoff it cites (\`${missing.join("`, `")}\`) could not be read, pruned, or captured elsewhere`;
}
function quoteMatches(fragment, utterance) {
  const frag = normalizeForCompare(fragment);
  const full = normalizeForCompare(utterance);
  if (frag.length >= MIN_FRAGMENT) return full.includes(frag);
  if (full === frag) return true;
  return frag.length >= MIN_OPENING && full.startsWith(frag) && !/[a-z0-9]/.test(full[frag.length] ?? " ");
}
function citationItems(r) {
  const ref = (line, session) => `\`${session ? `${session}:` : ""}L${line}\``;
  const out = [];
  for (const b of r.bad)
    out.push(`cites ${ref(b.line, b.session)}, where the user did not speak: "${b.text.slice(0, 110)}"`);
  for (const m of r.misquoted)
    out.push(`quotes words the user did not say at ${ref(m.line, m.session)}, quoted: "${m.fragment.slice(0, 90)}": "${m.text.slice(0, 110)}"`);
  for (const u of r.uncited)
    out.push(`no citation, this is the agent's conclusion, not the user's ruling: "${u.text.slice(0, 110)}"`);
  const soft = r.unverifiable.map((u) => {
    if (!u.unresolved)
      return `${ref(u.line, u.session)} is a line you really spoke, but ${u.why ?? "that message was too long to store in full"}, so the quote could not be checked: "${u.text.slice(0, 110)}"`;
    return u.session ? `${ref(u.line, u.session)} points into an earlier handoff, and ${u.why ?? "its record could not be read"}, so neither that line nor the quote could be re-checked here. Not evidence either way: "${u.text.slice(0, 110)}"` : `${ref(u.line)} could not be checked at all, ${u.why ?? NO_RECORD}. Neither the line nor the quote was verified, so this is not evidence either way: "${u.text.slice(0, 110)}"`;
  });
  for (const u of r.unchecked)
    soft.push(`${ref(u.line, u.session)} is a line you really spoke, but the quote "${u.fragment.slice(0, 40)}" is too short to check against it, it is not evidence either way: "${u.text.slice(0, 110)}"`);
  const weak = r.agentWorded.map(
    (a) => `the proof quoted at ${ref(a.line, a.session)} is a label the agent wrote and marked "(Recommended)", you picked it, so this is your assent to its proposal, not a ruling in your own words: "${a.text.slice(0, 110)}"`
  );
  const sessions = [...new Set(r.carried.map((c) => c.session))];
  const carried = sessions.length ? [`${r.carried.length} decision(s) under ${namedBlocks(r.carried.map((c) => c.section))} are carried forward from an earlier session (${sessions.map((s) => `\`${s}\``).join(", ")}) and were re-checked against that session's own record, still cited, not re-litigated.`] : [];
  return { hard: out, soft, weak, carried, unrecorded: r.unrecorded };
}
function carriedLookup(base) {
  return (session) => {
    if (!STAMP_ONLY.test(session)) return null;
    try {
      return parseCitationRecord(readFileSync2(join3(base, session, "citations.json"), "utf8"));
    } catch {
      return null;
    }
  };
}

// src/cli/carry.ts
import { readFileSync as readFileSync3, readdirSync } from "node:fs";
import { join as join4 } from "node:path";
var CARRIED_MARKER = "CARRIED FORWARD";
var CARRIED_BLOCK_OPEN = new RegExp(`<!-- delulu:fill[\u2014,] ${CARRIED_MARKER}`);
var STAMP_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
var SESSION_QUALIFIED = /`(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?:L\d+)`/g;
function carriedCandidates(base, before) {
  let names;
  try {
    names = readdirSync(base);
  } catch {
    return null;
  }
  const prior = names.filter((n) => STAMP_DIR.test(n) && n < before).sort().reverse();
  for (const stamp of prior) {
    let payload;
    try {
      payload = readFileSync3(join4(base, stamp, "payload.md"), "utf8");
    } catch {
      continue;
    }
    if (isIncompletePayload(payload)) continue;
    const raw = decidedEntries(payload).filter((e) => e.text.trim());
    const graded = raw.map((e) => ({
      text: e.text,
      life: classifyRuling(e.text, e.section),
      unenforceable: carryReason(e.text) !== void 0,
      proven: headingRe(SECTION.holds).test(`## ${e.section}`) || new RegExp(SESSION_QUALIFIED.source).test(e.text)
    }));
    const order = ["rules", "unsorted", "session"];
    const lines = order.flatMap((life) => graded.filter((e) => e.life === life).sort((a, b) => Number(b.proven) - Number(a.proven))).map((e) => ({ ...e, text: e.text.replace(/`L(\d+)`/g, (_m, n) => `\`${stamp}:L${n}\``) }));
    if (lines.length) return { stamp, lines };
  }
  return null;
}
function refsIn(text) {
  return [...text.matchAll(SESSION_QUALIFIED)].map((m) => m[1]);
}
function droppedCarried(base, before, payload) {
  const carried = carriedCandidates(base, before);
  if (!carried) return null;
  const kept = new Set(sectionBodies(payload, RULING_SECTIONS).flatMap((b) => refsIn(b.body)));
  const missing = carried.lines.filter((l) => !refsIn(l.text).some((r) => kept.has(r)));
  const held = sectionBodies(payload, [SECTION.holds]).flatMap((b) => b.body.split("\n"));
  return {
    stamp: carried.stamp,
    lost: missing.filter((l) => l.unenforceable),
    routine: missing.filter((l) => !l.unenforceable).length,
    untouched: CARRIED_BLOCK_OPEN.test(payload),
    unjustified: held.filter((l) => /^\s*[-*]\s+\S/.test(l) && carryReason(l) === void 0).map((l) => l.trim())
  };
}
function carryItems(loss, label) {
  const none = { lost: [], routineNote: "", untouchedNote: "", unjustified: [] };
  if (!loss) return none;
  if (loss.untouched)
    return { ...none, untouchedNote: `the carried block from "${label}" is still sitting in this handoff unworked, nothing was promoted out of it, so treat every constraint that session locked as still open.` };
  const unjustified = loss.unjustified.map((l) => `${l.slice(0, 150)}, kept as a standing rule without saying why no check could hold it. Build it in, or add \`, ${CARRY_REASON_MARKER} <why>\`.`);
  const lost = loss.lost.map((l) => `${l.text.slice(0, 150)}, carried out of "${label}", not in this handoff`);
  const note = loss.routine ? `${loss.routine} line(s) carried out of "${label}" were not carried on, that is usually right, since a directive about one task is spent when the task is, and a rule that became a check no longer needs restating, so this is a count rather than a list. They are all still readable in that handoff if one turns out to matter.` : "";
  return { lost, routineNote: note, untouchedNote: "", unjustified };
}

// src/cli/resume.ts
function parseArgs(argv) {
  const a = {};
  const picks = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("-") && arg !== "--repo" && arg !== "--list")
      return { error: `unknown flag \`${arg}\`` };
    if (arg === "--repo") {
      const v = argv[i + 1];
      if (v === void 0 || v === "" || v.startsWith("--")) return { error: "`--repo` needs a value" };
      a.repo = v;
      i++;
    } else if (arg === "--list" || arg === "list") a.list = true;
    else if (!arg.startsWith("--")) picks.push(arg);
  }
  if (picks.length) a.pick = picks.join(" ");
  return a;
}
function listHandoffs(base) {
  if (!existsSync3(base)) return [];
  return readdirSync2(base).filter((f) => {
    try {
      return statSync2(join5(base, f)).isDirectory() && existsSync3(join5(base, f, "payload.md"));
    } catch {
      return false;
    }
  }).sort().reverse().map((ts) => ({ ts, payload: join5(base, ts, "payload.md") }));
}
function isIncomplete(payloadPath) {
  try {
    return isIncompletePayload(readFileSync4(payloadPath, "utf8"));
  } catch {
    return false;
  }
}
function clearStaleNudge(base) {
  const pending = join5(base, "PENDING");
  if (existsSync3(pending)) {
    try {
      unlinkSync(pending);
    } catch {
    }
  }
}
var LIST_CAP = 5;
function listCapped(items, lead, marker) {
  const out = items.slice(0, LIST_CAP).map((t) => `${lead}${marker} ${t}`);
  if (items.length > LIST_CAP)
    out.push(`${lead}_(+${items.length - LIST_CAP} more of the same, every one is in the payload's own DECIDED block)_`);
  return out;
}
function beforeYouTrust({ hard, soft, weak, carried, unrecorded, lost, lostNote, unfilled }) {
  if (!hard.length && !soft.length && !weak.length && !carried.length && !unrecorded.length && !lost.length && !lostNote) return "";
  const out = [];
  if (hard.length) {
    out.push(`  - ${hard.length} line(s) under DECIDED cannot be traced to something you said, the agent's read, not settled:`);
    out.push(...listCapped(hard, "      ", "\u26A0"));
    if (unfilled) out.push(`      (this handoff was never finished, so the above may be delulu's OWN unfilled placeholder text, read as "unfinished", not "fabricated")`);
  }
  if (weak.length) {
    out.push(`  - ${weak.length} decision(s) rest on words the AGENT wrote, not yours, you picked its own recommendation:`);
    out.push(...listCapped(weak, "      ", "\u2248"));
  }
  if (soft.length) {
    out.push(`  - ${soft.length} decision quote(s) could not be checked, not evidence either way:`);
    out.push(...listCapped(soft, "      ", "\u2022"));
  }
  if (lost.length) {
    out.push(`  - ${lost.length} constraint(s) the handoff before this one carried are NOT in this one, and each said no check could hold it:`);
    out.push(...listCapped(lost, "      ", "!"));
    out.push(`      (delulu cannot tell a revocation from a slip. If the user still means these, they are still true, raise them rather than deciding either way on your own.)`);
  }
  if (lostNote) out.push(`  - ${lostNote}`);
  out.push(...listCapped(carried, "  - ", "\u2713"));
  if (unrecorded.length) {
    out.push(`  - part of the check could not RUN on this handoff, it was written by an earlier delulu:`);
    out.push(...listCapped(unrecorded, "      ", "\u25E6"));
  }
  const found = hard.length || soft.length || weak.length;
  const head = found ? "A few of the notes below don't hold up, delulu re-checked them just now:" : "delulu re-checked the notes below just now:";
  return `${head}
${out.join("\n")}
`;
}
function sinceYouLeft(notes) {
  const items = notes.filter((n) => n && n.trim());
  if (!items.length) return "";
  return `Some things moved while you were away. delulu checked the repo just now rather than taking the notes' word for it:
` + items.map((n) => `  - ${n}`).join("\n") + "\n";
}
function stateDrift(repo, body) {
  const m = body.match(/^- Branch `([^`]+)` @ `([^`]+)` · tree ([^\n]*)$/m);
  if (!m) return "";
  const [, wasBranch, wasSha, wasTree] = m;
  const now = (args) => {
    try {
      return execFileSync2("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { env: gitEnv(), encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return void 0;
    }
  };
  const branch = now(["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = now(["rev-parse", "--short", "HEAD"]);
  if (branch === void 0 || sha === void 0) return "";
  const moved = [];
  if (branch !== wasBranch) moved.push(`branch \`${wasBranch}\` -> \`${branch}\``);
  if (sha !== wasSha) moved.push(`commit \`${wasSha}\` -> \`${sha}\``);
  const porcelain = now(["status", "--porcelain"]);
  const wasKnown = wasTree.trim() === "clean" || /uncommitted/.test(wasTree);
  if (porcelain !== void 0 && wasKnown) {
    const wasClean = wasTree.trim() === "clean";
    const ours = (l) => /\.delulu-handoff\//.test(l) || /^\?\?\s+\.gitignore$/.test(l.trim());
    const isClean = porcelain.split("\n").filter((l) => l.trim() && !ours(l)).length === 0;
    if (wasClean !== isClean) moved.push(isClean ? "tree was dirty at capture, is clean now" : "tree was clean at capture, is dirty now");
  }
  const phantom = moved.filter((m2) => m2.includes("(unreadable)"));
  for (const p of phantom) moved.splice(moved.indexOf(p), 1);
  if (!moved.length) return "";
  return `The repo has moved since this was captured: ${moved.join("; ")}. Where the notes below disagree with that, the repo is right.`;
}
function sinceCapture(repo, body) {
  const m = body.match(/^- Branch `[^`]+` @ `([^`]+)` · tree /m);
  if (!m) return "";
  const was = m[1];
  if (!/^[0-9a-f]{7,40}$/.test(was)) return "";
  const git = (args) => {
    try {
      return execFileSync2("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { env: gitEnv(), encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return void 0;
    }
  };
  if (git(["cat-file", "-e", `${was}^{commit}`]) === void 0) return "";
  if (git(["merge-base", "--is-ancestor", was, "HEAD"]) === void 0) {
    return `Captured at \`${was}\`, which is NOT reachable from HEAD, history was rewound or rewritten. Work described below may not exist in this checkout.`;
  }
  const ahead = git(["log", "--oneline", "--no-decorate", `${was}..HEAD`]);
  if (!ahead) return "";
  const lines = ahead.split("\n");
  const shown = lines.slice(0, 3).map((l) => `    ${l}`).join("\n");
  const stat = git(["diff", "--shortstat", `${was}..HEAD`]);
  return `${lines.length} commit${lines.length === 1 ? "" : "s"} landed after it was captured${stat ? ` (${stat})` : ""}, so nothing below knows about ${lines.length === 1 ? "it" : "them"}:
${shown}` + (lines.length > 3 ? `
    +${lines.length - 3} more, \`git log ${was}..HEAD\`` : "");
}
function nextAnchorsMoved(repo, body) {
  const m = body.match(/^- Branch `[^`]+` @ `([^`]+)` · tree /m);
  if (!m || !/^[0-9a-f]{7,40}$/.test(m[1])) return "";
  const was = m[1];
  const start = body.indexOf(`## ${SECTION.next}`);
  if (start < 0) return "";
  const rest = body.slice(start);
  const end = rest.indexOf("\n## ", 1);
  const next = end < 0 ? rest : rest.slice(0, end);
  const named = /* @__PURE__ */ new Set();
  for (const mm of next.matchAll(/`([^`\n]+)`/g)) {
    const raw = mm[1].replace(/:\d+$/, "");
    if (/[/\\]/.test(raw) && /\.[A-Za-z0-9]+$/.test(raw)) named.add(raw);
  }
  if (!named.size) return "";
  let changed;
  try {
    const out = execFileSync2("git", ["-C", repo, "-c", "core.quotePath=false", "diff", "--name-only", "-z", `${was}..HEAD`], { env: gitEnv(), encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] });
    changed = out.split("\0").filter((c) => c !== "");
  } catch {
    return "";
  }
  if (!changed.length) return "";
  const hit = [...named].filter((n) => changed.some((c) => namesSameRepoFile(n, c)));
  if (!hit.length) return "";
  return `${hit.length === 1 ? "A file" : `${hit.length} files`} the plan points at ${hit.length === 1 ? "has" : "have"} changed since this was captured (${hit.map((h) => `\`${h}\``).join(", ")}), so any line numbers in it have drifted \u2014 find the code again before you act on it.`;
}
function splitPayload(body) {
  const cuts = /* @__PURE__ */ new Set([0]);
  for (const m of body.matchAll(/^## [^\n]*$/gm)) if (m.index !== void 0) cuts.add(m.index);
  const fence = body.indexOf(AGENT_ZONE);
  if (fence > 0) cuts.add(fence);
  const closer = body.match(new RegExp(`\\n---\\n${CLOSER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^]*$`));
  if (closer && closer.index !== void 0 && closer.index > 0) cuts.add(closer.index);
  const at = [...cuts].sort((a, b) => a - b);
  return at.map((start, i) => {
    const text = body.slice(start, at[i + 1] ?? body.length);
    const nl = text.indexOf("\n");
    return { name: text.startsWith("## ") ? text.slice(3, nl === -1 ? void 0 : nl) : "", text };
  });
}
function blockName(heading) {
  return sectionOf(heading).replace(/\s*\(.*$/, "").trim();
}
function fitForDelivery(body, budget) {
  let size = deliveryBytes(body);
  if (size <= budget) return { text: body, dropped: [] };
  const pieces = splitPayload(body);
  const gone = /* @__PURE__ */ new Set();
  const dropped = [];
  for (const name of DELIVERY_DROP_ORDER) {
    if (size <= budget) break;
    const heads = headingsFor(name);
    for (let i = 0; i < pieces.length; i++) {
      if (gone.has(i) || !heads.some((h) => pieces[i].text.startsWith(`## ${h}`))) continue;
      gone.add(i);
      dropped.push(blockName(pieces[i].name));
      size -= deliveryBytes(pieces[i].text);
    }
  }
  if (size > budget) return null;
  return { text: pieces.filter((_, i) => !gone.has(i)).map((p) => p.text).join(""), dropped };
}
function trimNotice(ts, dropped, full) {
  return `Heads up, this handoff was too big to send whole, so ${dropped.length} block(s) aren't below: ${dropped.join(", ")}.
  It's ${full.toLocaleString("en-US")} bytes, and anything over about ${BASH_OUTPUT_CLIFF.toLocaleString("en-US")} gets quietly replaced with a short preview, no error, nothing to notice. So delulu chose what to leave out and named it, rather than letting the cut land wherever it fell.
  NOTHING WAS LOST, the whole handoff is on disk. Read \`.delulu-handoff/${ts}/payload.md\` now, before you answer. Read has no size limit; what is printed below is only the part that fitted through one command's output, and the ${dropped.length === 1 ? "block" : "blocks"} named above ${dropped.length === 1 ? "is" : "are"} in that file in full.
`;
}
function undeliverableNotice(ts, full) {
  return `Heads up, the handoff didn't fit in this output at all. Nothing below is it.
  It's ${full.toLocaleString("en-US")} bytes, and even after dropping every optional block it still doesn't fit under the ~${BASH_OUTPUT_CLIFF.toLocaleString("en-US")} byte limit. Printing part of it would look exactly like all of it, which is worse than printing none.
  Read \`.delulu-handoff/${ts}/payload.md\` in full before you answer, Read has no such limit. That file is the handoff; this output isn't.
`;
}
function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stdout.write(`delulu resume, ${parsed.error}. Nothing was loaded.
`);
    process.exitCode = 1;
    return;
  }
  const args = parsed;
  let repo;
  try {
    repo = repoKey(args.repo ?? process.cwd());
  } catch {
    process.stdout.write("delulu resume, not a readable path.\n");
    return;
  }
  const base = join5(repo, ".delulu-handoff");
  const all = listHandoffs(base);
  if (!all.length) {
    clearStaleNudge(base);
    process.stdout.write("delulu resume, no handoffs yet for this project. (run `delulu handoff` at the end of a session to create one.)\n");
    return;
  }
  if (args.list) {
    const now = /* @__PURE__ */ new Date();
    const rows = all.map((h, i) => {
      const when = stampWhen(h.ts, now);
      const stale = when ? `${when.day} \xB7 ${when.age}` : h.ts;
      return {
        lead: i === 0 ? "\u2192" : " ",
        name: handoffLabel(base, h.ts, now),
        // A draft is dated but never aged: "3 days ago" invites resuming it, and there is nothing
        // in it to resume — delulu's own unfilled template is still sitting where THREAD goes.
        meta: isIncomplete(h.payload) ? `${when ? when.day : h.ts} \xB7 draft, never finished` : stale
      };
    });
    const w = Math.max(...rows.map((r) => r.name.length));
    process.stdout.write(`delulu handoffs (${all.length}, newest first), \`delulu resume <name>\` to load any:
`);
    for (const r of rows) process.stdout.write(`  ${r.lead} ${r.name.padEnd(w)}   ${r.meta}
`);
    return;
  }
  const newestDone = all.find((h) => !isIncomplete(h.payload));
  let chosen = newestDone ?? all[0];
  let skippedDrafts = newestDone ? all.indexOf(newestDone) : 0;
  let ambiguous = "";
  if (args.pick) {
    const q = args.pick.toLowerCase();
    const byStamp = all.filter((h) => h.ts.startsWith(args.pick));
    const matches = byStamp.length ? byStamp : all.filter((h) => handoffLabel(base, h.ts, /* @__PURE__ */ new Date()).toLowerCase().includes(q));
    if (!matches.length) {
      process.stdout.write(`delulu resume, no handoff matching "${args.pick}". Try \`delulu resume --list\`.
`);
      process.exitCode = 1;
      return;
    }
    chosen = matches[0];
    skippedDrafts = 0;
    if (matches.length > 1) ambiguous = `(${matches.length} handoffs match "${args.pick}", loaded the newest, from ${stampWhen(chosen.ts, /* @__PURE__ */ new Date())?.day ?? chosen.ts}. Be more specific, or use \`delulu resume --list\` to see them all.)
`;
  }
  const body = readFileSync4(chosen.payload, "utf8");
  if (chosen.ts === all[0].ts) clearStaleNudge(base);
  let citeHard = [];
  let citeSoft = [];
  let citeWeak = [];
  let citeCarried = [];
  let citeUnrecorded = [];
  try {
    let rec = null;
    try {
      rec = parseCitationRecord(readFileSync4(join5(base, chosen.ts, "citations.json"), "utf8"));
    } catch {
      rec = null;
    }
    const held = rec ?? { userLines: [], utterances: {}, truncated: {}, recommended: {} };
    ({ hard: citeHard, soft: citeSoft, weak: citeWeak, carried: citeCarried, unrecorded: citeUnrecorded } = citationItems(
      // The lookup is the whole point of loading in a fresh session: a DECIDED line carried from an
      // OLDER handoff cites that handoff's stamp, and the record it needs is sitting in the same
      // library this resume is reading from. Without it every forwarded constraint scored as a
      // fabrication, which is why they stopped being forwarded at all.
      checkCitations(body, held.userLines, held.utterances, held.truncated, { recommended: held.recommended, carried: carriedLookup(base), absent: held.absent })
    ));
  } catch {
  }
  const asNames = (xs) => xs.map((x) => nameCarriedRefs(x, base, /* @__PURE__ */ new Date()));
  [citeHard, citeSoft, citeWeak, citeCarried] = [citeHard, citeSoft, citeWeak, citeCarried].map(asNames);
  const shown = nameTitle(body, base, /* @__PURE__ */ new Date());
  const problem = payloadProblem(body);
  const unfilled = problem.includes("never filled in");
  const carryLoss = droppedCarried(base, chosen.ts, body);
  const loss = carryItems(carryLoss, carryLoss ? handoffLabel(base, carryLoss.stamp, /* @__PURE__ */ new Date()) : "");
  const driftNote = stateDrift(repo, body);
  const sinceNote = sinceCapture(repo, body);
  const anchorNote = nextAnchorsMoved(repo, body);
  const fallback = all.find((h) => h.ts !== chosen.ts && !isIncomplete(h.payload));
  const problemNote = problem ? `This handoff is INCOMPLETE, ${problem}. Treat anything missing as unknown, not as settled.` + (fallback ? ` Newest complete: ${fallback.ts} (\`delulu resume ${fallback.ts}\`).` : "") : "";
  const ruling = rulingHeadings(body);
  const rulingNames = rulingBlockNames(body);
  const rulesLine = ruling.includes(SECTION.holds) ? ` Then "${SECTION.holds}", before the rest of the notes: standing rules the user locked and has not revoked, which frame everything below them, nothing there expires on its own, and only they retire one.` : "";
  const deepLine = body.includes(`.delulu-handoff/${chosen.ts}/context.md`) ? ` If you need more depth than this, each subagent's full finding is in .delulu-handoff/${chosen.ts}/context.md.` : "";
  const tok = Math.max(0.1, Math.round(body.length / 400) / 10);
  const loadedAt = /* @__PURE__ */ new Date();
  const loadedWhen = stampWhen(chosen.ts, loadedAt);
  const loadedMeta = [loadedWhen?.day, chosen.ts === all[0].ts ? "latest" : ""].filter(Boolean).join(", ");
  const head = `delulu resume, loading "${handoffLabel(base, chosen.ts, loadedAt)}"${loadedMeta ? ` (${loadedMeta})` : ""} \xB7 payload \u2248 ${tok}k tokens.
`;
  const preamble = (skippedDrafts ? `(skipped ${skippedDrafts} newer unfinished draft${skippedDrafts > 1 ? "s" : ""} and loaded the newest finished handoff. \`delulu resume --list\` shows them; name one to load it anyway.)
` : "") + ambiguous + // ONE block, not five loose sentences. Each of these used to print as its own `delulu — ...`
  // line; three were added in a single day and the preamble grew to 2,615 characters of prose the
  // reader has to wade through BEFORE reaching the handoff. They answer one question between
  // them — what is different now from what the notes below describe — so they are one block, and
  // the whole block disappears when the answer is "nothing".
  sinceYouLeft([problemNote, driftNote, sinceNote, anchorNote]) + beforeYouTrust({ hard: citeHard, soft: citeSoft, weak: citeWeak, carried: citeCarried, unrecorded: citeUnrecorded, lost: asNames(loss.lost), lostNote: loss.untouchedNote, unfilled }) + `Start with "${SECTION.said}", those are their own messages, word for word and in order, and reading them is what makes this a continuation instead of a briefing.${rulesLine} Then "${SECTION.thread}", "${SECTION.state}" and "${SECTION.next}". Open by carrying the conversation on in your own voice rather than reciting these blocks back at them, and put your first question to them with AskUserQuestion, your recommendation first, never end on a bare question or a flat stop. On what to trust: delulu read "${SECTION.state}" and "${SECTION.said}" itself. Every line under ${namedBlocks(rulingNames)} is only as good as the citation on it, and "${SECTION.read}" was never checked at all.${deepLine}

`;
  const full = deliveryBytes(shown);
  const fixed = deliveryBytes(head) + deliveryBytes(preamble);
  const NOTICE_RESERVE = 900;
  let notice = "";
  let delivered = shown;
  if (fixed + full > SAFE_DELIVERY_BYTES) {
    const fit = fitForDelivery(shown, SAFE_DELIVERY_BYTES - fixed - NOTICE_RESERVE);
    if (fit && fit.dropped.length) {
      notice = trimNotice(chosen.ts, fit.dropped, full);
      delivered = fit.text;
    }
    if (!notice || fixed + deliveryBytes(notice) + deliveryBytes(delivered) > SAFE_DELIVERY_BYTES) {
      notice = undeliverableNotice(chosen.ts, full);
      delivered = "";
      process.exitCode = 1;
    }
  }
  process.stdout.write(head + notice + preamble + delivered);
}
try {
  if (isProgram(import.meta.url)) main();
} catch (e) {
  process.stdout.write(`delulu resume, could not load the handoff: ${e instanceof Error ? e.message : "unknown"}
`);
  process.exitCode = 1;
}
