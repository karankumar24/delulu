// src/cli/save.ts
import { chmodSync, existsSync as existsSync4, lstatSync, mkdirSync, readdirSync as readdirSync3, readFileSync as readFileSync4, rmSync, statSync as statSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { basename as basename3, dirname as dirname2, join as join5 } from "node:path";
import { homedir as homedir3 } from "node:os";

// src/transcript/git.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
function git(repo, args) {
  try {
    return execFileSync(
      "git",
      ["-C", repo, "-c", "core.quotePath=false", ...args],
      { env: gitEnv(), encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    return void 0;
  }
}
function uncommitted(repo) {
  const status = git(repo, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status === void 0) return void 0;
  return status.split("\n").filter(Boolean).filter((row) => {
    const path = row.trim().replace(/^\S{1,2}\s+/, "");
    if (path === ".delulu-handoff" || path.startsWith(".delulu-handoff/")) return false;
    return path !== ".gitignore" || !onlyDeluluLine(repo, row.trim().startsWith("??"));
  }).length;
}
function onlyDeluluLine(repo, untracked) {
  let added;
  let removed = [];
  if (untracked) {
    try {
      added = readFileSync(join(repo, ".gitignore"), "utf8").split("\n");
    } catch {
      return false;
    }
  } else {
    const diff = git(repo, ["diff", "HEAD", "-U0", "--", ".gitignore"]);
    if (diff === void 0) return false;
    const rows = diff.split("\n");
    added = rows.filter((r) => r.startsWith("+") && !r.startsWith("+++")).map((r) => r.slice(1));
    removed = rows.filter((r) => r.startsWith("-") && !r.startsWith("---")).map((r) => r.slice(1));
  }
  const moved = removed.filter((r) => added.includes(r));
  added = added.filter((r) => r.trim() && !moved.includes(r));
  removed = removed.filter((r) => !moved.includes(r));
  return !removed.length && added.length > 0 && added.every((r) => /^\.delulu-handoff\/?\s*$/.test(r));
}
function keepOutOfGit(repo) {
  if (git(repo, ["rev-parse", "--git-dir"]) === void 0) return "This folder is not a git repository, so nothing keeps .delulu-handoff/ out of copies of it.";
  const file = join(repo, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (/^[ \t]*\.delulu-handoff\/?[ \t\r]*$/m.test(current)) return "";
  try {
    writeFileSync(file, `${current && !current.endsWith("\n") ? `${current}
` : current}.delulu-handoff/
`);
    return "Added .delulu-handoff/ to .gitignore.";
  } catch {
    return "Could not add .delulu-handoff/ to .gitignore; add it before committing.";
  }
}

// src/transcript/repo-key.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync2, realpathSync, statSync } from "node:fs";
import { basename, dirname, join as join2 } from "node:path";
function repoKey(dir) {
  try {
    const top = execFileSync2("git", ["rev-parse", "--show-toplevel"], {
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
    if (existsSync2(join2(dir, ".git"))) return dir;
    if (existsSync2(join2(dir, "HEAD")) && existsSync2(join2(dir, "objects")) && existsSync2(join2(dir, "refs"))) {
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

// src/cli/extract.ts
import { closeSync, existsSync as existsSync3, openSync, readdirSync, readFileSync as readFileSync3, readSync } from "node:fs";
import { basename as basename2, join as join3, resolve } from "node:path";

// src/transcript/files.ts
import { homedir } from "node:os";

// src/transcript/path-shape.ts
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

// src/transcript/files.ts
var MUTATING_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "multiedit", "notebookedit", "editnotebook"]);
var EDITOR_TOOLS = /* @__PURE__ */ new Set(["str_replace_editor", "str_replace_based_edit_tool"]);
var EDITOR_WRITES = /* @__PURE__ */ new Set(["create", "str_replace", "insert", "undo_edit"]);
var MCP_MUTATING = /(?:^|__)(?:write|edit|create)_(?:file|notebook)$/i;
function isMutatingCall(name, input) {
  const n = name.toLowerCase();
  if (MUTATING_TOOLS.has(n) || MCP_MUTATING.test(n)) return true;
  return EDITOR_TOOLS.has(n) && typeof input.command === "string" && EDITOR_WRITES.has(input.command);
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

// src/transcript/tail.ts
import { readFileSync as readFileSync2 } from "node:fs";
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
  if (r.isCompactSummary === true) return null;
  const msg = r.message;
  const role = msg && typeof msg === "object" ? msg.role : void 0;
  if (r.type !== "user" && role !== "user") return null;
  const content = msg && typeof msg === "object" ? msg.content : r.content;
  if (typeof content === "string")
    return content.trim() ? { kind: "user", line, text: content } : null;
  if (!Array.isArray(content)) return null;
  const parts = [];
  const images = [];
  let unsaved = 0;
  const carriesResult = content.some((b) => !!b && typeof b === "object" && b.type === "tool_result");
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text);
    else if (b.type === "image" && !carriesResult) {
      const img = imageOf(b);
      if (img) images.push(img);
      else unsaved++;
    }
  }
  if (parts.length && COMPACT_SUMMARY_OPENER.test(parts[0])) return null;
  if (!parts.length && !images.length && !unsaved) return null;
  return {
    kind: "user",
    line,
    text: parts.join("\n\n"),
    parts,
    ...images.length ? { images } : {},
    ...unsaved ? { imagesUnsaved: unsaved } : {}
  };
}
var COMPACT_SUMMARY_OPENER = /^\s*This session is being continued from a previous conversation/i;
function imageOf(b) {
  const s = b.source;
  if (!s || typeof s !== "object") return null;
  const src = s;
  if (src.type !== "base64" || typeof src.data !== "string" || !src.data || typeof src.media_type !== "string") return null;
  return { mediaType: src.media_type, data: src.data };
}
function queuedUserEvent(rec, line) {
  if (!rec || typeof rec !== "object") return null;
  const r = rec;
  if (r.type !== "attachment") return null;
  const att = r.attachment;
  if (!att || typeof att !== "object") return null;
  const a = att;
  if (a.type !== "queued_command") return null;
  const parts = [];
  const images = [];
  let unsaved = 0;
  if (typeof a.prompt === "string") {
    if (a.prompt.trim()) parts.push(a.prompt);
  } else if (Array.isArray(a.prompt)) {
    for (const block of a.prompt) {
      if (!block || typeof block !== "object") continue;
      const b = block;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text);
      else if (b.type === "image") {
        const img = imageOf(b);
        if (img) images.push(img);
        else unsaved++;
      }
    }
  }
  const text = parts.join("\n\n").trim();
  if (!text && !images.length && !unsaved) return null;
  const shots = { ...images.length ? { images } : {}, ...unsaved ? { imagesUnsaved: unsaved } : {} };
  const queued = () => ({ kind: "user", line, text, parts, ...shots });
  const origin = a.origin;
  const originKind = origin && typeof origin === "object" ? origin.kind : void 0;
  if (typeof originKind === "string") {
    return originKind === "human" ? queued() : null;
  }
  return HARNESS_QUEUED.test(text) ? null : queued();
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
      out.push({ kind: "tool-result", line, toolUseId: b.tool_use_id, ok: b.is_error !== true });
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
  const blocks = content.filter((b) => {
    if (!b || typeof b !== "object") return false;
    const bb = b;
    return bb.type === "tool_result" && typeof bb.tool_use_id === "string" && askIds.has(bb.tool_use_id);
  });
  for (const bb of blocks) {
    const text = toolResultText(bb.content);
    if (text) out.push({ kind: "user-meta", line, text });
  }
  return out;
}
function parseSessionLog(logPath, opts) {
  const keepSidechain = opts?.includeSidechain === true;
  const raw = readFileSync2(logPath, "utf8");
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
    if (content) {
      events.push(...blocksToEvents(content, line, recordCwd(rec)));
    }
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

// src/cli/json.ts
var obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : void 0;
var str = (v) => typeof v === "string" ? v : "";
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => obj(b)?.type === "text" ? str(obj(b)?.text) : "").filter(Boolean).join("\n\n");
}

// src/cli/extract.ts
function notificationOf(line, text) {
  if (!/^\s*<task-notification/i.test(text)) return void 0;
  const one = (tag) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
  const open = text.indexOf("<result>");
  const close = text.lastIndexOf("</result>");
  return {
    line,
    taskIds: [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1].trim()),
    toolUseId: one("tool-use-id"),
    status: one("status"),
    summary: one("summary") ?? "",
    ...open !== -1 && close > open ? { result: text.slice(open + "<result>".length, close).trim() } : {}
  };
}
var REFUSAL = /doesn't want to proceed with this tool use/i;
var RESTART_NOTICE = /^No completion record was found/i;
var APP_NOTICES = /* @__PURE__ */ new Set([
  "I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.",
  "My computer went to sleep while you were working. Please continue from where you left off.",
  "The app was quit while you were working. Please continue from where you left off."
]);
var INTERRUPT = /^\[Request interrupted by user/;
var COMPACT_SUMMARY = /^\s*This session is being continued from a previous conversation/i;
function extractSession(log, opts = {}) {
  const lines = [];
  const results = /* @__PURE__ */ new Map();
  const candidates = [];
  const notifications = [];
  const flow = [];
  const prs = /* @__PURE__ */ new Map();
  const prLines = /* @__PURE__ */ new Map();
  const relayed = [];
  readFileSync3(log, "utf8").split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    let r;
    try {
      r = obj(JSON.parse(raw));
    } catch {
      return;
    }
    if (!r) return;
    const line = i + 1;
    const shutdown = r.interruptedByShutdown === true;
    lines[i] = { type: str(r.type) || void 0, uuid: str(r.uuid) || void 0, at: str(r.timestamp) || void 0, shutdown };
    if (r.isSidechain === true) return;
    if (r.type === "assistant" || r.type === "user" || r.type === "system" && /^model_refusal/.test(str(r.subtype))) flow.push({ line, rec: r });
    if (r.type === "pr-link" && typeof r.prNumber === "number") {
      prs.set(r.prNumber, { number: r.prNumber, repo: str(r.prRepository), url: str(r.prUrl) });
      prLines.set(r.prNumber, line);
    }
    const peer = r.type === "user" && obj(r.origin)?.kind === "peer" ? obj(r.origin) : void 0;
    if (peer) relayed.push({ kind: "relayed", line, ...str(r.timestamp) ? { at: str(r.timestamp) } : {}, from: str(peer.name) || str(peer.from), text: str(peer.body) });
    const originKind = obj(r.origin)?.kind;
    const fromHuman = originKind === void 0 || originKind === "human";
    if (r.type === "user") {
      const content = obj(r.message)?.content;
      const blocks = Array.isArray(content) ? content.map(obj) : [];
      for (const b of blocks) {
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string")
          results.set(b.tool_use_id, { isError: b.is_error === true, shutdown, text: textOf(b.content), record: r });
      }
      const text = textOf(content);
      const told = notificationOf(line, text);
      if (told) notifications.push(told);
      if (fromHuman && r.isMeta !== true && r.isCompactSummary !== true && text.trim() && !COMPACT_SUMMARY.test(text) && !blocks.some((b) => b?.type === "tool_result")) candidates.push({ line });
    } else if (r.type === "attachment") {
      const a = obj(r.attachment);
      const text = textOf(a?.prompt).trim();
      const kind = obj(a?.origin)?.kind;
      const told = a?.type === "queued_command" ? notificationOf(line, text) : void 0;
      if (told) notifications.push(told);
      if (a?.type === "queued_command" && text && (kind === "human" || kind === void 0 && !/^<task-notification/i.test(text)))
        candidates.push({ line, queued: text });
    }
  });
  const copied = copiedFrom(log, lines, opts.siblings ?? []);
  const inCopy = (line) => !!copied && line >= copied.fromLine && line <= copied.untilLine;
  const atOf = (line) => {
    const a = lines[line - 1]?.at;
    return a ? { at: a } : {};
  };
  const parsed = parseSessionLog(log);
  const turns = [];
  const notices = [];
  const placed = /* @__PURE__ */ new Set();
  const placedText = /* @__PURE__ */ new Set();
  const replies = [];
  const calls = /* @__PURE__ */ new Map();
  let before = "";
  for (const ev of parsed.events) {
    if (inCopy(ev.line)) continue;
    if (ev.kind === "text") {
      if (ev.text?.trim()) {
        before = ev.text.trim();
        replies.push({ line: ev.line, text: before });
      }
      continue;
    }
    if (ev.kind === "tool" && ev.toolUseId && ev.toolName !== "AskUserQuestion")
      calls.set(ev.toolUseId, { name: ev.toolName ?? "", input: ev.toolInput ?? {}, line: ev.line, background: ev.toolInput?.run_in_background === true });
    if (ev.kind === "tool-result" && ev.ok === false && ev.toolUseId) {
      const call = calls.get(ev.toolUseId);
      const res = results.get(ev.toolUseId);
      if (call && res && !res.shutdown && REFUSAL.test(res.text)) {
        const what = str(call.input.description) || str(call.input.command) || str(call.input.file_path) || str(call.input.url);
        turns.push({ kind: "refused", line: ev.line, ...atOf(ev.line), tool: call.name, what });
      }
      continue;
    }
    if (ev.kind === "user-meta") {
      before = "";
      continue;
    }
    if (ev.kind === "tool" && ev.toolName === "AskUserQuestion") {
      const qs = Array.isArray(ev.toolInput?.questions) ? ev.toolInput.questions : [];
      const res = ev.toolUseId ? results.get(ev.toolUseId) : void 0;
      turns.push({ kind: "asked", line: ev.line, ...atOf(ev.line), before, questions: qs.map((q) => question(obj(q) ?? {}, res)) });
      before = "";
      continue;
    }
    if (ev.kind !== "user") continue;
    before = "";
    placed.add(ev.line);
    const text = (ev.text ?? "").trim();
    placedText.add(text.replace(/\s+/g, " "));
    const blocks = ev.parts && ev.parts.length > 1 ? ev.parts : [text];
    let words = text;
    let command = false;
    if (blocks.some((b) => KNOWN_WRAPPERS.test(b.trim()))) {
      const kept = [];
      for (const b of blocks.map((x) => x.trim()).filter(Boolean)) {
        if (!KNOWN_WRAPPERS.test(b)) {
          kept.push(b);
          continue;
        }
        const args = commandArgsProse(b);
        if (args) {
          command = true;
          kept.push(args);
          continue;
        }
        const inner = unwrapUserProse(b);
        if (inner) kept.push(inner);
      }
      words = kept.join("\n\n");
    }
    const shots = { ...ev.images?.length ? { images: ev.images } : {}, ...ev.imagesUnsaved ? { imagesUnsaved: ev.imagesUnsaved } : {} };
    if (!words && !shots.images && !shots.imagesUnsaved) continue;
    if (INTERRUPT.test(words)) {
      turns.push({ kind: "stopped", line: ev.line, ...atOf(ev.line), appClosed: !!lines[ev.line - 1]?.shutdown });
      continue;
    }
    if (APP_NOTICES.has(words)) {
      notices.push({ line: ev.line, text: words });
      continue;
    }
    const how = command ? "command" : lines[ev.line - 1]?.type === "attachment" ? "queued" : "typed";
    turns.push({ kind: "said", line: ev.line, ...atOf(ev.line), text: words, how, ...words === "Try again" ? { maybeApp: true } : {}, ...shots, ...pasteOf(words) });
  }
  const unplaced = candidates.filter((c) => !inCopy(c.line) && !placed.has(c.line) && !(c.queued && placedText.has(c.queued.replace(/\s+/g, " ")))).map((c) => c.line);
  const helpers = helpersOf(log, calls, results, notifications.filter((n) => !inCopy(n.line)));
  const startedAt = lines.find((l, i) => l?.at && !inCopy(i + 1))?.at;
  const appLines = new Set(flow.filter((f) => obj(f.rec.message)?.model === "<synthetic>").map((f) => f.line));
  let ended = endingOf(flow, inCopy);
  const saves = flow.filter((f) => !inCopy(f.line) && isSave(f.rec)).map((f) => f.line);
  if (ended?.kind === "mid-action") {
    const at = ended.line;
    const spoke = Math.max(0, ...flow.filter((f) => f.line < at && f.rec.type === "user" && f.rec.isMeta !== true && !obj(f.rec.message)?.content?.some?.((b) => obj(b)?.type === "tool_result") && textOf(obj(f.rec.message)?.content).trim()).map((f) => f.line));
    if (saves.some((l) => l > spoke)) ended = void 0;
  }
  const all = [...turns, ...relayed.filter((t) => !inCopy(t.line))].sort((a, b) => a.line - b.line);
  return {
    turns: all,
    notices,
    ...copied ? { copied } : {},
    unplaced,
    unreadable: parsed.unreadable,
    helpers,
    replies: replies.filter((r) => !appLines.has(r.line)),
    ...startedAt ? { startedAt } : {},
    ...ended ? { ended } : {},
    saves,
    scheduled: scheduledOf(calls, results).filter((s) => !inCopy(s.line)),
    prs: [...prs.values()].filter((p) => !inCopy(prLines.get(p.number)))
  };
}
var SAVED = "delulu saved this session:";
var SAVE_CALL = /cli\.mjs"?\s+handoff\b|\bdelulu\s+handoff\b|\bnode\s+"[^"\n]*\/hook\/handoff\.mjs"(?!\s+--repo\b)/;
function isSave(rec) {
  const content = obj(rec.message)?.content;
  if (rec.type === "user") return textOf(content).includes("<command-name>/delulu:handoff</command-name>");
  if (rec.type !== "assistant" || !Array.isArray(content)) return false;
  return content.map(obj).some((b) => b?.type === "tool_use" && (b.name === "Skill" && str(obj(b.input)?.skill) === "delulu:handoff" || b.name === "Bash" && SAVE_CALL.test(str(obj(b.input)?.command))));
}
function endingOf(flow, inCopy) {
  let tail;
  const pending = /* @__PURE__ */ new Set();
  for (const { line, rec } of flow) {
    if (inCopy(line)) continue;
    const msg = obj(rec.message);
    const blocks = Array.isArray(msg?.content) ? msg.content.map(obj) : [];
    if (rec.type === "system") {
      tail = { kind: "safeguard", line, text: str(rec.apiRefusalExplanation) || "The request was blocked by the model." };
      continue;
    }
    if (rec.type === "assistant" && msg?.model === "<synthetic>") {
      const text = textOf(msg.content).trim();
      const kind = rec.error === "rate_limit" ? "limit" : /safeguards flagged/i.test(text) ? "safeguard" : "app-error";
      if (text !== "No response requested.") tail = { kind, line, text };
      continue;
    }
    if (rec.type === "assistant") {
      if (blocks.some((b) => b?.type === "text" && str(b.text).trim())) tail = void 0;
      for (const b of blocks) {
        if (b?.type !== "tool_use") continue;
        const input = obj(b.input) ?? {};
        if (SAVE_CALL.test(str(input.command))) {
          tail = void 0;
          continue;
        }
        pending.add(str(b.id));
        tail = { kind: "mid-action", line, text: `${str(b.name)}: ${str(input.description) || str(input.command) || str(input.file_path)}` };
      }
      continue;
    }
    const answered = blocks.some((b) => b?.type === "tool_result" && pending.has(str(b.tool_use_id)));
    if (answered || textOf(msg?.content).trim()) tail = void 0;
  }
  return tail;
}
function pasteOf(words) {
  const head = words.match(/^<!-- attach: (.*?) -->\n/);
  if (!head) return {};
  const rest = words.slice(head[0].length).split("\n");
  let i = 0;
  while (i < rest.length && rest[i].startsWith(">")) i++;
  const pasted = rest.slice(0, i).map((l) => l.replace(/^> ?/, "")).join("\n");
  return { pasted: { source: head[1], text: pasted }, typed: rest.slice(i).join("\n").trim() };
}
var ENDED = { completed: "finished", failed: "failed", killed: "stopped", stopped: "stopped" };
function helpersOf(log, calls, results, told) {
  const out = [];
  const metas = metasOf(log);
  for (const [toolId, call] of calls) {
    const agent = call.name === "Agent" || call.name === "Task";
    const workflow = call.name === "Workflow";
    if (!agent && !workflow && !(call.name === "Bash" && call.background)) continue;
    const res = results.get(toolId);
    if (res && REFUSAL.test(res.text)) continue;
    const result = obj(res?.record.toolUseResult);
    const id = str(result?.agentId) || str(result?.backgroundTaskId) || res?.text.match(/agentId: (\w+)/)?.[1] || res?.text.match(/background with ID: (\w+)/)?.[1] || void 0;
    const what = str(call.input.description) || str(call.input.command) || str(call.input.name);
    const helper = { kind: agent ? "agent" : workflow ? "workflow" : "command", line: call.line, what, ...id ? { id } : {}, ended: "running" };
    if (res?.isError && /^Tool permission request failed|auto mode cannot determine/.test(res.text.trim())) {
      out.push({ ...helper, ended: "not started", how: res.text.trim().split("\n")[0] });
      continue;
    }
    if (res?.isError && /^\[Request interrupted/.test(res.text.trim())) {
      out.push({ ...helper, ended: "stopped", how: "Stopped by the user" });
      continue;
    }
    const async = call.background || result?.isAsync === true || !!result?.backgroundTaskId;
    if (!async && res) {
      const died = /^Agent terminated early/.test(res.text.trim());
      helper.ended = res.isError || died ? "failed" : "finished";
      if (died) helper.how = res.text.trim().split("\n")[0];
      else if (!res.isError && res.text.trim()) helper.report = res.text.trim();
    }
    for (const n of told) {
      const mine = id && n.taskIds.includes(id) || !!n.toolUseId && n.toolUseId === toolId;
      if (RESTART_NOTICE.test(n.summary)) {
        if ((mine || n.summary.includes(`"${what}"`)) && helper.ended === "running") {
          helper.ended = "no record";
          helper.how = n.summary;
        }
        continue;
      }
      if (!mine) continue;
      const wasFinished = helper.ended === "finished";
      helper.ended = ENDED[n.status ?? ""] ?? "stopped";
      helper.how = n.summary;
      if (helper.ended === "finished" && n.result) {
        if (!(wasFinished && helper.report)) helper.report = n.result;
      } else delete helper.report;
    }
    for (const [otherId, other] of calls) {
      if (!id || str(other.input.task_id) !== id) continue;
      const got = results.get(otherId);
      if (!got || got.isError) continue;
      if (other.name === "TaskStop" && /Successfully stopped task/.test(got.text) && helper.ended === "running") {
        helper.ended = "stopped";
        helper.how = "Stopped by Claude";
      }
      const output = got.text.match(/<output>([\s\S]*?)<\/output>/)?.[1]?.trim();
      if (other.name === "TaskOutput" && /<status>completed<\/status>/.test(got.text) && output && helper.ended === "running") {
        helper.ended = "finished";
        helper.report = output;
      }
    }
    const transcript = agent && id ? join3(log.replace(/\.jsonl$/, ""), "subagents", `agent-${id}.jsonl`) : "";
    if (transcript && existsSync3(transcript)) {
      helper.transcript = transcript;
      if (helper.ended !== "finished") {
        try {
          const own = parseSessionLog(transcript, { includeSidechain: true });
          const words = [...own.events].reverse().find((e) => e.kind === "text" && e.text?.trim())?.text?.trim();
          if (words) helper.lastWords = words;
          const files = mutatedFiles(own);
          if (files.length) helper.files = files;
        } catch {
        }
      }
    }
    const meta = id ? metas.get(id) : void 0;
    if (meta && str(meta.worktreeBranch)) helper.branch = str(meta.worktreeBranch);
    const kids = [...metas.values()].filter((m) => id && m.parentAgentId === id).map((m) => str(m.description));
    if (kids.length) helper.started = kids;
    out.push(helper);
  }
  return out;
}
function metasOf(log) {
  const out = /* @__PURE__ */ new Map();
  const dir = join3(log.replace(/\.jsonl$/, ""), "subagents");
  try {
    for (const f of readdirSync(dir)) {
      const id = f.match(/^agent-(.+)\.meta\.json$/)?.[1];
      if (!id) continue;
      try {
        const m = obj(JSON.parse(readFileSync3(join3(dir, f), "utf8")));
        if (m) out.set(id, m);
      } catch {
      }
    }
  } catch {
  }
  return out;
}
function scheduledOf(calls, results) {
  const out = [];
  let wake;
  for (const [toolId, call] of calls) {
    if (results.get(toolId)?.isError) continue;
    if (call.name === "ScheduleWakeup") {
      wake = call.input.stop === true || typeof call.input.delaySeconds !== "number" ? void 0 : { line: call.line, what: `Wake-up in ${call.input.delaySeconds}s: ${str(call.input.reason)}` };
    }
    if (call.name !== "RemoteTrigger") continue;
    let input = call.input;
    const raw = str(obj(call.input.__unparsedToolInput)?.raw);
    if (raw) {
      try {
        input = obj(JSON.parse(raw));
      } catch {
        input = void 0;
      }
    }
    const body = obj(input?.body);
    if (input?.action === "create" && body) out.push({ line: call.line, what: `${str(body.name)} (${str(body.cron_expression)})` });
  }
  return (wake ? [...out, wake] : out).sort((a, b) => a.line - b.line);
}
function question(q, res) {
  const options = (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: str(obj(o)?.label), description: str(obj(o)?.description), ...typeof obj(o)?.preview === "string" ? { preview: str(obj(o)?.preview) } : {} }));
  const asked = str(q.question);
  return { question: asked, options, answer: answerTo(asked, options, res) };
}
function answerTo(asked, options, res) {
  if (!res) return { outcome: "open" };
  if (res.isError) {
    if (res.shutdown) return { outcome: "app-closed" };
    if (/doesn't want to proceed|rejected/i.test(res.text)) return { outcome: "declined" };
    return { outcome: "failed", detail: res.text };
  }
  const result = obj(res.record.toolUseResult);
  const map = obj(result?.answers);
  if (!map) return { outcome: "unread", detail: res.text };
  const value = map[asked];
  const labels = new Set(options.map((o) => o.label));
  const items = (typeof value === "string" ? [value] : Array.isArray(value) ? value : []).map((v) => str(v).trim()).filter(Boolean).map((text) => ({ text, picked: labels.has(text) }));
  if (!items.length) return { outcome: "unanswered" };
  const notes = str(obj(obj(result?.annotations)?.[asked])?.notes).trim();
  return { outcome: "answered", items, ...notes ? { notes } : {} };
}
function copiedFrom(log, lines, siblings) {
  const first = lines.findIndex((l) => l?.uuid);
  const start = lines.find((l) => l?.at)?.at;
  if (first === -1 || !start) return void 0;
  const uuid = lines[first].uuid;
  let best;
  for (const sibling of siblings) {
    if (resolve(sibling) === resolve(log)) continue;
    const head = headOf(sibling);
    if (!head.includes(uuid)) continue;
    const theirStart = firstTimestamp(head);
    if (!theirStart || theirStart >= start) continue;
    let text;
    try {
      text = readFileSync3(sibling, "utf8");
    } catch {
      continue;
    }
    const ids = /* @__PURE__ */ new Set();
    const saveCalls = /* @__PURE__ */ new Set();
    let pending = [];
    for (const raw of text.split("\n")) {
      let rec;
      try {
        rec = obj(JSON.parse(raw));
      } catch {
        continue;
      }
      if (!rec) continue;
      if (typeof rec.uuid === "string") pending.push(rec.uuid);
      if (rec.isSidechain === true) continue;
      const content = obj(rec.message)?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content.map(obj)) {
        if (rec.type === "assistant" && b?.type === "tool_use" && b.name === "Bash" && SAVE_CALL.test(str(obj(b.input)?.command))) saveCalls.add(str(b.id));
        if (rec.type === "user" && b?.type === "tool_result" && saveCalls.has(str(b.tool_use_id)) && textOf(b.content).startsWith(SAVED)) {
          for (const u of pending) ids.add(u);
          pending = [];
        }
      }
    }
    if (!ids.size) continue;
    let until = first;
    let records = 0;
    for (let i = first; i < lines.length; i++) {
      const u = lines[i]?.uuid;
      if (!u) continue;
      if (!ids.has(u)) break;
      until = i;
      records++;
    }
    if (!best || records > best.records)
      best = { from: basename2(sibling).replace(/\.jsonl$/, ""), fromLine: first + 1, untilLine: until + 1, records };
  }
  return best;
}
var HEAD_BYTES = 256 * 1024;
function headOf(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } catch {
    return "";
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function firstTimestamp(text) {
  for (const raw of text.split("\n")) {
    if (!raw.includes('"timestamp"')) continue;
    try {
      const t = obj(JSON.parse(raw))?.timestamp;
      if (typeof t === "string") return t;
    } catch {
    }
  }
  return void 0;
}
var KNOWN_WRAPPERS = /^\s*<(task-notification|command-message|command-name|command-args|local-command-stdout|local-command-stderr|create-pr-command|ci-monitor-event|system-reminder|preview-annotation-context|observed_from_primary_session|tool_use_error|tool_result|output)\b/i;
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
    let end = closingIndex(rest, open[1], open[0].length);
    if (end === -1) {
      const close = `</${open[1].toLowerCase()}>`;
      const last = rest.toLowerCase().lastIndexOf(close);
      if (last !== -1) end = last + close.length;
    }
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

// src/cli/redact.ts
var SECRETS = new RegExp([
  "\\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}",
  "\\bsk_(?:live|test)_[A-Za-z0-9]{16,}",
  "\\bsb_secret_[A-Za-z0-9_-]{16,}",
  "\\bgh[pousr]_[A-Za-z0-9]{20,}",
  "\\bgithub_pat_[A-Za-z0-9_]{20,}",
  "\\bxox[abprs]-[A-Za-z0-9-]{10,}",
  "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b",
  "\\bAIza[A-Za-z0-9_-]{30,}",
  "\\bya29\\.[A-Za-z0-9_-]{20,}",
  "https://(?:hooks\\.slack\\.com/services|discord(?:app)?\\.com/api/webhooks)/[A-Za-z0-9/_-]+",
  // A long name_token mixing case and digits, except id prefixes that are not secrets.
  "\\b(?!(?:req|trig|cse|dpl|env|msg|toolu)_)[A-Za-z][A-Za-z0-9]{2,}_(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{24,}\\b",
  "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  "Bearer\\s+[A-Za-z0-9._~+/=-]{20,}",
  "-----BEGIN[A-Z ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----)?",
  "\\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s:@/]+:[^\\s/]{4,}@"
].join("|"), "g");
var ASSIGNED = /\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|_KEY|APIKEY)[A-Za-z0-9_]*\s*[=:]\s*(?=[^\s,]*[A-Za-z])(?=[^\s,]*[0-9])[^\s,]{12,}/gi;
var ASSIGNED_PASSWORD = /\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET)[A-Za-z0-9_]*\s*=\s*[^\s,]{8,}/gi;
var EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.([A-Za-z]{2,})\b/g;
var FILE_EXT = /* @__PURE__ */ new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "py", "css", "html", "yml", "yaml", "sh"]);
function makeRedactor(o = {}) {
  const keep = new Set([o.ownEmail ?? "", ...o.typedEmails ?? []].map((e) => e.trim().toLowerCase()).filter(Boolean));
  return (t) => t.replace(SECRETS, "[redacted-secret]").replace(ASSIGNED, "[redacted-secret]").replace(ASSIGNED_PASSWORD, "[redacted-secret]").replace(EMAIL, (m, tld, at, all) => keep.has(m.toLowerCase()) || FILE_EXT.has(tld.toLowerCase()) || all[at - 1] === "/" ? m : "[redacted-email]");
}
function clipText(t, n, redact) {
  const chars = Array.from(redact(t));
  return chars.length <= n ? chars.join("") : `${chars.slice(0, n - 1).join("")}\u2026`;
}

