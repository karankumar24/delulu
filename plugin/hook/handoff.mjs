// src/cli/handoff.ts
import { existsSync as existsSync3, mkdirSync, writeFileSync as writeFileSync2, readFileSync as readFileSync5, readdirSync as readdirSync3, realpathSync as realpathSync3, statSync as statSync3, rmSync } from "node:fs";
import { basename as basename2, join as join6, resolve } from "node:path";
import { homedir as homedir3 } from "node:os";
import { execFileSync as execFileSync2 } from "node:child_process";

// src/engine/tail.ts
import { readFileSync } from "node:fs";
function assistantContent(rec) {
  if (!rec || typeof rec !== "object") return null;
  const r = rec;
  const msg = r.message;
  if (msg && typeof msg === "object") {
    const m = msg;
    if ((m.role === "assistant" || r.type === "assistant") && Array.isArray(m.content)) {
      return m.content;
    }
  }
  if ((r.role === "assistant" || r.type === "assistant") && Array.isArray(r.content)) {
    return r.content;
  }
  return null;
}
function anyContent(rec) {
  if (!rec || typeof rec !== "object") return null;
  const r = rec;
  const msg = r.message;
  if (msg && typeof msg === "object" && Array.isArray(msg.content)) {
    return msg.content;
  }
  if (Array.isArray(r.content)) return r.content;
  return null;
}
function blocksToEvents(content, line, cwd) {
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      if (typeof block === "string" && block.trim()) {
        out.push({ kind: "text", line, text: block });
      }
      continue;
    }
    const b = block;
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ kind: "text", line, text: b.text });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      out.push({
        kind: "tool",
        line,
        toolName: b.name,
        toolInput: b.input && typeof b.input === "object" ? b.input : {},
        toolUseId: typeof b.id === "string" ? b.id : void 0,
        cwd
      });
    }
  }
  return out;
}
function recordCwd(rec) {
  if (!rec || typeof rec !== "object") return void 0;
  const c = rec.cwd;
  return typeof c === "string" && c ? c : void 0;
}
function isSidechain(rec) {
  return !!rec && typeof rec === "object" && rec.isSidechain === true;
}
function userTurnEvent(rec, line) {
  if (!rec || typeof rec !== "object") return null;
  const r = rec;
  if (r.isMeta === true) return null;
  const msg = r.message;
  const role = msg && typeof msg === "object" ? msg.role : void 0;
  if (r.type !== "user" && role !== "user") return null;
  const content = msg && typeof msg === "object" ? msg.content : r.content;
  if (typeof content === "string")
    return content.trim() ? { kind: "user", line, text: content } : null;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text);
  }
  return parts.length ? { kind: "user", line, text: parts.join("\n\n"), parts } : null;
}
function queuedUserEvent(rec, line) {
  if (!rec || typeof rec !== "object") return null;
  const r = rec;
  if (r.type !== "attachment") return null;
  const att = r.attachment;
  if (!att || typeof att !== "object") return null;
  const a = att;
  if (a.type !== "queued_command" || typeof a.prompt !== "string") return null;
  const text = a.prompt.trim();
  if (!text) return null;
  const origin = a.origin;
  const originKind = origin && typeof origin === "object" ? origin.kind : void 0;
  if (typeof originKind === "string") {
    return originKind === "human" ? { kind: "user", line, text: a.prompt } : null;
  }
  return HARNESS_QUEUED.test(text) ? null : { kind: "user", line, text: a.prompt };
}
var HARNESS_QUEUED = /^<(?:task-notification|system-reminder|local-command|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|tool|output)\b/i;
function normText(t) {
  return (t ?? "").replace(/\s+/g, " ").trim();
}
var TWIN_WINDOW = 40;
function mergeQueued(events, queued) {
  if (!queued.length) return events;
  const seen = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.kind !== "user" && e.kind !== "user-meta") continue;
    const k = normText(e.text);
    if (k) (seen.get(k) ?? seen.set(k, []).get(k)).push(e.line);
  }
  const near = (k, line) => (seen.get(k) ?? []).some((l) => Math.abs(l - line) <= TWIN_WINDOW);
  const add = [];
  for (const q of queued) {
    const key = normText(q.text);
    if (!key || near(key, q.line)) continue;
    (seen.get(key) ?? seen.set(key, []).get(key)).push(q.line);
    add.push(q);
  }
  if (!add.length) return events;
  return [...events, ...add].sort((x, y) => x.line - y.line);
}
function toolResultEvents(content, line) {
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block;
    if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const failed2 = b.is_error === true;
      out.push({
        kind: "tool-result",
        line,
        toolUseId: b.tool_use_id,
        ok: !failed2,
        // The failure TEXT, kept only for failures. This is the literal error the agent hit —
        // the raw material for a "what failed / don't repeat" section that is extracted rather
        // than remembered. Successes carry no text: nobody needs to re-read them, and they are
        // the bulk of the bytes.
        ...failed2 ? { text: toolResultText(b.content).slice(0, 800) } : {}
      });
    }
  }
  return out;
}
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(
    (b) => b && typeof b === "object" && typeof b.text === "string" ? b.text : ""
  ).join(" ").trim();
}
function askConsentEvents(rec, line, askIds) {
  if (!rec || typeof rec !== "object") return [];
  const ac = assistantContent(rec);
  if (ac) {
    for (const b of ac) {
      if (b && typeof b === "object") {
        const bb = b;
        if (bb.type === "tool_use" && bb.name === "AskUserQuestion" && typeof bb.id === "string")
          askIds.add(bb.id);
      }
    }
  }
  if (askIds.size === 0) return [];
  const content = anyContent(rec);
  if (!content) return [];
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const bb = b;
    if (bb.type !== "tool_result" || typeof bb.tool_use_id !== "string" || !askIds.has(bb.tool_use_id))
      continue;
    const text = toolResultText(bb.content);
    if (text) out.push({ kind: "user-meta", line, text });
  }
  return out;
}
function parseSessionLog(logPath, opts) {
  const keepSidechain = opts?.includeSidechain === true;
  const raw = readFileSync(logPath, "utf8");
  const events = [];
  const queued = [];
  const askIds = /* @__PURE__ */ new Set();
  const unreadable = [];
  const lines = raw.split("\n");
  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const text = rawLine.trim();
    if (!text) return;
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      unreadable.push(line);
      return;
    }
    if (!keepSidechain && isSidechain(rec)) return;
    const content = assistantContent(rec);
    if (content) events.push(...blocksToEvents(content, line, recordCwd(rec)));
    const ac = anyContent(rec);
    if (ac) events.push(...toolResultEvents(ac, line));
    const u = userTurnEvent(rec, line);
    if (u) events.push(u);
    const q = queuedUserEvent(rec, line);
    if (q) queued.push(q);
    events.push(...askConsentEvents(rec, line, askIds));
  });
  return { events: mergeQueued(events, queued), unreadable };
}

// src/engine/files.ts
import { homedir } from "node:os";

// src/engine/path-shape.ts
import { win32, posix } from "node:path";
var LONG_PREFIX = /^\\\\[?.]\\(UNC\\)?/i;
function stripLongPrefix(p) {
  const m = LONG_PREFIX.exec(p);
  if (!m) return p;
  return m[1] ? `\\\\${p.slice(m[0].length)}` : p.slice(m[0].length);
}
function pathStyleOf(p) {
  if (!p) return void 0;
  if (/^\\\\/.test(p)) return "win32";
  if (/^[A-Za-z]:/.test(p)) return "win32";
  if (p.startsWith("/")) return "posix";
  return void 0;
}
function pathStyle(...candidates) {
  for (const c of candidates) {
    const s = c === void 0 ? void 0 : pathStyleOf(c);
    if (s) return s;
  }
  return "posix";
}
var impl = (style) => style === "win32" ? win32 : posix;
function segmentsIn(p, style) {
  return style === "win32" ? stripLongPrefix(p).split(/[\\/]/) : p.split("/");
}
function baseNameOf(p) {
  return segmentsIn(p, pathStyle(p)).pop() ?? "";
}
function tailSegments(p, count) {
  return segmentsIn(p, pathStyle(p)).slice(-count).join("/");
}
function absolutePath(raw, cwd, home) {
  if (!raw) return void 0;
  const style = pathStyle(cwd, raw, home);
  const n = impl(style);
  if (home) {
    const tilde = raw.startsWith("~/") || style === "win32" && raw.startsWith("~\\");
    if (tilde) return n.normalize(n.join(stripLongPrefix(home), raw.slice(2)));
  }
  const p = stripLongPrefix(raw);
  if (n.isAbsolute(p)) return n.normalize(p);
  if (cwd) return n.resolve(stripLongPrefix(cwd), p);
  return void 0;
}
var fold = (s, style) => style === "win32" ? s.toLowerCase() : s;
function sameFileKey(p) {
  const style = pathStyle(p);
  return fold(impl(style).normalize(stripLongPrefix(p)), style);
}
function relativeUnder(root, p) {
  if (!root || !p) return void 0;
  const style = pathStyle(root, p);
  const n = impl(style);
  const rp = stripLongPrefix(p);
  if (!n.isAbsolute(rp)) return void 0;
  const pp = n.normalize(rp);
  const rr = n.normalize(stripLongPrefix(root));
  if (fold(pp, style) === fold(rr, style)) return "";
  const prefix = rr.endsWith(n.sep) ? rr : rr + n.sep;
  if (pp.length <= prefix.length) return void 0;
  if (fold(pp.slice(0, prefix.length), style) !== fold(prefix, style)) return void 0;
  return toDisplaySeparators(pp.slice(prefix.length), style);
}
function toDisplaySeparators(rel, style) {
  return style === "win32" ? rel.replace(/\\/g, "/") : rel;
}
function hasSegment(rel, name) {
  return rel.split("/").includes(name);
}

