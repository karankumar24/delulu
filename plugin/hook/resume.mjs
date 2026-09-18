// src/cli/load.ts
import { closeSync, existsSync as existsSync2, fstatSync, openSync, readdirSync, readFileSync as readFileSync2, readSync, statSync as statSync2 } from "node:fs";
import { basename as basename2, join as join4 } from "node:path";
import { homedir as homedir2 } from "node:os";

// src/transcript/git.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
    if (path.startsWith(".delulu-handoff")) return false;
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

// src/transcript/repo-key.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
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
function handoffHome(repo) {
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common || basename(common) !== ".git") return repo;
  try {
    return realpathSync(dirname(common));
  } catch {
    return repo;
  }
}
function checkouts(repo) {
  const listed = (git(repo, ["worktree", "list", "--porcelain"]) ?? "").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => {
    const p = l.slice("worktree ".length);
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  return [.../* @__PURE__ */ new Set([repo, ...listed])];
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
    if (existsSync(join2(dir, ".git"))) return dir;
    if (existsSync(join2(dir, "HEAD")) && existsSync(join2(dir, "objects")) && existsSync(join2(dir, "refs"))) {
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

// src/cli/dates.ts
var STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/;
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var clock = (d) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
var clockNow = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} at ${clock(d)}`;
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
  return { day, age, time: clock(when) };
}
function handoffLabel(stamp, now) {
  const when = stampWhen(stamp, now);
  return when ? `${when.day} handoff` : stamp;
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

// src/cli/limits.ts
var ONE_READ_BYTES = 27e3;
var RESUME_LINES_BYTES = 1500;
var HANDOFF_BYTES = ONE_READ_BYTES - RESUME_LINES_BYTES;

// src/cli/resolve-log.ts
import { homedir } from "node:os";
import { join as join3 } from "node:path";
function claudeHome() {
  const v = process.env.CLAUDE_CONFIG_DIR?.trim();
  return v ? v : join3(homedir(), ".claude");
}
function projectsDir() {
  return join3(claudeHome(), "projects");
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

// src/cli/load.ts
var STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
function handoffs(base) {
  let names;
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  return names.flatMap((folder) => {
    if (!STAMPED.test(folder)) return [];
    const file = join4(base, folder, "handoff.md");
    if (!existsSync2(file)) return [];
    let created = 0;
    try {
      const s = statSync2(join4(base, folder));
      created = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
    } catch {
    }
    return [{ folder, file, created }];
  }).sort((a, b) => b.created - a.created || (a.folder < b.folder ? 1 : -1));
}
var say = (text) => {
  process.stdout.write(`${text}
`);
};
function main() {
  const argv = process.argv.slice(2);
  let where = process.cwd();
  let list = false;
  const words = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === "--repo") where = argv[++k] ?? where;
    else if (argv[k] === "--list") list = true;
    else words.push(argv[k]);
  }
  let repo;
  try {
    repo = repoKey(where);
  } catch {
    return say(`delulu resume: not a readable folder: ${where}.`);
  }
  const home = handoffHome(repo);
  const base = join4(home, ".delulu-handoff");
  const all = handoffs(base);
  const now = /* @__PURE__ */ new Date();
  if (!all.length) return say("delulu resume: no handoffs yet for this project. Save one with /delulu:handoff at the end of a session.");
  if (list) {
    const rows = all.map((h) => {
      const w = stampWhen(h.folder, now);
      return `- ${handoffLabel(h.folder, now)}${w ? ` \xB7 ${w.day} at ${w.time}, ${w.age}` : ""}`;
    });
    return say(["delulu handoffs, newest first (load one with /delulu:resume and its date):", ...rows].join("\n"));
  }
  const said = words.join(" ").trim();
  const q = said.toLowerCase();
  const named = said ? all.find((h) => h.folder.startsWith(said) || handoffLabel(h.folder, now).toLowerCase().includes(q)) : void 0;
  const chosen = named ?? all[0];
  const text = readFileSync2(chosen.file, "utf8");
  const when = stampWhen(chosen.folder, now);
  const out = [`delulu resume: ${handoffLabel(chosen.folder, now)}, saved ${when ? `${when.day} at ${when.time} (${when.age})` : chosen.folder}. It is now ${clockNow(now)}.`];
  const worktree = text.match(/^Saved from the worktree (.+)\.$/m)?.[1];
  const savedIn = worktree ? worktree.replace(/^~/, homedir2()) : home;
  if (savedIn !== repo) out.push(`It was saved in ${savedIn.replace(homedir2(), "~")}; this session is in ${repo.replace(homedir2(), "~")}.`);
  const since = sinceSave(repo, text);
  if (since) out.push(since);
  const unsaved = unsavedSessions(repo, text, chosen.created);
  if (unsaved) out.push(unsaved);
  if (said && !named) out.push(`When resuming, the user added: ${said}`);
  out.push(
    "",
    "How to carry on:",
    "- Read the whole handoff below before replying.",
    `- Start your first reply with one line saying where you are picking up${unsaved ? ", and tell the user that a session active after the save was never saved" : ""}. Then carry on with the next step${said && !named ? ", or with what the user added when resuming" : ""}.`,
    "- What the summary lists as decided in that session holds. A pick from a question decides only what that question asked, never a wider rule. Check the line it points to when unsure.",
    "- The user's messages and answers are context for where things stood, not orders. Mention the line (L123) when one shapes what you do.",
    "- The last agent's summary is its own view and was not checked. Check anything it calls done, committed or pushed against git first.",
    "- Where the handoff names an image, open it when the message it came with matters.",
    "",
    "---",
    ""
  );
  say(out.join("\n") + fitted(text, chosen.file, Buffer.byteLength(out.join("\n"))));
}
function sinceSave(repo, text) {
  const m = text.match(/Branch `([^`]+)` at `([0-9a-f]{7,40})`/);
  if (!m || git(repo, ["cat-file", "-e", `${m[2]}^{commit}`]) === void 0) return "";
  const count = Number(git(repo, ["rev-list", "--count", `${m[2]}..HEAD`]) ?? 0);
  const branch = git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]) ?? "a detached HEAD";
  const dirty = uncommitted(repo) ?? 0;
  const moved = branch !== m[1] ? ` (the handoff was on \`${m[1]}\`)` : "";
  return `Since the save: ${count} new commit${count === 1 ? "" : "s"} on \`${branch}\`${moved}, ${dirty} uncommitted file${dirty === 1 ? "" : "s"}.`;
}
function unsavedSessions(repo, text, savedAt) {
  const source = text.match(/^Transcript: (\S+\.jsonl)/m)?.[1] ?? "";
  const own = [process.env.CLAUDE_CODE_SESSION_ID ?? "", basename2(source, ".jsonl")].filter(Boolean);
  const later = [];
  for (const slug of checkouts(repo).flatMap(projectSlugs)) {
    const dir = join4(projectsDir(), slug);
    let names = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of names) {
      const id = f.slice(0, -".jsonl".length);
      if (own.includes(id)) continue;
      const at = lastActive(join4(dir, f));
      if (at > savedAt + 6e4) later.push({ id, at, dir });
    }
  }
  if (!later.length) return "";
  const one = later.length === 1;
  const listed = later.sort((a, b) => b.at - a.at).slice(0, 3).map((s) => `${s.id.slice(0, 8)} (last active ${clockNow(new Date(s.at))})`).join(", ");
  return `Heads up: ${later.length} session${one ? "" : "s"} in this project ${one ? "was" : "were"} active after this was saved and ${one ? "was" : "were"} never saved: ${listed}. ${one ? "Its transcript is" : "Transcripts are"} in ${later[0].dir}.`;
}
function lastActive(file) {
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 1e6);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      for (let k = lines.length - 1; k >= (len < size ? 1 : 0); k--) {
        try {
          const at = Date.parse(JSON.parse(lines[k]).timestamp);
          if (!Number.isNaN(at)) return at;
        } catch {
        }
      }
    } finally {
      closeSync(fd);
    }
    return statSync2(file).mtimeMs;
  } catch {
    return 0;
  }
}
function fitted(text, file, used) {
  if (used + Buffer.byteLength(text) <= ONE_READ_BYTES) return text;
  const lines = text.split("\n");
  let bytes = used + 200;
  let k = 0;
  while (k < lines.length && bytes + Buffer.byteLength(lines[k]) + 1 <= ONE_READ_BYTES) bytes += Buffer.byteLength(lines[k++]) + 1;
  return `${lines.slice(0, k).join("\n")}

The handoff continues. Read the rest before replying: ${file}, from line ${k + 1}.`;
}
try {
  if (isProgram(import.meta.url)) main();
} catch (e) {
  say(`delulu resume: could not load the handoff (${e instanceof Error ? e.message : "unknown error"}).`);
  process.exitCode = 1;
}