// src/cli/resolve-log.ts
import { closeSync as closeSync2, fstatSync, openSync as openSync2, readdirSync as readdirSync2, readSync as readSync2, statSync as statSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
function claudeHome() {
  const v = process.env.CLAUDE_CONFIG_DIR?.trim();
  return v ? v : join4(homedir2(), ".claude");
}
function projectsDir() {
  return join4(claudeHome(), "projects");
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
    const dir = join4(projectsDir(), slug);
    let names;
    try {
      names = readdirSync2(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const entries = [];
    for (const f of names) {
      try {
        entries.push({ p: join4(dir, f), mtime: statSync2(join4(dir, f)).mtimeMs });
      } catch {
      }
    }
    if (!entries.length) continue;
    const newest = entries.sort((x, y) => y.mtime - x.mtime);
    return (newest.find((e) => asksToSave(e.p)) ?? newest[0]).p;
  }
  return null;
}
function asksToSave(file) {
  try {
    const fd = openSync2(file, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 256e3);
      const buf = Buffer.alloc(len);
      readSync2(fd, buf, 0, len, size - len);
      const tail = buf.toString("utf8");
      return tail.includes("/delulu:handoff") || tail.includes("hook/handoff.mjs");
    } finally {
      closeSync2(fd);
    }
  } catch {
    return false;
  }
}
function resolveBySessionId() {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (!id || !/^[A-Za-z0-9-]{8,}$/.test(id)) return null;
  const base = projectsDir();
  let dirs;
  try {
    dirs = readdirSync2(base);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join4(base, d, `${id}.jsonl`);
    try {
      if (statSync2(p).isFile()) return p;
    } catch {
    }
  }
  return null;
}

// src/cli/dates.ts
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var clock = (d) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
var fullDate = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${clock(d)}`;
function shortTime(iso) {
  const d = iso ? new Date(iso) : void 0;
  return d && !Number.isNaN(d.getTime()) ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock(d)}` : "";
}