// src/engine/files.ts
var MUTATING_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "multiedit", "notebookedit", "editnotebook"]);
var EDITOR_TOOLS = /* @__PURE__ */ new Set(["str_replace_editor", "str_replace_based_edit_tool"]);
var EDITOR_WRITES = /* @__PURE__ */ new Set(["create", "str_replace", "insert", "undo_edit"]);
var MCP_MUTATING = /(?:^|__)(?:write|edit|create)_(?:file|notebook)$/i;
function isMutatingTool(name) {
  const n = name.toLowerCase();
  return MUTATING_TOOLS.has(n) || MCP_MUTATING.test(n);
}
function isMutatingCall(name, input) {
  if (isMutatingTool(name)) return true;
  return EDITOR_TOOLS.has(name.toLowerCase()) && typeof input.command === "string" && EDITOR_WRITES.has(input.command);
}
function mutatingToolPath(input) {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  if (typeof input.target_notebook === "string") return input.target_notebook;
  if (typeof input.notebook_path === "string") return input.notebook_path;
  return void 0;
}
function mutatedFiles(session) {
  const outcome = /* @__PURE__ */ new Map();
  for (const ev of session.events) {
    if (ev.kind === "tool-result" && ev.toolUseId) outcome.set(ev.toolUseId, ev.ok !== false);
  }
  const seen = /* @__PURE__ */ new Map();
  for (const ev of session.events) {
    if (ev.kind !== "tool") continue;
    if (!isMutatingCall(ev.toolName ?? "", ev.toolInput ?? {})) continue;
    if (ev.toolUseId && outcome.get(ev.toolUseId) === false) continue;
    const p = mutatingToolPath(ev.toolInput ?? {});
    if (!p) continue;
    const abs = absolutePath(p, ev.cwd, homedir()) ?? p;
    const key = sameFileKey(abs);
    if (!seen.has(key)) seen.set(key, abs);
  }
  return [...seen.values()];
}

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
var unworktree = (rel) => rel.replace(/^\.claude\/worktrees\/[^/]+\//, "");
function repoRelativeFiles(roots, files) {
  const out = [];
  for (const f of files) {
    let rel;
    for (const root of roots) {
      const r = relativeUnder(root, f);
      if (r) {
        rel = r;
        break;
      }
    }
    if (rel === void 0 || hasSegment(rel, ".delulu-handoff")) continue;
    const s = unworktree(rel);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// src/cli/resolve-log.ts
import { readdirSync, statSync as statSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function claudeHome() {
  const v = process.env.CLAUDE_CONFIG_DIR?.trim();
  return v ? v : join2(homedir2(), ".claude");
}
function projectsDir() {
  return join2(claudeHome(), "projects");
}
function projectSlugs(repo) {
  const nfc = repo.normalize("NFC");
  const strict = truncateSlug(nfc.replace(/[^a-zA-Z0-9]/g, "-"), nfc);
  const legacy = truncateSlug(nfc.replace(/\//g, "-"), nfc);
  const raw = repo.replace(/[^a-zA-Z0-9]/g, "-");
  return [.../* @__PURE__ */ new Set([strict, legacy, raw])];
}
var SLUG_MAX = 200;
function truncateSlug(slug, original) {
  if (slug.length <= SLUG_MAX) return slug;
  let h = 0;
  for (let i = 0; i < original.length; i++) h = Math.imul(31, h) + original.charCodeAt(i) | 0;
  return `${slug.slice(0, SLUG_MAX)}-${Math.abs(h).toString(36)}`;
}
function resolveLog(repo, cwdHint) {
  const byId = resolveBySessionId();
  if (byId) return byId;
  const candidates = [
    ...cwdHint ? projectSlugs(cwdHint) : [],
    ...projectSlugs(repo)
  ].filter((v, i, a) => a.indexOf(v) === i);
  for (const slug of candidates) {
    const dir = join2(projectsDir(), slug);
    let names;
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const entries = [];
    for (const f of names) {
      try {
        entries.push({ p: join2(dir, f), mtime: statSync2(join2(dir, f)).mtimeMs });
      } catch {
      }
    }
    if (entries.length) return entries.sort((x, y) => y.mtime - x.mtime)[0].p;
  }
  return null;
}
function resolveBySessionId() {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (!id || !/^[A-Za-z0-9-]{8,}$/.test(id)) return null;
  const base = projectsDir();
  let dirs;
  try {
    dirs = readdirSync(base);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join2(base, d, `${id}.jsonl`);
    try {
      if (statSync2(p).isFile()) return p;
    } catch {
    }
  }
  return null;
}

// src/cli/handoff-name.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { join as join3 } from "node:path";
var STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/;
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var NAME_CAP = 48;
function stampWhen(stamp2, now) {
  const m = STAMP.exec(stamp2);
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
    return cleanName(readFileSync2(join3(base, ts, "name.txt"), "utf8"));
  } catch {
    return null;
  }
}
function writeName(base, ts, raw) {
  const name = cleanName(raw);
  if (!name) return null;
  try {
    writeFileSync(join3(base, ts, "name.txt"), `${name}
`, { mode: 384 });
  } catch {
    return null;
  }
  return name;
}
function handoffLabel(base, ts, now) {
  const name = readName(base, ts);
  if (name) return name;
  const when = stampWhen(ts, now);
  return when ? `${when.day} handoff` : ts;
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

// src/cli/citations.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";

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
function overShare(payload) {
  const canonical = /* @__PURE__ */ new Map();
  for (const name of Object.keys(BLOCK_SHARES))
    for (const alias of headingsFor(name)) canonical.set(alias, name);
  const out = [];
  for (const { name, head, body } of sectionBodies(payload, [...canonical.keys()])) {
    const key = canonical.get(name);
    if (key === void 0) continue;
    const bytes = deliveryBytes(head + body);
    const share = BLOCK_SHARES[key];
    if (bytes > share) out.push({ name: key, bytes, share });
  }
  return out.sort((a, b) => b.bytes - b.share - (a.bytes - a.share));
}
var SHARE_NOISE_FLOOR = 150;
function shareReport(payload) {
  if (deliveryBytes(payload) <= SAFE_PAYLOAD_BYTES) return [];
  return overShare(payload).filter((o) => o.bytes - o.share >= SHARE_NOISE_FLOOR);
}
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
var CANNOT_BE_A_CHECK = /—\s*cannot be a check:\s*(\S.*?)\s*$/;
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
  if (!text.includes(AGENT_ZONE)) return "the payload stops before the agent-written sections \u2014 it looks truncated";
  if (text.includes("<!-- delulu:fill")) return "some sections were never filled in";
  if (!text.includes(CLOSER)) return "the payload has no closing line, so it is cut short \u2014 the sections after the cut are missing, not empty";
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
  recommended: "whose words a decision is in \u2014 yours, or a label the agent wrote and marked for you \u2014 was never recorded"
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
var CARRIED_REF = new RegExp(`(?<![A-Za-z0-9])(${SESSION_STAMP}):L(\\d+)(?![A-Za-z0-9])`, "g");
var STAMP_ONLY = new RegExp(`^${SESSION_STAMP}$`);
var REF_SPAN = new RegExp(`^\`(?:${SESSION_STAMP}:)?L\\d+\`$`);
function refScan(text) {
  const spans = text.replace(/`[^`]*`/g, (span) => REF_SPAN.test(span) ? span : " ".repeat(span.length));
  const quotable = text.replace(/`[^`]*`/g, (span) => span.includes('"') ? " ".repeat(span.length) : span);
  const carried = [];
  const scan = spans.replace(CARRIED_REF, (m, session, n, at) => {
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
  return `the record for the handoff it cites (\`${missing.join("`, `")}\`) could not be read \u2014 pruned, or captured elsewhere`;
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
    out.push(`quotes words the user did not say at ${ref(m.line, m.session)} \u2014 quoted: "${m.fragment.slice(0, 90)}": "${m.text.slice(0, 110)}"`);
  for (const u of r.uncited)
    out.push(`no citation \u2014 this is the agent's conclusion, not the user's ruling: "${u.text.slice(0, 110)}"`);
  const soft = r.unverifiable.map((u) => {
    if (!u.unresolved)
      return `${ref(u.line, u.session)} is a line you really spoke, but ${u.why ?? "that message was too long to store in full"}, so the quote could not be checked: "${u.text.slice(0, 110)}"`;
    return u.session ? `${ref(u.line, u.session)} points into an earlier handoff, and ${u.why ?? "its record could not be read"} \u2014 so neither that line nor the quote could be re-checked here. Not evidence either way: "${u.text.slice(0, 110)}"` : `${ref(u.line)} could not be checked at all \u2014 ${u.why ?? NO_RECORD}. Neither the line nor the quote was verified, so this is not evidence either way: "${u.text.slice(0, 110)}"`;
  });
  for (const u of r.unchecked)
    soft.push(`${ref(u.line, u.session)} is a line you really spoke, but the quote "${u.fragment.slice(0, 40)}" is too short to check against it \u2014 it is not evidence either way: "${u.text.slice(0, 110)}"`);
  const weak = r.agentWorded.map(
    (a) => `the proof quoted at ${ref(a.line, a.session)} is a label the agent wrote and marked "(Recommended)" \u2014 you picked it, so this is your assent to its proposal, not a ruling in your own words: "${a.text.slice(0, 110)}"`
  );
  const sessions = [...new Set(r.carried.map((c) => c.session))];
  const carried = sessions.length ? [`${r.carried.length} decision(s) under ${namedBlocks(r.carried.map((c) => c.section))} are carried forward from an earlier session (${sessions.map((s) => `\`${s}\``).join(", ")}) and were re-checked against that session's own record \u2014 still cited, not re-litigated.`] : [];
  return { hard: out, soft, weak, carried, unrecorded: r.unrecorded };
}
function citationNotice(r) {
  const { hard: items, soft, weak, carried, unrecorded } = citationItems(r);
  const hard = items.length ? `delulu \u2014 ${items.length} line(s) under ${namedBlocks([...r.bad, ...r.misquoted, ...r.uncited].map((f) => f.section))} cannot be traced to something the user said. Treat them as the agent's read, not as settled \u2014 your call:
${items.map((i) => `  \u26A0 ${i}`).join("\n")}
` : "";
  const worded = weak.length ? `delulu \u2014 ${weak.length} decision(s) under ${namedBlocks(r.agentWorded.map((a) => a.section))} rest on words the agent wrote, not the user's:
${weak.map((i) => `  \u2248 ${i}`).join("\n")}
` : "";
  const note = soft.length ? `delulu \u2014 ${soft.length} decision quote(s) could not be checked:
${soft.map((i) => `  \u2022 ${i}`).join("\n")}
` : "";
  const forward = carried.length ? `delulu \u2014 ${carried.join("\n")}
` : "";
  const unrun = unrecorded.length ? `delulu \u2014 this handoff was written by an earlier delulu, so part of the check could not run:
${unrecorded.map((u) => `  \u25E6 ${u}`).join("\n")}
` : "";
  return hard + worded + note + forward + unrun;
}
function carriedLookup(base) {
  return (session) => {
    if (!STAMP_ONLY.test(session)) return null;
    try {
      return parseCitationRecord(readFileSync3(join4(base, session, "citations.json"), "utf8"));
    } catch {
      return null;
    }
  };
}

// src/cli/carry.ts
import { readFileSync as readFileSync4, readdirSync as readdirSync2 } from "node:fs";
import { join as join5 } from "node:path";
var CARRIED_CAP = 30;
var CARRIED_MARKER = "CARRIED FORWARD";
var CARRIED_BLOCK_OPEN = `<!-- delulu:fill \u2014 ${CARRIED_MARKER}`;
var STAMP_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
var SESSION_QUALIFIED = /`(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?:L\d+)`/g;
function carriedCandidates(base, before) {
  let names;
  try {
    names = readdirSync2(base);
  } catch {
    return null;
  }
  const prior = names.filter((n) => STAMP_DIR.test(n) && n < before).sort().reverse();
  for (const stamp2 of prior) {
    let payload;
    try {
      payload = readFileSync4(join5(base, stamp2, "payload.md"), "utf8");
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
    const lines = order.flatMap((life) => graded.filter((e) => e.life === life).sort((a, b) => Number(b.proven) - Number(a.proven))).map((e) => ({ ...e, text: e.text.replace(/`L(\d+)`/g, (_m, n) => `\`${stamp2}:L${n}\``) }));
    if (lines.length) return { stamp: stamp2, lines };
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
    untouched: payload.includes(CARRIED_BLOCK_OPEN),
    unjustified: held.filter((l) => /^\s*[-*]\s+\S/.test(l) && carryReason(l) === void 0).map((l) => l.trim())
  };
}
function carryItems(loss, label) {
  const none = { lost: [], routineNote: "", untouchedNote: "", unjustified: [] };
  if (!loss) return none;
  if (loss.untouched)
    return { ...none, untouchedNote: `the carried block from "${label}" is still sitting in this handoff unworked \u2014 nothing was promoted out of it, so treat every constraint that session locked as still open.` };
  const unjustified = loss.unjustified.map((l) => `${l.slice(0, 150)} \u2014 kept as a standing rule without saying why no check could hold it. Build it in, or add \`\u2014 ${CARRY_REASON_MARKER} <why>\`.`);
  const lost = loss.lost.map((l) => `${l.text.slice(0, 150)} \u2014 carried out of "${label}", not in this handoff`);
  const note = loss.routine ? `${loss.routine} line(s) carried out of "${label}" were not carried on \u2014 that is usually right, since a directive about one task is spent when the task is, and a rule that became a check no longer needs restating, so this is a count rather than a list. They are all still readable in that handoff if one turns out to matter.` : "";
  return { lost, routineNote: note, untouchedNote: "", unjustified };
}

// src/cli/handoff.ts
function parseArgs(argv) {
  const a = {};
  const value = (i, flag) => {
    const v = argv[i + 1];
    return v === void 0 || v === "" || v.startsWith("--") ? { error: `\`${flag}\` needs a value` } : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const KNOWN = ["--repo", "--log", "--restate", "--name"];
    if (flag === "-h" || flag === "--help") return { help: true };
    if (flag.startsWith("-") && !KNOWN.includes(flag)) return { error: `unknown flag \`${flag}\`` };
    if (!KNOWN.includes(flag)) continue;
    const v = value(i, flag);
    if (typeof v !== "string") return v;
    if (flag === "--repo") a.repo = v;
    else if (flag === "--log") a.log = v;
    else if (flag === "--name") a.name = v;
    else a.restate = v;
    i++;
  }
  return a;
}
function git(repo, args) {
  try {
    return execFileSync2("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { env: gitEnv(), encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return void 0;
  }
}
function stamp() {
  const d = /* @__PURE__ */ new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}
function buildState(log, repo, pointers) {
  const lines = [];
  const branchRaw = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const shaRaw = git(repo, ["rev-parse", "--short", "HEAD"]);
  const branch = branchRaw === void 0 ? "(unreadable)" : branchRaw || "(no branch)";
  const sha = shaRaw === void 0 ? "(unreadable)" : shaRaw || "(no commit)";
  const porcelain = git(repo, ["status", "--porcelain", "--untracked-files=normal"]);
  const tree = porcelain === void 0 ? "**unknown \u2014 `git status` could not be read here, so do NOT assume it is clean**" : porcelain ? `**${porcelain.split("\n").filter(Boolean).length} uncommitted entr${porcelain.split("\n").filter(Boolean).length === 1 ? "y" : "ies"}**` : "clean";
  lines.push(`- Branch \`${branch}\` @ \`${sha}\` \xB7 tree ${tree}`);
  try {
    const own = mutatedFiles(parseSessionLog(log));
    const viaSubagents = pointers.flatMap((p) => {
      try {
        return mutatedFiles(parseSessionLog(p, { includeSidechain: true }));
      } catch {
        return [];
      }
    });
    const prefixes = [repo, repo.replace(/^\/private/, ""), `/private${repo}`].filter(
      (v, i, a) => v && a.indexOf(v) === i
    );
    const ownRepo = repoRelativeFiles(prefixes, own);
    const subRepo = repoRelativeFiles(prefixes, viaSubagents).filter((f) => !ownRepo.includes(f));
    const files = [...ownRepo, ...subRepo];
    if (files.length) {
      const note = subRepo.length ? ` \xB7 ${subRepo.length} via subagent(s)` : "";
      lines.push(
        `- Files touched via Write/Edit (${files.length}${note}; files written by shell commands are NOT counted here \u2014 see the diff below): ${files.slice(0, 12).map((f) => `\`${clipPath(f, PATH_CAP)}\``).join(", ")}${files.length > 12 ? ` \u2026 +${files.length - 12} more` : ""}`
      );
    }
  } catch {
  }
  const numstat = git(repo, ["diff", "--numstat", "-z", "HEAD"]);
  if (numstat) {
    const rows = [];
    let added = 0, removed = 0, files = 0;
    const recs = numstat.split("\0");
    for (let i = 0; i < recs.length; i++) {
      const m = recs[i].match(/^(\d+|-)\t(\d+|-)\t([^]*)$/);
      if (!m) continue;
      const [a, d] = [m[1], m[2]];
      let path = m[3];
      if (!path) {
        path = recs[i + 2] ?? recs[i + 1] ?? "";
        i += 2;
      }
      if (!path) continue;
      files++;
      const shown = clipPath(path, PATH_CAP);
      if (a === "-" || d === "-") {
        rows.push(` ${shown} | bin`);
        continue;
      }
      added += Number(a);
      removed += Number(d);
      rows.push(` ${shown} | +${a} -${d}`);
    }
    if (rows.length) {
      const listed = rows.slice(0, 20);
      const rest = rows.length - listed.length;
      if (rest > 0) listed.push(` \u2026 ${rest} more file${rest === 1 ? "" : "s"}`);
      listed.push(` ${files} file${files === 1 ? "" : "s"} changed, +${added} -${removed}`);
      lines.push("\n```\n" + listed.join("\n") + "\n```");
    }
  }
  return lines.join("\n");
}
function sessionFootprint(log, pointers) {
  try {
    const mainBytes = statSync3(log).size;
    const subBytes = pointers.reduce((s, p) => {
      try {
        return s + statSync3(p).size;
      } catch {
        return s;
      }
    }, 0);
    const total = mainBytes + subBytes;
    if (!total) return "";
    const fmt = total >= 1e6 ? `${(total / 1e6).toFixed(1)}MB` : `${Math.round(total / 1e3)}KB`;
    const subNote = pointers.length ? ` + ${pointers.length} subagent transcript(s)` : "";
    return `- Full session \u2248 **${fmt}** (this conversation${subNote}). This handoff carries the engine-verified blocks here + a compressed, *unverified* agent summary \u2014 a fraction of the full transcript. For the literal transcript, run \`claude --resume\`.`;
  } catch {
    return "";
  }
}
var KNOWN_WRAPPERS = /^\s*<(task-notification|command-message|command-name|command-args|local-command-stdout|local-command-stderr|create-pr-command|system-reminder|preview-annotation-context|observed_from_primary_session|tool_use_error|tool_result|output)\b/i;
function unwrapUserProse(t) {
  let rest = t;
  for (; ; ) {
    if (!KNOWN_WRAPPERS.test(rest)) break;
    const open = rest.match(/^\s*<([a-z0-9_-]+)([^>]*)>/i);
    if (!open) break;
    if (open[2].trimEnd().endsWith("/")) {
      rest = rest.slice(open[0].length);
      continue;
    }
    const end = closingIndex(rest, open[1], open[0].length);
    if (end === -1) break;
    rest = rest.slice(end);
  }
  rest = rest.trim();
  if (!rest) return "";
  if (/^<\/?observ(?:ation|ed_from)/i.test(rest) || /<\/observ(?:ation|ed_from\w*)\s*>/i.test(rest)) return "";
  return rest;
}
function closingIndex(s, tag, from) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[1]) {
      if (--depth === 0) return m.index + m[0].length;
    } else if (!m[0].trimEnd().endsWith("/>")) depth++;
  }
  return -1;
}
function commandArgsProse(t) {
  const m = t.match(/<command-args>([\s\S]*?)<\/command-args>/i);
  const body = (m?.[1] ?? "").trim();
  if (!body) return "";
  const name = t.match(/<command-name>\s*([^<\s]+)/i)?.[1] ?? "";
  return name ? `${name} ${body}` : body;
}
var CC_BANNER = /[▐▛▜▝█]{2,}|Claude\s+Code\s+v\d/;
function isBoilerplateOpener(t) {
  return /\bHANDOFF\.md\b/i.test(t) || /\bread\s+(the\s+)?handoff\b/i.test(t) || /\binterview\s+me\b/i.test(t) || /\bdelulu\s+resume\b/i.test(t);
}
function askAnswerList(metaText) {
  const pairs = [...metaText.matchAll(/"([^"]+)"\s*=\s*"([\s\S]*?)"(?=\s*(?:,\s*"|\.|$|\s+selected preview:))/g)].map((m) => ({ question: m[1].trim(), answer: m[2].trim() })).filter((p) => p.answer);
  if (pairs.length) return pairs;
  if (!/"\s*=\s*"/.test(metaText)) return [];
  return [...metaText.matchAll(/"([^"]+)"\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => ({ question: m[1].trim(), answer: m[2].trim() })).filter((p) => p.answer);
}
var SYNTHETIC_ANSWER = /^\[(?:User (?:dismissed|rejected)|No preference|Request interrupted)/i;
var RECOMMENDED_LABEL = /\(recommended\)/i;
function offeredLabels(session) {
  const labels = /* @__PURE__ */ new Set();
  for (const ev of session.events) {
    if (ev.kind !== "tool" || ev.toolName !== "AskUserQuestion") continue;
    const qs = ev.toolInput?.questions;
    if (!Array.isArray(qs)) continue;
    for (const q of qs) {
      const opts = q?.options;
      if (!Array.isArray(opts)) continue;
      for (const o of opts) {
        const l = o?.label;
        if (typeof l === "string" && l.trim()) labels.add(l.trim());
      }
    }
  }
  return labels;
}
function userUtterances(session) {
  const out = [];
  const labels = offeredLabels(session);
  let dropped = 0;
  let prose = 0;
  let openerSkipped = 0;
  let seenUserTurn = false;
  for (const ev of session.events) {
    if (!ev.text) continue;
    if (ev.kind === "user") {
      const t = ev.text.trim();
      const isFirst = !seenUserTurn;
      seenUserTurn = true;
      if (!t || CC_BANNER.test(t)) {
        dropped++;
        continue;
      }
      const blocks = ev.parts && ev.parts.length > 1 ? ev.parts : [t];
      if (blocks.some((b) => KNOWN_WRAPPERS.test(b.trim()))) {
        const kept = [];
        for (const raw of blocks) {
          const b = raw.trim();
          if (!b) continue;
          if (!KNOWN_WRAPPERS.test(b)) {
            kept.push(b);
            continue;
          }
          const inner = commandArgsProse(b) || unwrapUserProse(b);
          if (inner) kept.push(inner);
        }
        if (!kept.length) {
          dropped++;
          continue;
        }
        prose++;
        out.push({ line: ev.line, text: kept.join("\n\n"), kind: "typed" });
        continue;
      }
      if (SYNTHETIC_ANSWER.test(t)) {
        out.push({ line: ev.line, text: t, kind: "interrupt" });
        continue;
      }
      prose++;
      if (isFirst && isBoilerplateOpener(t)) {
        openerSkipped++;
        continue;
      }
      out.push({ line: ev.line, text: t, kind: "typed" });
    } else if (ev.kind === "user-meta") {
      for (const { question, answer } of askAnswerList(ev.text)) {
        if (SYNTHETIC_ANSWER.test(answer)) {
          dropped++;
          continue;
        }
        const kind = labels.has(answer) ? "answer" : classifyAnswer(answer, labels);
        out.push({ line: ev.line, text: answer, question, kind });
      }
    }
  }
  return { kept: out, dropped, prose, openerSkipped };
}
function classifyAnswer(answer, labels) {
  const sorted = [...labels].filter(Boolean).sort((a, b) => b.length - a.length);
  const boundary = (s, at, len) => !/[A-Za-z0-9]/.test(s[at - 1] ?? " ") && !/[A-Za-z0-9]/.test(s[at + len] ?? " ");
  let rest = answer;
  let matched = 0;
  for (let guard = 0; guard < 64; guard++) {
    const hit = sorted.find((l) => {
      const at = rest.indexOf(l);
      return at !== -1 && boundary(rest, at, l.length);
    });
    if (!hit) break;
    rest = rest.replace(hit, " ");
    matched++;
  }
  const residue = rest.replace(/[,;\s]+/g, "");
  if (matched && !residue) return "answer";
  return matched ? "mixed" : "custom";
}
function finalReply(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const ev = session.events[i];
    if (ev.kind === "text" && ev.text && ev.text.trim()) return ev.text.trim();
  }
  return "";
}
var SECRETISH = new RegExp(
  [
    "\\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}",
    "\\bsk_(?:live|test)_[A-Za-z0-9]{16,}",
    // Stripe uses `_`, so \b after `sk` never fired
    "\\bgh[pousr]_[A-Za-z0-9]{20,}",
    "\\bgithub_pat_[A-Za-z0-9_]{20,}",
    "\\bxox[abprs]-[A-Za-z0-9-]{10,}",
    "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b",
    // ASIA = short-lived STS creds, equally live
    "\\bAIza[A-Za-z0-9_-]{30,}",
    "\\b[A-Za-z][A-Za-z0-9]{2,}_[A-Za-z0-9]{24,}\\b",
    "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
    "Bearer\\s+[A-Za-z0-9._~+/=-]{20,}",
    // THE WHOLE BLOCK, not its opening line. This used to be the `-----BEGIN…-----` header alone,
    // which replaced the one part of a pasted private key that carries no key material and left
    // every base64 line of the actual secret sitting in the payload verbatim — under a SECURITY.md
    // bullet promising that PEM private-key blocks were caught. Reproduced by running a capture
    // over a transcript holding one: the output read `[redacted-secret] MIIEowIBAAKCAQEA…`.
    // The closing marker is optional so a truncated paste still loses its header rather than
    // matching nothing at all, and the body is lazy so two keys in one message stay two matches.
    "-----BEGIN[A-Z ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----)?",
    "\\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s:@/]+:[^\\s:@/]{4,}@",
    // scheme://user:pass@host
    // An explicit assignment to a secret-sounding name. Anchored on the NAME, not on entropy, so
    // it catches the shapes with no recognisable prefix at all (SUPABASE_SERVICE_ROLE_KEY=…).
    // `_KEY` rather than a bare `KEY` so MONKEY= and TURKEY= stay untouched, while the real shapes
    // (SUPABASE_SERVICE_ROLE_KEY, DEPLOY_KEY, OPENAI_API_KEY) all carry the underscore.
    "\\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|_KEY|APIKEY)[A-Za-z0-9_]*\\s*[=:]\\s*\\S{12,}"
  ].join("|"),
  "gi"
);
var EMAILISH = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
var ownEmail = "";
function setOwnEmail(v) {
  ownEmail = (v ?? "").trim().toLowerCase();
}
var redact = (t) => t.replace(SECRETISH, "[redacted-secret]").replace(EMAILISH, (m) => ownEmail !== "" && m.toLowerCase() === ownEmail ? m : "[redacted-email]");
var clipPath = (t, n) => {
  const s = redact(t).replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n - 1).join("") + "\u2026";
};
var clip = (t, n) => {
  const s = redact(t).replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = Array.from(s).slice(0, n - 1).join("");
  return cut + "\u2026";
};
function buildInYourWords(log) {
  let session;
  try {
    session = parseSessionLog(log);
  } catch {
    return "";
  }
  const { kept, dropped, openerSkipped } = userUtterances(session);
  const { unreadable } = session;
  if (!kept.length) return "";
  const BLOCK_BUDGET = BLOCK_SHARES[SECTION.said];
  const OVERHEAD = 650;
  const TIERS = [
    { msg: 700, q: 180 },
    { msg: 400, q: 140 },
    { msg: 250, q: 100 },
    { msg: 150, q: 70 },
    { msg: 100, q: 50 }
  ];
  const renderAt = (u, t) => {
    if (u.kind === "interrupt") return `- \`L${u.line}\` \u2014 **you stopped the agent here** (what follows is your correction)`;
    const tag = u.kind === "custom" ? " _(your own words, not one of the options offered)_" : u.kind === "answer" ? RECOMMENDED_LABEL.test(u.text) ? " _(your pick \u2014 the agent's own recommendation)_" : " _(your pick)_" : u.kind === "mixed" ? " _(your pick, plus words of your own)_" : "";
    const asked = u.question ? ` \u2014 asked: "${clip(u.question, t.q)}"` : "";
    return `- \`L${u.line}\`${tag} "${clip(u.text, t.msg)}"${asked}`;
  };
  const totalAt = (t) => (
    // BYTES, not UTF-16 code units. `BLOCK_SHARES` is defined with Buffer.byteLength and the
    // delivery cliff is a byte limit, so measuring the block in characters compared two different
    // units and believed the smaller. On a Chinese session the block spent 8,133 "chars" against
    // its 8,000 share and cost 19,373 bytes — 2.4x over — and the whole draft came out at 25,212
    // bytes against a 23,400 budget before the agent had written a word. Worse than the overrun:
    // the elision below DELETES the user's oldest messages to fit, and it was choosing what to
    // delete by the wrong measure entirely.
    kept.reduce((n, u) => n + deliveryBytes(renderAt(u, t)) + 1, OVERHEAD)
  );
  const tier = TIERS.find((t) => totalAt(t) <= BLOCK_BUDGET) ?? TIERS[TIERS.length - 1];
  const render = (u) => renderAt(u, tier);
  const opener = kept[0];
  const rest = kept.slice(1);
  const tail = [];
  let spent = deliveryBytes(render(opener)) + OVERHEAD;
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = deliveryBytes(render(rest[i])) + 1;
    if (spent + cost > BLOCK_BUDGET) break;
    spent += cost;
    tail.unshift(rest[i]);
  }
  const elidedByBudget = rest.length - tail.length;
  const notes = [];
  const anyClipped = kept.some((u) => clip(u.text, tier.msg).endsWith("\u2026") && u.text.replace(/\s+/g, " ").trim().length > tier.msg);
  if (anyClipped) notes.push("long messages shortened to fit \u2014 the full text is in the transcript");
  if (elidedByBudget) notes.push(`${elidedByBudget} message${elidedByBudget > 1 ? "s" : ""} elided here to stay in budget`);
  if (openerSkipped) notes.push(`your opening line was a "continue from the handoff" instruction and is not repeated here`);
  if (dropped) notes.push(`${dropped} non-message record${dropped > 1 ? "s" : ""} filtered (command plumbing, harness blocks)`);
  const lines = [
    // Says what it does, and stops saying "every message" the moment that stops being true. The
    // tier ladder carries everything for most sessions, but a very long one still bottoms out and
    // elides — and a heading claiming completeness above a note admitting 26 elisions is the same
    // overclaim, just quieter.
    elidedByBudget ? `## ${SECTION.said} \u2014 the last ${tail.length + 1} of your ${kept.length} messages, in order, straight from the transcript` : unreadable.length ? `## ${SECTION.said} \u2014 your messages in order, straight from the transcript, except any on ${unreadable.length} line(s) it could not read` : `## ${SECTION.said} \u2014 every message you sent, in order, straight from the transcript`,
    "_Engine-extracted, not the agent's paraphrase. `L<n>` is the line in the raw transcript \u2014 read around it to recover any of this in full._",
    "",
    render(opener)
  ];
  if (notes.length) lines.push(`- _(${notes.join(" \xB7 ")} \u2014 all of it is still in the transcript)_`);
  for (const u of tail) lines.push(render(u));
  if (unreadable.length)
    lines.push(`- _(\u26A0 ${unreadable.length} transcript line(s) could not be read \u2014 ${unreadable.slice(0, 5).map((n) => `L${n}`).join(", ")}${unreadable.length > 5 ? ", \u2026" : ""}. A session cut off mid-write leaves a truncated last record, so a message may be missing here, and it would be the most recent one.)_`);
  const reply = finalReply(session);
  if (reply) lines.push(`
- **Agent's last reply (gist):** ${clip(reply, 200)}`);
  return lines.join("\n");
}
function actionLabel(toolName, inp) {
  if (toolName === "Bash") return clip(bareCommand(String(inp.command ?? "")), 60);
  const file = inp.file_path || inp.notebook_path || "";
  const base = file ? redact(baseNameOf(file)) : "";
  const edits = inp.edits;
  const src = String(
    inp.new_string || inp.content || edits?.[0]?.new_string || inp.old_string || ""
  );
  let hint = "";
  const sym = src.match(/\b(?:function|const|let|var|class|interface|type|def|func)\s+([A-Za-z0-9_$]+)/);
  if (sym) hint = sym[1];
  else {
    const firstLine = src.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
    hint = clip(firstLine, 45);
  }
  return [base, hint].filter(Boolean).join(" \u2014 ");
}
function buildTranscriptIndex(log) {
  let session;
  try {
    session = parseSessionLog(log);
  } catch {
    return "";
  }
  const ACTION = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
  const anchors = [];
  const { kept: utterances } = userUtterances(session);
  for (const u of utterances) {
    anchors.push({ line: u.line, text: `${u.kind === "typed" ? "you" : "you\xB7decided"}: "${clip(u.text, 90)}"` });
  }
  for (const ev of session.events) {
    if (ev.kind === "tool" && ev.toolName && ACTION.has(ev.toolName)) {
      const label = actionLabel(ev.toolName, ev.toolInput ?? {});
      anchors.push({ line: ev.line, text: `agent: ${ev.toolName}${label ? ` ${label}` : ""}` });
    }
  }
  if (!anchors.length) return "";
  anchors.sort((a, b) => a.line - b.line);
  const BUDGET = 120;
  let kept = anchors;
  let dropped = 0;
  if (anchors.length > BUDGET) {
    const actions = anchors.filter((a) => a.text.startsWith("agent:"));
    const keepN = Math.max(0, BUDGET - (anchors.length - actions.length));
    const keepSet = new Set(keepN > 0 ? actions.slice(-keepN) : []);
    kept = anchors.filter((a) => !a.text.startsWith("agent:") || keepSet.has(a));
    dropped = actions.length - keepN;
  }
  const body = kept.map((a) => `- \`L${a.line}\` ${a.text}`).join("\n");
  return dropped ? `${body}
- _(+${dropped} earlier agent actions not listed \u2014 read the transcript)_` : body;
}
function buildVerifiedBody(log, repo, pointers) {
  const state = buildState(log, repo, pointers);
  const footprint = sessionFootprint(log, pointers);
  const iyw = buildInYourWords(log);
  let failed2 = "";
  try {
    failed2 = buildWhatFailed(parseSessionLog(log));
  } catch {
  }
  return `${state}${footprint ? `
${footprint}` : ""}${iyw ? `

${iyw}` : ""}${failed2 ? `

${failed2}` : ""}`;
}
function buildSubagentDigest(pointers) {
  return pointers.map((p) => {
    let finding = "";
    try {
      finding = finalReply(parseSessionLog(p, { includeSidechain: true }));
    } catch {
    }
    return { file: baseNameOf(p) || p, pointer: p, finding };
  });
}
var REFUSAL = /The user doesn't want to (?:proceed|take)|user (?:rejected|denied) (?:this|the) tool/i;
var bareCommand = (cmd) => cmd.replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, "").trim();
var targetKey = (tool, inp) => {
  if (tool === "Bash") return bareCommand(String(inp.command ?? ""));
  return inp.file_path || inp.notebook_path || inp.pattern || "";
};
var targetOf = (tool, inp) => {
  const k = targetKey(tool, inp);
  if (tool === "Bash") return clip(k, 80);
  return k ? tailSegments(k, 2) : "";
};
var NO_MATCH_OK = /(?:^|\s|&&|\|\||;)\s*(?:pkill|pgrep|grep|egrep|fgrep|test|diff)\b[^&|;]*$/;
var REAL_ERROR = /\b(?:error|fatal|exception|traceback|denied|not found|no such file|cannot|failed to|refus)|\bcommand timed out\b|\[request interrupted|tool use was rejected|doesn't want to proceed/i;
function isNoMatchExit(command, errorText) {
  if (!command) return false;
  if (!NO_MATCH_OK.test(command)) return false;
  return !REAL_ERROR.test(errorText);
}
function resolvePath(raw, cwd) {
  return absolutePath(raw, cwd, homedir3());
}
var shortPath = (p) => tailSegments(p, 2);
function outcomeOf(m, openedOk) {
  if (m.fixedAt) return ` \u2014 cleared later at \`L${m.fixedAt}\``;
  if (!m.path || existsSync3(m.path)) return " \u2014 (whether it was resolved afterwards is unknown)";
  if (isMutatingTool(m.tool)) return " \u2014 **that file still does not exist**";
  const named = openedOk.filter((o) => o.path !== m.path && o.line > m.line && baseNameOf(o.path) === baseNameOf(m.path));
  const unique = named.length === 1 ? named[0] : void 0;
  if (unique) return ` \u2014 nothing is at that path; a file of that name was opened at \`L${unique.line}\` (\`${shortPath(unique.path)}\`)`;
  return " \u2014 nothing is at that path (it may have been the wrong path)";
}
function buildWhatFailed(session) {
  const calls = /* @__PURE__ */ new Map();
  const mishaps = [];
  const okAfter = [];
  const writtenLater = [];
  const openedOk = [];
  for (const ev of session.events) {
    if (ev.kind === "tool" && ev.toolUseId && ev.toolName) {
      const inp = ev.toolInput ?? {};
      const raw = typeof inp.file_path === "string" ? inp.file_path : typeof inp.notebook_path === "string" ? inp.notebook_path : void 0;
      calls.set(ev.toolUseId, {
        line: ev.line,
        tool: ev.toolName,
        target: targetOf(ev.toolName, inp),
        key: targetKey(ev.toolName, inp),
        path: raw ? resolvePath(raw, ev.cwd) : void 0
      });
    } else if (ev.kind === "tool-result" && ev.toolUseId) {
      const call = calls.get(ev.toolUseId);
      if (!call) continue;
      if (ev.ok === false) {
        const error = clip(ev.text ?? "", 220);
        if (!error) continue;
        const refused = REFUSAL.test(error);
        if (!refused && isNoMatchExit(call.key, ev.text ?? "")) continue;
        mishaps.push({ ...call, error, refused });
      } else {
        okAfter.push({ line: call.line, tool: call.tool, key: call.key });
        if (call.path) openedOk.push({ path: call.path, line: call.line });
        if (call.path && isMutatingTool(call.tool)) writtenLater.push({ path: call.path, line: call.line });
      }
    }
  }
  if (!mishaps.length) return "";
  for (const m of mishaps) {
    const fix = okAfter.find((c) => c.tool === m.tool && c.key === m.key && c.key !== "" && c.line > m.line);
    if (fix) m.fixedAt = fix.line;
    if (!m.fixedAt && m.path) {
      const w = writtenLater.find((x) => x.path === m.path && x.line > m.line);
      if (w) m.fixedAt = w.line;
    }
  }
  const seen = /* @__PURE__ */ new Map();
  for (const m of mishaps) seen.set(`${m.tool}|${m.key}|${m.error.slice(0, 60)}`, m);
  const all = [...seen.values()];
  const CAP = 12;
  const shown = all.slice(-CAP);
  const lines = shown.map((m) => {
    const where = m.target ? ` \`${m.target}\`` : "";
    if (m.refused) return `- \`L${m.line}\` **you refused** \`${m.tool}\`${where} \u2014 do not retry it without asking`;
    return `- \`L${m.line}\` \`${m.tool}\`${where} failed: "${m.error}"${outcomeOf(m, openedOk)}`;
  });
  const more = all.length > CAP ? `
- _(+${all.length - CAP} earlier obstacles \u2014 see the transcript)_` : "";
  return `## ${SECTION.broke} \u2014 tool errors from this session, pulled from the transcript, each with where it stands now (errors from subagents aren't here; they live in each subagent's own transcript)
${lines.join("\n")}${more}`;
}
function citableUserLines(log) {
  try {
    return [...new Set(
      userUtterances(parseSessionLog(log)).kept.filter((u) => u.kind !== "interrupt").map((u) => u.line)
    )].sort((a, b) => a - b);
  } catch {
    return [];
  }
}
var UTTERANCE_CAP = 2e3;
var PATH_CAP = 160;
function citableUtterances(log) {
  const out = {};
  const trueLength = {};
  const recommended = {};
  try {
    for (const u of userUtterances(parseSessionLog(log)).kept) {
      if (u.kind === "interrupt") continue;
      const text = redact(u.text);
      const stored = text.length > UTTERANCE_CAP ? text.slice(0, UTTERANCE_CAP) : text;
      (out[u.line] ??= []).push(stored);
      if (u.kind === "answer" && RECOMMENDED_LABEL.test(stored)) (recommended[u.line] ??= []).push(stored);
      if (text.length > UTTERANCE_CAP) trueLength[u.line] = Math.max(trueLength[u.line] ?? 0, text.length);
    }
  } catch {
  }
  return { utterances: out, truncated: trueLength, recommended };
}
function readable(log) {
  try {
    readFileSync5(log, "utf8");
    return true;
  } catch {
    return false;
  }
}
function hasAnyUserInput(log) {
  try {
    readFileSync5(log, "utf8");
  } catch {
    return false;
  }
  try {
    const u = userUtterances(parseSessionLog(log));
    if (u.prose > 0 || u.kept.length > 0) return true;
    return /"\s*=\s*"|have been answered/.test(readFileSync5(log, "utf8"));
  } catch {
    return true;
  }
}
function resolvedLogPath(log) {
  try {
    return realpathSync3(log);
  } catch {
    return resolve(log);
  }
}
function writeCitations(dir, log) {
  try {
    const userLines = citableUserLines(log);
    if (!userLines.length && existsSync3(join6(dir, "citations.json"))) {
      try {
        const prior = JSON.parse(readFileSync5(join6(dir, "citations.json"), "utf8"));
        if (Array.isArray(prior.userLines) && prior.userLines.length) return;
      } catch {
      }
    }
    writeFileSync2(
      join6(dir, "citations.json"),
      // RESOLVED, not as handed in. The reseal guard identifies the session by resolving this path
      // and comparing — so a relative `--log session.jsonl` recorded verbatim was resolved against
      // the RESEAL run's cwd, named a file that was not there, and refused a reseal of the handoff
      // this very session had captured. Storing what the path resolves to now, while the capture
      // run's cwd is still the right one to resolve against, is what makes the two runs comparable
      // at all. Falls back to the raw string if it cannot be resolved, which leaves the guard
      // exactly as strict as it was rather than silently opening it.
      JSON.stringify({ userLines, ...citableUtterances(log), log: resolvedLogPath(log) }, null, 1),
      // 0600 like every other artifact. This one holds every message the user typed, verbatim up to
      // UTTERANCE_CAP — it was the ONLY artifact still world-readable, the worst one to miss.
      { mode: 384 }
    );
  } catch {
  }
}
function subagentPointers(log) {
  try {
    const dir = join6(log.replace(/\.jsonl$/, ""), "subagents");
    if (!existsSync3(dir)) return [];
    return readdirSync3(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join6(dir, f));
  } catch {
    return [];
  }
}
var IGNORED_LINE = /^[ \t]*\.delulu-handoff\/?[ \t\r]*$/m;
function ensureGitignored(repo) {
  let warn = "";
  if (git(repo, ["rev-parse", "--git-dir"]) === void 0) return warn;
  try {
    const gi = join6(repo, ".gitignore");
    const cur = existsSync3(gi) ? readFileSync5(gi, "utf8") : "";
    if (!IGNORED_LINE.test(cur)) {
      try {
        writeFileSync2(gi, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + ".delulu-handoff/\n");
        warn += `delulu handoff \u2014 added \`.delulu-handoff/\` to .gitignore, so your session content can never reach a commit. Worth knowing: that also puts your handoffs in reach of \`git clean -xdf\`, which deletes ignored files. They live nowhere else.
`;
      } catch {
        warn += `delulu handoff \u2014 could NOT add \`.delulu-handoff/\` to .gitignore (is it read-only?). Your session content is not ignored and can reach a commit. Add the line yourself before committing.
`;
      }
    }
  } catch {
  }
  const tracked = git(repo, ["ls-files", "--", ".delulu-handoff"]);
  if (tracked) {
    const n = tracked.split("\n").filter(Boolean).length;
    warn += `delulu handoff \u2014 ${n} handoff file(s) are already TRACKED by git, which .gitignore cannot undo. To untrack them: \`git rm -r --cached .delulu-handoff\`
`;
  }
  return warn;
}
var KEEP_HANDOFFS = 15;
var MENTION_DRAFTS_ABOVE = 3;
var HANDOFF_FOLDER = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
var FUTURE_SLACK = 5 * 60 * 1e3;
function cmpStamp(a, b) {
  const [as, an] = [a.slice(0, 19), Number(a.slice(20) || 1)];
  const [bs, bn] = [b.slice(0, 19), Number(b.slice(20) || 1)];
  return as < bs ? -1 : as > bs ? 1 : an - bn;
}
function pruneHandoffs(base, keepFolder) {
  try {
    const now = Date.now();
    const folders = readdirSync3(base).filter((f) => {
      if (!HANDOFF_FOLDER.test(f)) return false;
      try {
        return statSync3(join6(base, f)).isDirectory() && existsSync3(join6(base, f, "payload.md"));
      } catch {
        return false;
      }
    }).map((f) => {
      let m = 0;
      try {
        m = statSync3(join6(base, f)).mtimeMs;
      } catch {
        m = 0;
      }
      const named2 = Date.parse(`${f.slice(0, 10)}T${f.slice(11, 19).replace(/-/g, ":")}Z`);
      const future = m > now + FUTURE_SLACK || Number.isFinite(named2) && named2 > now + FUTURE_SLACK;
      return { f, m: future ? -1 : m };
    }).sort((a, b) => b.m - a.m || cmpStamp(b.f, a.f)).map((x) => x.f);
    const drafts = folders.filter((f) => {
      if (f === keepFolder) return false;
      try {
        return isIncompletePayload(readFileSync5(join6(base, f, "payload.md"), "utf8"));
      } catch {
        return false;
      }
    });
    const prunable = folders.filter((f) => {
      if (f === keepFolder) return false;
      try {
        return !isIncompletePayload(readFileSync5(join6(base, f, "payload.md"), "utf8"));
      } catch {
        return false;
      }
    });
    const stale = prunable.slice(KEEP_HANDOFFS);
    const gone = [];
    const failed2 = [];
    for (const f of stale) {
      try {
        rmSync(join6(base, f), { recursive: true, force: true });
        gone.push(f);
      } catch {
        failed2.push(f);
      }
    }
    const drafted = drafts.length > MENTION_DRAFTS_ABOVE ? `delulu handoff \u2014 ${drafts.length} unfinished drafts are sitting in .delulu-handoff/. They are never pruned, because an abandoned draft still holds your words. Delete any you do not want: ${drafts.slice(0, 3).join(", ")}${drafts.length > 3 ? `, +${drafts.length - 3} more` : ""}.
` : "";
    const warn = failed2.length ? `delulu handoff \u2014 could not fully remove ${failed2.length} old handoff folder(s): ${failed2.slice(0, 3).join(", ")}. They may be partly deleted; check them.
` : "";
    if (!gone.length) return warn + drafted;
    const named = gone.slice(0, 5).join(", ") + (gone.length > 5 ? `, +${gone.length - 5} more` : "");
    return `${warn}${drafted}delulu handoff \u2014 pruned ${gone.length} old handoff(s), keeping the newest ${KEEP_HANDOFFS} COMPLETED handoff(s) by modification time (handoffs with unfilled sections are never pruned, and no longer count toward that limit): ${named}
`;
  } catch {
    return "";
  }
}
var sectionKey = (head) => head.split(" \u2014 ")[0].trim();
function verifiedSections(zone) {
  const body = /* @__PURE__ */ new Map();
  const order = [];
  const lines = zone.split("\n");
  let head = "";
  let lead = "";
  let buf = [];
  const flush = () => {
    const text = buf.join("\n");
    if (!head) lead = text;
    else {
      const key = sectionKey(head);
      if (!body.has(key)) {
        body.set(key, { head, text });
        order.push(key);
      }
    }
    buf = [];
  };
  for (const l of lines) {
    if (/^##\s+\S/.test(l)) {
      flush();
      head = l;
    } else buf.push(l);
  }
  flush();
  return { lead, order, body };
}
function mergeVerified(old, rebuilt) {
  const a = verifiedSections(old);
  const b = verifiedSections(rebuilt);
  const lead = b.lead.trim() ? b.lead : a.lead;
  const keys = [...b.order, ...a.order.filter((k) => !b.body.has(k))];
  const out = keys.map((k) => {
    const s = b.body.get(k) ?? a.body.get(k);
    return s ? `${s.head}
${s.text}` : "";
  });
  return [lead.replace(/\s+$/, ""), ...out.map((s) => s.replace(/\s+$/, ""))].filter(Boolean).join("\n\n");
}
function nameHandoff(repo, folder, raw) {
  if (!HANDOFF_FOLDER.test(folder)) {
    failed(`\`--restate ${folder}\` is not a handoff timestamp, so nothing was named. Use the folder name from \`delulu resume --list\`.`);
    return;
  }
  const base = join6(repo, ".delulu-handoff");
  if (!existsSync3(join6(base, folder, "payload.md"))) {
    failed(`there is no handoff at .delulu-handoff/${folder}, so nothing was named.`);
    return;
  }
  const stored = writeName(base, folder, raw);
  if (!stored) {
    failed(`\`--name\` needs some words in it. Nothing was named.`);
    return;
  }
  process.stdout.write(`delulu \u2014 this handoff is now called "${stored}". That is how it will show up in \`delulu resume --list\`, and how you load it: \`delulu resume "${stored.split(" ").slice(0, 2).join(" ")}"\`.
`);
}
function restate(repo, log, folder) {
  if (!HANDOFF_FOLDER.test(folder)) {
    failed(`\`--restate ${folder}\` is not a handoff timestamp, so NOTHING was rewritten. Use the folder name from \`delulu resume --list\`, e.g. 2026-08-14T10-30-00.`);
    return;
  }
  const payloadPath = join6(repo, ".delulu-handoff", folder, "payload.md");
  if (!existsSync3(payloadPath)) {
    process.stdout.write(`delulu handoff \u2014 no handoff at .delulu-handoff/${folder} to refresh (nothing was rewritten). Run \`delulu handoff\` first, or check the timestamp with \`delulu resume --list\`.
`);
    process.exitCode = 1;
    return;
  }
  const base = join6(repo, ".delulu-handoff");
  const newest = readdirSync3(base).filter((f) => HANDOFF_FOLDER.test(f) && existsSync3(join6(base, f, "payload.md"))).sort(cmpStamp).pop();
  if (newest && newest !== folder) {
    failed(`.delulu-handoff/${folder} is not the newest handoff (${newest} is), so NOTHING was rewritten. A sealed handoff is a record of a moment and never moves again \u2014 resealing it would replace its verified zone, and its record of what you said, with THIS session's. Re-run \`--restate ${newest}\`, or \`delulu handoff\` for a fresh draft.`);
    return;
  }
  const recordPath = join6(base, folder, "citations.json");
  let prior = null;
  try {
    prior = JSON.parse(readFileSync5(recordPath, "utf8"));
  } catch {
    prior = null;
  }
  if (!prior || typeof prior.log !== "string" || !prior.log) {
    failed(`.delulu-handoff/${folder} has no readable citations.json, so delulu cannot prove which session captured it \u2014 and NOTHING was rewritten. Resealing a handoff it cannot identify is how an older one gets overwritten with this session's words, which is unrecoverable. Run \`delulu handoff\` for a fresh draft and reseal that.`);
    return;
  }
  const fileId = (p) => {
    try {
      return realpathSync3(p);
    } catch {
      return resolve(p);
    }
  };
  if (fileId(prior.log) !== fileId(log)) {
    failed(`.delulu-handoff/${folder} was captured from a DIFFERENT session (\`${prior.log}\`), and this one is \`${log}\`. NOTHING was rewritten \u2014 resealing it would replace that session's record of the user's words with this session's, unrecoverably. Run \`--restate\` on the folder this session created, or \`delulu handoff\` for a fresh one.`);
    return;
  }
  const cur = readFileSync5(payloadPath, "utf8");
  const headMatch = cur.match(new RegExp(`## ${SECTION.state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\n`));
  const fenceAt = cur.indexOf(AGENT_ZONE);
  if (!headMatch || headMatch.index === void 0 || fenceAt === -1) {
    process.stdout.write(`delulu couldn't find the checked block in .delulu-handoff/${folder}/payload.md, so nothing was refreshed \u2014 what's in there is still from when it was drafted. Run \`delulu handoff\` for a fresh draft rather than editing that block by hand.
`);
    process.exitCode = 1;
    return;
  }
  if (fenceAt <= headMatch.index) {
    failed(`The sections in .delulu-handoff/${folder}/payload.md are out of order \u2014 the dividing line sits above the checked block instead of below it \u2014 so nothing was rewritten. Refreshing it in that state used to duplicate the whole file and report success. Run \`delulu handoff\` for a fresh draft rather than editing it by hand.`);
    return;
  }
  const stateStart = headMatch.index + headMatch[0].length;
  const pointers = subagentPointers(log);
  const rebuilt = buildVerifiedBody(log, repo, pointers);
  const block = mergeVerified(cur.slice(stateStart, fenceAt), rebuilt);
  writeCitations(join6(base, folder), log);
  const cites = citableUtterances(log);
  const notice = citationNotice(checkCitations(cur, citableUserLines(log), cites.utterances, cites.truncated, {
    recommended: cites.recommended,
    // A decision carried forward names the handoff it came from, and that handoff's own record is
    // sitting right here in `base`. Resolving it is what makes "the user locked this two sessions
    // ago" checkable instead of scoring `bad` against a transcript it was never in.
    carried: carriedLookup(base)
  }));
  const sealed = cur.slice(0, stateStart) + block + "\n\n" + cur.slice(fenceAt).replace(/^\n+/, "");
  writeFileSync2(payloadPath, sealed, { mode: 384 });
  process.stdout.write(`delulu re-read the checked blocks for ${folder} \u2014 "${SECTION.state}", "${SECTION.said}" and "${SECTION.broke}" come straight from the transcript again (${deliveryBytes(block).toLocaleString("en-US")} bytes, in the file). Nothing the agent wrote was touched.
`);
  if (notice) process.stdout.write(`
${notice}`);
  const misSorted = sortingNotice(cur);
  if (misSorted) process.stdout.write(`
${misSorted}`);
  const loss = droppedCarried(base, folder, cur);
  const lost = carryItems(loss, loss ? handoffLabel(base, loss.stamp, /* @__PURE__ */ new Date()) : "");
  if (lost.lost.length)
    process.stdout.write(`
delulu \u2014 ${lost.lost.length} constraint(s) carried out of an earlier handoff are NOT in this one, and each said a check could not hold it:
` + lost.lost.map((t) => `  ! ${t}
`).join("") + `  Nothing is blocked and nothing was rewritten. If the user retired them, that is the right outcome \u2014 say which, and why, under "${SECTION.read}". If not, put them back with their original refs before this handoff seals.
`);
  if (lost.unjustified.length)
    process.stdout.write(`
delulu \u2014 ${lost.unjustified.length} line(s) kept under "${SECTION.holds}" do not say why a check could not hold them. A constraint a test can hold belongs in the test, where it is enforced rather than described and costs the next session nothing to read:
` + lost.unjustified.map((t) => `  ? ${t}
`).join(""));
  for (const note of [lost.untouchedNote, lost.routineNote]) if (note) process.stdout.write(`
delulu \u2014 ${note}
`);
  const tooBig = deliveryWarning(sealed, folder);
  if (tooBig) process.stdout.write(`
${tooBig}`);
}
var MORE_TAIL_RESERVE = 60;
function deliveryWarning(payload, folder) {
  const n = deliveryBytes(payload);
  if (n <= SAFE_PAYLOAD_BYTES) return "";
  return `delulu handoff \u2014 HEADS-UP: this payload is ${n.toLocaleString("en-US")} bytes, over the ${SAFE_PAYLOAD_BYTES.toLocaleString("en-US")} that fits through a single \`delulu resume\` output (the harness replaces Bash output above ~${BASH_OUTPUT_CLIFF.toLocaleString("en-US")} bytes with a 2KB preview \u2014 no error, exit 0).
  NOTHING is lost on disk: .delulu-handoff/${folder}/payload.md is complete. But resume will deliver it TRIMMED \u2014 it drops the least critical blocks, in this order (${DELIVERY_DROP_ORDER.join(" -> ")}), names every one it dropped at the TOP of its output, and tells the next session to Read the file for the rest.
` + shareAdvice(payload) + `  To make it arrive whole, shorten the prose blocks now, while you still remember what matters.
`;
}
function proseBudget(payload) {
  const placeholders = payload.match(/<!-- delulu:fill[\s\S]*?-->/g) ?? [];
  if (!placeholders.length) return "";
  const freed = placeholders.reduce((n, p) => n + deliveryBytes(p), 0);
  const fixed = deliveryBytes(payload) - freed;
  const room = SAFE_PAYLOAD_BYTES - fixed;
  if (room <= 0) return "";
  return `delulu handoff \u2014 the ${placeholders.length} section(s) you are about to write share ${room.toLocaleString("en-US")} bytes before \`delulu resume\` has to trim this handoff to deliver it (${fixed.toLocaleString("en-US")} of the ${SAFE_PAYLOAD_BYTES.toLocaleString("en-US")} budget is already spent on the blocks delulu wrote).
  That is a budget, not a target: a shorter handoff that arrives whole beats a fuller one that arrives trimmed.
`;
}
function shareAdvice(payload) {
  const over = shareReport(payload);
  if (!over.length) return "";
  const lines = over.map((o) => `    ${o.name} \u2014 ${o.bytes.toLocaleString("en-US")} bytes, ${(o.bytes - o.share).toLocaleString("en-US")} over its ${o.share.toLocaleString("en-US")} share
`);
  return `  The blocks carrying more than their share of the budget, biggest first:
${lines.join("")}`;
}
function sortingNotice(payload) {
  const asks = [];
  const inHolds = (name) => headingRe(SECTION.holds).test(`## ${name}`);
  for (const e of decidedEntries(payload)) {
    if (!e.text.trim()) continue;
    const reads = classifyRuling(e.text);
    if (!inHolds(e.section) && reads === "rules")
      asks.push(`under "${e.section}", but reads as a standing rule (or has already survived a session) \u2014 should it be under "${SECTION.holds}", where it gets carried? "${clip(e.text, 110)}"`);
    else if (inHolds(e.section) && reads === "session")
      asks.push(`under "${SECTION.holds}", but it names one file, path or commit, which usually means it is spent \u2014 still standing? "${clip(e.text, 110)}"`);
  }
  if (!asks.length) return "";
  const SHOWN = 5;
  const shown = asks.slice(0, SHOWN).map((a) => `  ? ${a}`);
  if (asks.length > SHOWN) shown.push(`  _(+${asks.length - SHOWN} more of the same)_`);
  return `delulu \u2014 ${asks.length} line(s) may be in the wrong block. delulu sorts by the words on the line and you sorted differently; you may well be right, so this is a question, not a finding \u2014 nothing was moved:
${shown.join("\n")}
`;
}
function failed(message) {
  process.stdout.write(`delulu handoff \u2014 ${message}
`);
  process.exitCode = 1;
}
function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    process.stdout.write(`delulu handoff \u2014 capture this session into .delulu-handoff/<timestamp>/

  handoff                        capture the session you are in now
  handoff --restate <timestamp>  re-read the checked blocks into a handoff you already drafted
  handoff --name "short name"    name a handoff, with --restate <timestamp>
  handoff --repo <path>          work on a repo other than the current directory
  handoff --log <path.jsonl>     use this transcript instead of looking one up
`);
    return;
  }
  if ("error" in parsed) {
    failed(`${parsed.error}. Nothing was written. Re-run with a value, e.g. \`--repo <path>\` or \`--restate <timestamp>\`.`);
    return;
  }
  const args = parsed;
  let repo;
  try {
    repo = repoKey(args.repo ?? process.cwd());
  } catch {
    failed(`not a readable path: \`${args.repo ?? process.cwd()}\`. Nothing was written \u2014 no handoff exists. Re-run from inside the repo, or pass \`--repo <path>\`.`);
    return;
  }
  setOwnEmail(git(repo, ["config", "user.email"]));
  const log = args.log ?? resolveLog(repo, args.repo ?? process.cwd());
  if (args.name !== void 0) {
    if (args.restate && log && existsSync3(log)) restate(repo, log, args.restate);
    nameHandoff(repo, args.restate ?? "", args.name);
    return;
  }
  if (!log || !existsSync3(log)) {
    const cause = args.log ? `the \`--log\` path \`${args.log}\` does not exist` : `no session transcript resolved for \`${repo}\` (looked under ${projectsDir()}/ for that repo)`;
    failed(`${cause}. Nothing was written \u2014 no handoff folder, nothing read from the repo, and none of your own words captured. Run it again with \`--log <path to this session's .jsonl>\`. Please don't write a payload by hand in its place: a file that looks checked but isn't is the one failure delulu exists to prevent.`);
    return;
  }
  if (args.restate) {
    restate(repo, log, args.restate);
    return;
  }
  if (!hasAnyUserInput(log)) {
    failed(`${readable(log) ? "this session has no user messages yet" : "that transcript could not be read"} (\`${log}\`), so there is nothing to hand off. Nothing was written \u2014 any earlier handoff for this repo is untouched and still the one \`delulu resume\` will load. If you meant to continue a previous session, run \`delulu resume\`.`);
    return;
  }
  const ts = stamp();
  let folder = ts;
  let dir = join6(repo, ".delulu-handoff", folder);
  const pointers = subagentPointers(log);
  const verifiedBody = buildVerifiedBody(log, repo, pointers);
  mkdirSync(join6(repo, ".delulu-handoff"), { recursive: true, mode: 448 });
  for (let n = 2; ; n++) {
    try {
      mkdirSync(dir, { mode: 448 });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      folder = `${ts}-${n}`;
      dir = join6(repo, ".delulu-handoff", folder);
    }
  }
  const ignoreWarn = ensureGitignored(repo);
  const digest = buildSubagentDigest(pointers);
  const indexMap = buildTranscriptIndex(log);
  const rawTranscript = `${log.replace(homedir3(), "~")}`;
  if (indexMap) {
    writeFileSync2(join6(dir, "index.md"), `# Prior-session map \u2014 ${basename2(repo)} \xB7 ${ts}

> Each line is an anchor with its line number in the raw transcript. To recover any prior detail VERBATIM \u2014 a decision's reasoning, what was said around a turn \u2014 Read around that \`L<n>\` in the raw transcript (don't reload the whole session). **Transcript events are LARGE (inline tool I/O + reasoning) \u2014 Read a SMALL window (a few lines via offset+limit) around the line, not 30+, or you'll blow the read limit.** Raw transcript: \`${rawTranscript}\`

${indexMap}
`, { mode: 384 });
  }
  const pointerLines = [
    indexMap ? `- \`.delulu-handoff/${folder}/index.md\` \u2014 map of the prior session (line-refs); to recover ANY detail verbatim, Read the raw transcript around that line instead of reloading it all` : "",
    digest.length ? `- \`.delulu-handoff/${folder}/context.md\` \u2014 each subagent's full verbatim finding` : ""
  ].filter(Boolean).join("\n");
  const withFindings = digest.filter((d) => d.finding);
  const gistHeader = "\n\n**Subagent findings this session** (gist \u2014 full verbatim in `context.md`):\n";
  const gistRoom = BLOCK_SHARES[SECTION.more] - deliveryBytes(pointerLines + gistHeader) - MORE_TAIL_RESERVE;
  const shownGists = [];
  let gistSpent = 0;
  for (const d of withFindings) {
    const line = `- \`${d.file}\`: "${clip(d.finding, 160)}"
`;
    if (gistSpent + deliveryBytes(line) > gistRoom) break;
    gistSpent += deliveryBytes(line);
    shownGists.push(d);
  }
  const subagentGists = shownGists.length ? gistHeader + shownGists.map((d) => `- \`${d.file}\`: "${clip(d.finding, 160)}"`).join("\n") + (withFindings.length > shownGists.length ? `
- _(+${withFindings.length - shownGists.length} more \u2014 see context.md)_` : "") : "";
  const carried = carriedCandidates(join6(repo, ".delulu-handoff"), folder);
  const all = carried ? carried.lines : [];
  const durable = all.filter((l) => l.life === "rules");
  const rest = all.filter((l) => l.life !== "rules");
  const shown = [...durable, ...rest.slice(0, Math.max(0, CARRIED_CAP - durable.length))];
  const overflow = all.length - shown.length;
  const of = (life) => shown.filter((l) => l.life === life).map((l) => l.text);
  const group = (lines, lead) => lines.length ? `
     ${lead}
${lines.map((l) => `       ${l.replace(/--+>/g, "--&gt;")}`).join("\n")}
` : "";
  const carriedBlock = carried ? `
<!-- delulu:fill \u2014 ${CARRIED_MARKER}: what the USER locked in \`${carried.stamp}\`, emitted by the
     engine and already session-qualified. These are NOT part of this handoff yet.
     ASK ONE QUESTION OF EVERY LINE, BEFORE ANY OTHER: could this be BUILT IN instead? Carrying is
     not the default. A rule a test or a command file already enforces is being re-read every
     session for behaviour that cannot go wrong. A rule the user has restated more than once is a
     rule that should have become a check. And most of what reaches this block was direction given
     in the moment, spent the moment it was acted on. A constraint is either built into the tool or
     it was steering; carried text that enforces nothing is the third thing, and it is what this
     block exists to stop.
     So each line goes to exactly one of four places, and only the last keeps it here:
       ALREADY ENFORCED -> drop it, and name the test or command file that holds it.
       COULD BE A CHECK -> drop it, and write the check. That is the real work, not the sorting.
       WAS STEERING     -> drop it. It did its job when it was said.
       CANNOT BE EITHER -> keep it, and say WHY on the line itself:
                           \`- <rule>. \\\`ref\\\`: "their words" \u2014 ${CARRY_REASON_MARKER} <why>\`
     A line kept with no such reason is NAMED at the seal. Judgement about risk and preference about
     taste are the honest cases; "it feels important" is not one.
     Take the sort to the user \u2014 delulu's grouping below is read off the words and is a GUESS.
     Copy a kept line VERBATIM, ref and quote intact.
     NEVER re-point one of these refs at a line in THIS transcript. That line holds a different
     sentence, and the check reports it as a fabrication \u2014 which is exactly why carried constraints
     used to be dropped rather than restated.
     Nothing here expires on its own, and only the user retires one. Name what you dropped, and why,
     under "${SECTION.read}" \u2014 an empty block is a true statement, not an unfinished one.
     Delete this whole block once you have been through it.
${group(of("rules"), `STILL HOLDS -> "${SECTION.holds}" (survived a session, or reads as a standing rule):`)}${group(of("unsorted"), `NO SIGNAL -> ask which block it belongs in. If no answer comes, put it under "${SECTION.decided}", exactly as it would have gone before the two blocks existed:`)}${group(of("session"), `PROBABLY SPENT -> "${SECTION.decided}" only if it is still live; otherwise drop it (it names one file, path or commit):`)}${overflow ? `
     _(+${overflow} older decision(s) from that handoff not shown \u2014 read its rulings
     in full at .delulu-handoff/${carried.stamp}/payload.md before assuming this is all of them.)_` : ""}
-->` : "";
  const payload = `# delulu handoff \u2014 ${basename2(repo)} \xB7 ${ts}

## ${SECTION.state} \u2014 read from the real repo and disk when this was captured
${verifiedBody}

---
> **Everything below this line is the last session's agent writing from memory, and delulu could not check any of it.** What is above the line it can prove: it read the repo and the disk, and it quoted you word for word. What is below is a colleague's handwritten note \u2014 worth reading, not worth trusting on its own. Before you act on anything that matters, and especially on "committed", "pushed", "done" or "tests pass", check it against what delulu actually read above.
${carriedBlock}
## ${SECTION.holds}
<!-- delulu:fill \u2014 the rules that OUTLIVE this session: what the user has locked and has NOT
     revoked. This block is carried forward; the one further down is not. That is the whole
     difference between them, and it is the difference this file kept losing.
     Same evidence standard as "${SECTION.decided}" \u2014 one per line, each ending with the \`L<n>\`
     ref from "${SECTION.said}" where they said it, followed by their own words. A rule locked in
     an EARLIER session keeps its ORIGINAL ref, session-qualified as \`<handoff-stamp>:L<n>\`;
     re-pointing it at a line in this transcript is reported as a fabrication.
     A line belongs HERE when it is still in force with no end in sight \u2014 "always", "never",
     "before any". A directive about one file, one commit or one task belongs BELOW, in
     "${SECTION.decided}", where it is MEANT to die at the session boundary.
     Nothing here ages out and nothing expires quietly: a rule leaves only when the user revokes
     it, and you may not retire one on your own. If they do revoke one, drop the line and say
     which, and why, under "${SECTION.read}".
     Leave this block EMPTY if nothing stands yet. An empty rules block is a true statement and
     delulu reads it as one \u2014 it is NOT counted as an unfinished section. Inventing a rule to fill
     it is the worst thing you can do here: it will arrive in every later session wearing a
     citation, which reads as MORE settled than a fresh judgement precisely because it has one. -->

## ${SECTION.thread}
<!-- delulu:fill \u2014 INTERPRET the verbatim "${SECTION.said}" block above: what the unfinished thought actually is and why it matters, the intent behind those words. Anchor to the quotes; do NOT re-paraphrase them. Write it so the next session opens MID-CONVERSATION, not mid-report. -->

## ${SECTION.elseWrong}
<!-- delulu:fill \u2014 IF a "${SECTION.broke}" block appears above, it holds the main agent's tool errors,
     clipped to 220 chars and capped at 12; do not restate those. It is ABSENT when nothing
     errored, and it NEVER includes subagent errors. Everything else belongs here: an approach
     that ran without erroring but was wrong, a wrong assumption, a dead end the user vetoed,
     a subagent's failure, and WHY. -->

## ${SECTION.decided}
<!-- delulu:fill \u2014 decisions that are SPENT when this session ends: a call about one file, one
     commit, one task. This block is NOT carried forward \u2014 if a line here would still be true in a
     month, it belongs in "${SECTION.holds}" above instead, and putting it here is how a standing
     rule quietly disappears.
     ONE decision per line. Each line ends with the \`L<n>\` line-ref from
     "${SECTION.said}" where the user actually said it, FOLLOWED BY THEIR OWN WORDS from that line:
       "- Free models only, never a paid API. \`L<n>\`: "i dont want a paid api""
     Quote them verbatim \u2014 a few words is enough, and it must be text that really appears there.
     A line without a citation does NOT belong here \u2014 put it under "${SECTION.read}" below.
     PREFER WORDS THEY TYPED. A pick of an option YOU wrote and marked "(Recommended)" is the
     weakest proof there is \u2014 you would be quoting yourself \u2014 and delulu now reports it as such
     rather than as a ruling. If that pick is genuinely all there is, say so in the line.
     CARRYING ONE FORWARD from an earlier handoff: keep its ORIGINAL ref, session-qualified as
     \`<handoff-stamp>:L<n>\` (the stamp heading that handoff), never re-pointed at a line in this
     session. A constraint the user locked two sessions ago is still locked; re-citing it to the
     wrong transcript is what used to make carried decisions read as fabrications and vanish.
     delulu re-checks this at finalize AND at resume, and shows the user any line that cites a
     place they never spoke, quotes words they did not say there, or cites nothing at all.
     What it CANNOT check is whether your summary in front of the quote is a fair reading of it \u2014
     so the quote must carry the decision, not just sit next to it. -->

## ${SECTION.read}
<!-- delulu:fill \u2014 what the agent inferred, concluded, or decided on its own. Useful, but the user
     never said it. Cross-check before acting on any of it; never carry it forward as a ruling. -->

## ${SECTION.next}
<!-- delulu:fill \u2014 exactly ONE action, with a SEARCHABLE ANCHOR (the function or exact string to grep for, never file:line \u2014 line numbers rot), plus the REASON it is first. Not a list.
     A handed-forward task list is the shortest-lived thing in a handoff: it is usually stale on
     arrival and it anchors the next session to a plan the user may already have moved past. The
     reason matters more than the task \u2014 a successor who knows WHY can re-decide WHAT.
     Anything else that still needs doing belongs in "${SECTION.thread}", as part of where the conversation
     actually stands \u2014 not as a second task list down here. -->


## ${SECTION.more}
${pointerLines}${subagentGists}

---
${CLOSER}. Ask me about anything that's missing before you get going.
`;
  writeFileSync2(join6(dir, "payload.md"), payload, { mode: 384 });
  const findingsBlock = digest.length ? digest.map(
    (d) => `### \`${d.file}\`${d.finding ? " \u2014 verbatim final result" : ""}
${d.finding ? redact(d.finding.trim()) : "(no final result captured \u2014 read the raw transcript)"}

_Raw transcript (for the full reasoning, Read a small window): \`${d.pointer.replace(homedir3(), "~")}\`_`
  ).join("\n\n") : "- (no subagents this session)";
  const context = `# Full session context \u2014 ${basename2(repo)} \xB7 ${ts}

> Engine-verified STATE + your verbatim words live in \`payload.md\` (refreshed at finalize). Below is each subagent's final result, **verbatim** (engine-extracted, NOT re-paraphrased) \u2014 the extraction can't fabricate, but a subagent's own claims are unverified, so cross-check load-bearing ones against STATE or the raw transcript. Open this file only when the payload isn't enough.

## ${SECTION.subagents}
${findingsBlock}
`;
  writeFileSync2(join6(dir, "context.md"), context, { mode: 384 });
  writeCitations(dir, log);
  const pruned = pruneHandoffs(join6(repo, ".delulu-handoff"), folder);
  if (pruned) process.stdout.write(pruned);
  if (ignoreWarn) process.stdout.write(ignoreWarn);
  const stateOnly = verifiedBody.slice(0, verifiedBody.indexOf(`
## ${SECTION.said}`) + 1 || void 0).trimEnd();
  const restBytes = deliveryBytes(verifiedBody) - deliveryBytes(stateOnly);
  process.stdout.write(`delulu read the repo and your messages, and wrote the draft:
  ${join6(".delulu-handoff", folder, "payload.md")}

${stateOnly}

Your own messages and the tool errors are in that file too (${restBytes.toLocaleString("en-US")} more bytes), already checked \u2014 open it when you fill the interview in, and do not re-read them here.

What's left is the interview \u2014 the agent fills in where you left off, what you decided, what went wrong and where to start. After that it's ready to pick up with \`delulu resume\` in a fresh session.
`);
  const tooBig = deliveryWarning(payload, folder);
  if (tooBig) process.stdout.write(`
${tooBig}`);
  else {
    const room = proseBudget(payload);
    if (room) process.stdout.write(`
${room}`);
  }
}
try {
  if (isProgram(import.meta.url)) main();
} catch (e) {
  let written = "";
  try {
    const i = process.argv.lastIndexOf("--repo");
    const target = i >= 0 ? process.argv[i + 1] : process.cwd();
    const base = join6(repoKey(target), ".delulu-handoff");
    const newest = readdirSync3(base).filter((f) => existsSync3(join6(base, f, "payload.md"))).sort().pop();
    if (newest) written = ` A handoff folder DOES exist at .delulu-handoff/${newest} \u2014 check it before assuming nothing was captured; it may be complete.`;
  } catch {
  }
  process.stdout.write(`delulu handoff \u2014 could not capture: ${e instanceof Error ? e.message : "unknown"}.${written || " Nothing was written \u2014 no handoff exists for this session."}
`);
  process.exitCode = 1;
}
export {
  setOwnEmail
};