// src/cli/limits.ts
var ONE_READ_BYTES = 27e3;
var RESUME_LINES_BYTES = 1500;
var HANDOFF_BYTES = ONE_READ_BYTES - RESUME_LINES_BYTES;

// src/cli/write.ts
var ENDING = {
  limit: "on a usage limit",
  "app-error": "on an app error",
  safeguard: "on a request the model's safeguards blocked",
  "mid-action": "in the middle of an action"
};
var section = (name, body) => `## ${name}
${body}`;
function renderHandoff(i) {
  const budget = i.budgetBytes ?? HANDOFF_BYTES;
  let out = "";
  for (let level = 0; level <= 3; level++) {
    out = compose(i, level);
    if (Buffer.byteLength(out) <= budget) break;
  }
  return out;
}
function compose(i, level) {
  const { ex, redact } = i;
  const top = [`# ${i.project} handoff \xB7 saved ${fullDate(i.savedAt)}`, `Transcript: ${i.transcript} (L123 means line 123 of it)`];
  if (ex.copied) top.push(`This session continues ${ex.copied.from.slice(0, 8)}; its messages up to that session's save are in that handoff, not repeated here.`);
  if (ex.ended) top.push(`The session ended ${ENDING[ex.ended.kind]} (L${ex.ended.line}): ${redact(ex.ended.text)}`);
  if (ex.unplaced.length) top.push(`delulu could not place ${ex.unplaced.length} records (${ex.unplaced.map((l) => `L${l}`).join(", ")}); a message may be missing near them.`);
  const parts = [top.join("\n"), section("Last agent's summary (not checked)", i.note?.trim() ? redact(i.note.trim()) : "No summary was written when this was saved.")];
  parts.push(section("Repo when saved", repoPart(i)));
  const last = lastExchange(ex, redact, level);
  if (last) parts.push(section("Last exchange", last));
  const helpers = helperLines(ex, redact, level);
  if (helpers) parts.push(section("Subagents and background tasks", helpers));
  const said = messageLines(ex, redact, i.folder, level);
  if (said) parts.push(section("The user's messages, newest first", said));
  return `${parts.join("\n\n")}
`.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}
function repoPart(i) {
  const r = i.repo;
  const dirty = r.uncommitted === void 0 ? "uncommitted files unknown" : r.uncommitted === 0 ? "no uncommitted files" : `${r.uncommitted} uncommitted file${r.uncommitted === 1 ? "" : "s"}`;
  const lines = [`Branch \`${r.branch ?? "unknown"}\` at \`${r.commit ?? "unknown"}\`, ${dirty}`];
  if (r.commits.length) lines.push("Commits this session:", ...r.commits.map((c) => `- \`${c.sha}\` ${i.redact(c.subject)}`));
  for (const pr of i.ex.prs) lines.push(`Pull request #${pr.number} in ${pr.repo}: ${pr.url}`);
  return lines.join("\n");
}
function lastExchange(ex, redact, level) {
  const lastSave = ex.saves.at(-1) ?? Infinity;
  const spoke = Math.max(0, ...ex.turns.filter((t) => t.kind === "said" && t.line < lastSave && !t.text.startsWith("/delulu:handoff")).map((t) => t.line));
  const save = Math.min(lastSave, ...ex.saves.filter((l) => l > spoke));
  const reply = ex.replies.filter((r) => r.line < save).at(-1);
  const command = ex.turns.find((t) => t.kind === "said" && t.line === save && t.text.startsWith("/delulu:handoff"));
  const added = command?.kind === "said" ? command.text.replace(/^\/delulu:handoff\s*/, "") : "";
  const lines = [];
  if (reply) {
    const text = level >= 3 ? clipText(reply.text, 1500, redact) : redact(reply.text);
    lines.push(`The agent's last reply (L${reply.line}):
${text}${level >= 3 && text.endsWith("\u2026") ? ` (rest at L${reply.line})` : ""}`);
  }
  if (added) lines.push(`When saving, the user added (L${save}): ${redact(added)}`);
  return lines.join("\n\n");
}
var RECENT_ANSWERS = 20;
var RECOMMENDED = /\s*\(Recommended\)\s*$/i;
var OUTCOME = {
  "app-closed": "the app closed before an answer",
  declined: "declined to answer",
  unanswered: "closed without answering",
  open: "still open when saved",
  failed: "no answer was recorded",
  unread: "no answer was recorded"
};
function answerText(q, redact) {
  const a = q.answer;
  if (a.outcome !== "answered") return OUTCOME[a.outcome];
  const items = a.items.map((it) => {
    if (!it.picked) return `wrote: ${redact(it.text)}`;
    const label = it.text.replace(RECOMMENDED, "");
    if (label !== it.text) return `took the agent's recommendation "${redact(label)}"`;
    const desc = q.options.find((o) => o.label === it.text)?.description;
    return `picked "${redact(label)}"${desc && label.split(/\s+/).length <= 3 ? ` (${redact(desc)})` : ""}`;
  });
  return `${items.join("; ")}${a.notes ? ` \xB7 notes: ${redact(a.notes)}` : ""}`;
}
function imageExt(mediaType) {
  const sub = (mediaType.toLowerCase().split("/")[1] ?? "").split("+")[0].replace(/[^a-z0-9]/g, "");
  return sub === "jpeg" ? "jpg" : sub || "img";
}
var KIND = { agent: "subagent", command: "background command", workflow: "workflow" };
var STATE = {
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
  running: "still running when saved",
  "no record": "lost track of when the app restarted",
  "not started": "never started"
};
var FILLER = /^(?:done|finished|completed?|ok)[.!]?$|^I(?:'ve| have) (?:completed|finished)\b|^here(?: is|'s) (?:the|my) (?:report|summary|findings)\b|^[-*_]{3,}$/i;
function firstRealLine(report) {
  for (const raw of report.split("\n")) {
    if (raw.trim().startsWith("#")) continue;
    const line = raw.replace(/^[>*\-\s]+/, "").replace(/\*\*/g, "").trim();
    if (line && !FILLER.test(line) && !/^`?[~/.][^\s`]*`?$/.test(line)) return line;
  }
  return "";
}
function helperLines(ex, redact, level) {
  const clip = (t, n) => clipText(t, n, redact);
  const groups = [];
  const latest = /* @__PURE__ */ new Map();
  for (const h of ex.helpers) {
    const k = `${h.kind}:${h.what}`;
    const prev = latest.get(k);
    const last = prev?.[prev.length - 1];
    if (prev && last && last.ended !== "finished" && last.ended !== "running") {
      prev.push(h);
      continue;
    }
    const group = [h];
    groups.push(group);
    latest.set(k, group);
  }
  const out = groups.map((tries) => {
    const h = tries[tries.length - 1];
    const earlier = tries.slice(0, -1);
    let line = `- L${h.line} ${KIND[h.kind]} "${redact(h.what)}": ${STATE[h.ended]}`;
    if (h.how && h.ended !== "finished" && h.ended !== "running") line += ` (${clip(h.how, 200)})`;
    if (earlier.length) line += ` (after ${earlier.length} ${earlier.every((e) => e.ended === "failed") ? "failed" : "earlier"} tr${earlier.length === 1 ? "y" : "ies"})`;
    const first = h.report ? firstRealLine(h.report) : "";
    if (first && level < 2) line += `. Report starts: "${clip(first, 150)}"`;
    if (h.lastWords) line += ` \xB7 last words: "${clip(h.lastWords, 300)}"`;
    if (h.files?.length) line += ` \xB7 changed: ${h.files.slice(0, 5).map(redact).join(", ")}${h.files.length > 5 ? ` (+${h.files.length - 5} more)` : ""}`;
    if (h.branch) line += ` \xB7 worked on branch \`${h.branch}\``;
    if (h.started?.length) line += ` \xB7 started: ${h.started.map(redact).join(", ")}`;
    if (h.transcript) line += ` \xB7 ${h.ended === "finished" ? "full report" : "transcript"}: ${h.transcript}`;
    return line;
  });
  for (const s of ex.scheduled) out.push(`Still scheduled: ${redact(s.what)}`);
  return out.join("\n");
}
var indent = (text) => text.split("\n").map((l, k) => k === 0 || !l ? l : `  ${l}`).join("\n");
function messageLines(ex, redact, folder, level) {
  const out = [];
  let shown = 0;
  for (const t of [...ex.turns].reverse()) {
    const when = shortTime(t.at);
    const head = `- L${t.line}${when ? ` \xB7 ${when}` : ""}`;
    if (t.kind === "said") {
      if (t.text.startsWith("/delulu:handoff")) continue;
      const sent = t.how === "queued" ? ", sent while the agent worked" : "";
      const body = t.pasted ? `pasted ${t.pasted.text.split("\n").length} lines from ${t.pasted.source} (see the transcript), then wrote: ${t.typed ?? ""}` : t.text;
      const shots = (t.images ?? []).map((im, k) => ` \xB7 image: .delulu-handoff/${folder}/images/L${t.line}-${k + 1}.${imageExt(im.mediaType)}`).join("");
      out.push(`${head}${sent}: ${indent(redact(body))}${t.maybeApp ? " (may be the app's retry button)" : ""}${shots}`);
    } else if (t.kind === "asked") {
      for (const q of [...t.questions].reverse()) {
        const a = q.answer;
        const pick = a.outcome === "answered" && a.items.length === 1 && a.items[0].picked ? a.items[0].text : "";
        if (level >= 1 && shown++ >= RECENT_ANSWERS && pick) {
          const label = pick.replace(RECOMMENDED, "");
          out.push(`${head} \xB7 asked "${clipText(q.question, 90, redact)}": ${label !== pick ? `took the agent's recommendation "${redact(label)}"` : `picked "${redact(label)}"`}`);
        } else out.push(`${head} \xB7 asked "${redact(q.question)}": ${indent(answerText(q, redact))}`);
      }
    } else if (t.kind === "stopped") out.push(`${head} \xB7 ${t.appClosed ? "the app closed while the agent was working" : "stopped the agent"}`);
    else if (t.kind === "refused") out.push(`${head} \xB7 turned down ${t.tool}: ${redact(t.what)}`);
    else out.push(`${head} \xB7 another session (${t.from}) sent this, not the user: ${indent(redact(t.text))}`);
  }
  return out.join("\n");
}

// src/cli/save.ts
var KEEP = 15;
var STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
var stamp = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
function handoffFolders(base) {
  let names;
  try {
    names = readdirSync3(base);
  } catch {
    return [];
  }
  return names.filter((f) => STAMPED.test(f) && existsSync4(join5(base, f, "handoff.md"))).map((f) => {
    let t = 0;
    try {
      const s = statSync3(join5(base, f));
      t = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
    } catch {
    }
    return { f, t };
  }).sort((a, b) => a.t - b.t || (a.f < b.f ? -1 : 1)).map((x) => x.f);
}
function fail(message) {
  process.stdout.write(`delulu handoff: ${message}
`);
  process.exitCode = 1;
}
function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const k = argv.lastIndexOf(name);
    return k >= 0 ? argv[k + 1] : void 0;
  };
  const where = flag("--repo") ?? process.cwd();
  let repo;
  try {
    repo = repoKey(where);
  } catch {
    return fail(`not a readable folder: ${where}. Nothing was saved.`);
  }
  const ignored = keepOutOfGit(repo);
  const log = flag("--log") ?? resolveLog(repo, where);
  if (!log || !existsSync4(log)) return fail("could not find this session's transcript. Nothing was saved. Run it again with --log <path to the session .jsonl>.");
  let siblings = [];
  try {
    siblings = readdirSync3(dirname2(log)).filter((f) => f.endsWith(".jsonl")).map((f) => join5(dirname2(log), f));
  } catch {
  }
  const ex = extractSession(log, { siblings });
  if (!ex.turns.some((t) => t.kind === "said" || t.kind === "asked")) return fail("this session has no messages from the user yet, so there is nothing to hand off. Nothing was saved.");
  const base = join5(repo, ".delulu-handoff");
  try {
    if (lstatSync(base).isSymbolicLink()) return fail(".delulu-handoff is a link to somewhere else, so nothing was saved. Replace it with a plain folder.");
  } catch {
  }
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  const candidates = [...sid && /^[A-Za-z0-9-]{8,}$/.test(sid) ? [join5(base, `note-${sid}.md`)] : [], join5(base, "note.md")];
  let note = "";
  let notePath = candidates[0];
  for (const p of candidates) {
    try {
      if (statSync3(p).mtimeMs < (ex.startedAt ? Date.parse(ex.startedAt) : 0)) continue;
      note = readFileSync4(p, "utf8").trim();
      notePath = p;
      break;
    } catch {
    }
  }
  const typed = ex.turns.flatMap((t) => t.kind === "said" ? [...t.text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((m) => m[0]) : []);
  const redact = makeRedactor({ ownEmail: git(repo, ["config", "user.email"]), typedEmails: typed });
  const commit = git(repo, ["rev-parse", "--short", "HEAD"]);
  const branch = git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]) || (commit ? `detached at ${commit}` : void 0);
  const dirty = uncommitted(repo);
  const since = ex.startedAt ? git(repo, ["log", `--since=${ex.startedAt}`, "--format=%h%x09%s", "-n", "30"]) : void 0;
  const commits = (since ?? "").split("\n").filter(Boolean).map((l) => {
    const [sha, ...rest] = l.split("	");
    return { sha, subject: rest.join("	") };
  });
  mkdirSync(base, { recursive: true, mode: 448 });
  chmodSync(base, 448);
  const now = /* @__PURE__ */ new Date();
  let folder = stamp(now);
  for (let n = 2; ; n++) {
    try {
      mkdirSync(join5(base, folder), { mode: 448 });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      folder = `${stamp(now)}-${n}`;
    }
  }
  const out = renderHandoff({
    project: basename3(repo),
    savedAt: now,
    transcript: log.replace(homedir3(), "~"),
    folder,
    ex,
    note: note || void 0,
    redact,
    repo: { branch, commit, uncommitted: dirty, commits }
  });
  writeFileSync2(join5(base, folder, "handoff.md"), out, { mode: 384 });
  const missed = writeImages(join5(base, folder), ex);
  if (note) rmSync(notePath, { force: true });
  const lines = [`delulu saved this session: .delulu-handoff/${folder}/handoff.md (about ${(Buffer.byteLength(out) / 2500).toFixed(1)}k tokens)`];
  if (!note) lines.push(`No summary was written, so the next session gets the session without one, and no older handoff was removed. Write ${notePath.replace(`${repo}/`, "")} and save again to add it.`);
  if (ignored) lines.push(ignored);
  if (missed) lines.push(`${missed} image(s) could not be saved.`);
  const pruned = note ? prune(base, folder) : "";
  if (pruned) lines.push(pruned);
  lines.push("In a fresh session, type /delulu:resume to carry on.");
  process.stdout.write(`${lines.join("\n")}
`);
}
function prune(base, keep) {
  const older = handoffFolders(base).filter((f) => f !== keep);
  const gone = older.slice(0, Math.max(0, older.length - (KEEP - 1)));
  for (const f of gone) {
    try {
      rmSync(join5(base, f), { recursive: true, force: true });
    } catch {
    }
  }
  return gone.length ? `Removed ${gone.length} old handoff(s), keeping the newest ${KEEP}.` : "";
}
function writeImages(folder, ex) {
  let missed = 0;
  for (const t of ex.turns) {
    if (t.kind !== "said" || !t.images?.length) continue;
    t.images.forEach((im, k) => {
      try {
        mkdirSync(join5(folder, "images"), { recursive: true, mode: 448 });
        writeFileSync2(join5(folder, "images", `L${t.line}-${k + 1}.${imageExt(im.mediaType)}`), Buffer.from(im.data, "base64"), { mode: 384 });
      } catch {
        missed++;
      }
    });
  }
  return missed;
}
try {
  if (isProgram(import.meta.url)) main();
} catch (e) {
  fail(`could not save (${e instanceof Error ? e.message : "unknown error"}). Check .delulu-handoff/ before assuming nothing was written.`);
}
