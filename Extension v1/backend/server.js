// The Marking Feedback Assistant's server. When you press Start in the panel, it:
//   1. receives each file the panel fetched from the Classroom page and saves it in the
//      folder your marking code reads (FILES_FOLDER in popup.js), turning PDFs into page images,
//   2. runs your marking code (CHECKER in popup.js),
//   3. deletes the student's photos it was given (privacy), then lists the PDFs it made (in
//      PDF_FOLDER) and splits each page's feedback into questions for the panel.
// Start it with `node backend/server.js` (or let Chrome start it, see setup.js). Only Node's
// built-in modules are used, so there is nothing to npm install.

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PORT = Number(process.env.PORT) || 5050; // keep in sync with SERVER in api.js
const HOST = "127.0.0.1";
const SCRIPTS_DIR = path.join(__dirname, "scripts");
const PDF_TOOLS = path.join(__dirname, "pdf_tools.py");
const TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS) || 15 * 60_000; // marking every page with AI takes a while
const MAX_BODY = 2 * 1024 * 1024; // page text is capped by the popup, so this is generous
const MAX_FILE = 60 * 1024 * 1024; // phone photos and scanned PDFs can be big
const MAX_OUTPUT = 1024 * 1024;

const PYTHON = findPython();
const PYTHON_VERSION = pythonVersion();

// Only the extension, and command-line tools like curl (which send no Origin), may call
// this server. Websites can't: otherwise any page you visit could run Python on your computer.
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const originAllowed = (origin) => !origin || origin.startsWith("chrome-extension://") || EXTRA_ORIGINS.includes(origin);
// Checking Host as well stops DNS-rebinding tricks that point another domain at 127.0.0.1.
const hostAllowed = (host) => [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host);

// Prefer a virtualenv next to (or above) this folder, so your script can import the
// packages installed there. Set PYTHON=/path/to/python to choose one yourself.
function findPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const exe = process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python");
  let dir = __dirname;
  for (let i = 0; i < 4; i++) {
    for (const venv of [".venv", "venv"]) {
      const candidate = path.join(dir, venv, exe);
      if (fs.existsSync(candidate)) return candidate;
    }
    dir = path.dirname(dir);
  }
  return process.platform === "win32" ? "python" : "python3";
}

function pythonVersion() {
  const out = spawnSync(PYTHON, ["--version"], { encoding: "utf8" });
  return out.status === 0 ? (out.stdout || out.stderr).trim() : null;
}

// CHECKER is a file name in backend/scripts/ (e.g. "main.py") or a full path.
function checkerPath(file) {
  if (typeof file !== "string" || !file.trim()) {
    throw httpError(400, "No checker file is set yet. Type its name into CHECKER at the top of popup.js.");
  }
  const full = path.resolve(SCRIPTS_DIR, file.trim());
  if (!full.endsWith(".py")) throw httpError(400, `${file} isn't a Python file. CHECKER should name a .py file.`);
  if (!fs.existsSync(full)) throw httpError(404, `Can't find ${full}. Check CHECKER at the top of popup.js.`);
  return full;
}

function runPython(file, input, args = []) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, durationMs: Date.now() - started, ...extra });
    };

    // Run from the script's own folder so relative paths inside it behave as they would in a terminal.
    const child = spawn(PYTHON, [file, ...args], {
      cwd: path.dirname(file),
      // Keeps Python from writing __pycache__ folders into the extension.
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on("error", (err) => finish({ exitCode: null, startError: err.message }));
    child.on("close", (code) => finish({ exitCode: code }));

    child.stdin.on("error", () => {}); // fine if the script never reads its input
    child.stdin.end(JSON.stringify(input));
  });
}

// The script should print one JSON object. If it printed other lines first, the last line
// is tried as JSON too. Anything else is shown as plain text.
function parseOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  const asObject = (s) => {
    try {
      const value = JSON.parse(s);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const obj = asObject(text) ?? asObject(text.split("\n").at(-1));
  return normalize(obj ?? { feedback: text });
}

// Accept a few common spellings so scripts don't have to match the popup exactly.
const KEYS = {
  feedback: ["feedback", "comment", "comments", "message"],
  summary: ["summary"],
  checks: ["checks", "criteria", "rubric"],
};

function normalize(obj) {
  const pick = (names) => names.map((k) => obj[k]).find((v) => v !== undefined && v !== null && v !== "");
  const text = (v) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));
  const checks = pick(KEYS.checks);

  return {
    feedback: text(pick(KEYS.feedback)),
    summary: text(pick(KEYS.summary)),
    checks: Array.isArray(checks)
      ? checks.map((c) =>
          typeof c === "string"
            ? { label: c, passed: null, detail: "" }
            : {
                label: String(c.label ?? c.name ?? c.check ?? ""),
                passed: typeof (c.passed ?? c.ok ?? c.pass) === "boolean" ? (c.passed ?? c.ok ?? c.pass) : null,
                detail: String(c.detail ?? c.note ?? c.message ?? ""),
              },
        )
      : [],
  };
}

let markingSince = null; // when the marking code started, while it's running

async function handleRun(body) {
  const file = checkerPath(body.file);
  const name = path.basename(file);
  if (markingSince) throw httpError(409, stillMarking());
  log(`Running ${name}`);
  markingSince = Date.now();
  const run = await runPython(file, body.input ?? {}); // never throws: failures come back in `run`
  markingSince = null;
  log(`${name} finished: exit code ${run.exitCode ?? "none"} after ${Math.round(run.durationMs / 1000)}s${run.timedOut ? " (stopped: too slow)" : ""}`);
  if (run.exitCode !== 0 && run.stderr.trim()) log(`${name} said:\n${run.stderr.trim().split("\n").slice(-15).join("\n")}`);
  // For the students' privacy, their photos are deleted once marking is over, even if it
  // failed: they can always be fetched again from Classroom.
  if (body.cleanup) deletePhotos(body.file, body.cleanup);
  const base = { file, durationMs: run.durationMs, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };

  if (run.startError) {
    return { ...base, ok: false, error: `Couldn't start Python (${PYTHON}). Install Python 3, or start the server with PYTHON=/path/to/python.` };
  }
  if (run.timedOut) {
    return { ...base, ok: false, error: `${name} was stopped after ${TIMEOUT_MS / 1000} seconds. Set RUN_TIMEOUT_MS to allow longer.` };
  }
  if (run.exitCode !== 0) {
    return { ...base, ok: false, error: `${name} stopped with an error (exit code ${run.exitCode}).` };
  }
  return { ...base, ok: true, result: parseOutput(run.stdout) };
}

// ---- The student's files ----

// A folder next to the marking code, such as "scans" or "PDFs". Created if it's missing.
function programFolder(checker, folder) {
  if (typeof folder !== "string" || !folder.trim() || path.isAbsolute(folder) || folder.split(/[\\/]/).includes("..")) {
    throw httpError(400, `"${folder}" should be a folder name next to your marking code, like "scans".`);
  }
  const dir = path.join(path.dirname(checkerPath(checker)), folder.trim());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "file";

// "name.jpg", or "name (2).jpg" if that's taken.
function freeName(dir, base, ext) {
  for (let n = 1; ; n++) {
    const name = `${base}${n > 1 ? ` (${n})` : ""}${ext}`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.copyFileSync(from, to); // across disks
    fs.unlinkSync(from);
  }
}

// What a file really is, from its first bytes (Chrome's file names can't be trusted).
function fileType(file) {
  const head = Buffer.alloc(512);
  const fd = fs.openSync(file, "r");
  const n = fs.readSync(fd, head, 0, 512, 0);
  fs.closeSync(fd);
  const b = head.subarray(0, n);
  const text = b.toString("latin1");
  if (text.startsWith("%PDF")) return "pdf";
  if (b[0] === 0xff && b[1] === 0xd8) return ".jpg";
  if (text.startsWith("\x89PNG")) return ".png";
  if (text.startsWith("GIF8")) return ".gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return ".webp";
  if (/^ftyp(heic|heix|hevc|mif1|msf1)/.test(text.slice(4, 12))) return "heic";
  if (/<(!doctype|html)/i.test(text)) return "html";
  return null;
}

// Saves one received file into `dir` as "<name>.<type>". PDFs become one image per page.
// `from` is a temporary copy, which is moved or deleted.
async function saveFile(from, rawName, dir) {
  const base = safeName(String(rawName ?? "file").replace(/\.\w{2,5}$/, ""));
  const type = fileType(from);

  if (type === "html") {
    fs.unlinkSync(from);
    throw httpError(422, "Google sent a web page instead of the file. Check you can open it from Classroom.");
  }
  if (type === "pdf") {
    // Two attachments with the same name mustn't overwrite each other's pages.
    let name = base;
    for (let n = 2; fs.existsSync(path.join(dir, `${name}.png`)) || fs.existsSync(path.join(dir, `${name} p1.png`)); n++) {
      name = `${base} (${n})`;
    }
    const run = await runPython(PDF_TOOLS, {}, ["pages", from, dir, name]);
    fs.unlinkSync(from);
    if (run.exitCode !== 0) throw httpError(500, `Couldn't turn the PDF into images: ${run.stderr.trim().split("\n").at(-1)}`);
    return JSON.parse(run.stdout);
  }
  if (type === "heic") {
    // iPhone photos. macOS's built-in sips turns them into JPEGs the marking code can open.
    const name = freeName(dir, base, ".jpg");
    const out = spawnSync("sips", ["-s", "format", "jpeg", from, "--out", path.join(dir, name)], { encoding: "utf8" });
    fs.unlinkSync(from);
    if (out.status !== 0) throw httpError(422, "This is an iPhone (HEIC) photo, and it couldn't be turned into a JPEG.");
    return [name];
  }
  if (!type) {
    fs.unlinkSync(from);
    throw httpError(422, "Only photos, PDFs and Google Docs can be marked.");
  }
  const name = freeName(dir, base, type);
  moveFile(from, path.join(dir, name));
  return [name];
}

// Called when you press Start: files left in the folder from an earlier run are moved into
// old/, so they aren't marked (and paid for) again with this student's.
function stillMarking() {
  const seconds = Math.round((Date.now() - markingSince) / 1000);
  return `The last Start is still marking (for ${seconds}s so far). Wait for it to finish, then press Start again.`;
}

// Deletes the named files (the photos saved for this run) from each folder: where they were
// put for marking, and where the marking code moves them afterwards.
function deletePhotos(checker, { folders = [], names = [] }) {
  let deleted = 0;
  try {
    for (const folder of folders) {
      const dir = programFolder(checker, folder);
      for (const name of names) {
        const file = path.join(dir, path.basename(String(name)));
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          deleted++;
        }
      }
    }
    log(`Deleted ${deleted} original photo(s) for privacy`);
  } catch (err) {
    log(`Couldn't delete the photos after marking: ${err.message}`);
  }
}

function startFiles(body) {
  if (markingSince) throw httpError(409, stillMarking());
  const dir = programFolder(body.checker, body.folder);
  const leftovers = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith("."));
  if (leftovers.length) {
    const old = path.join(dir, "old");
    fs.mkdirSync(old, { recursive: true });
    for (const e of leftovers) {
      const ext = path.extname(e.name);
      moveFile(path.join(dir, e.name), path.join(old, freeName(old, path.basename(e.name, ext), ext)));
    }
  }
  log(`Start: ${leftovers.length} earlier file(s) moved to ${path.join(body.folder, "old")}`);
  return { ok: true, folder: dir, movedToOld: leftovers.length };
}

// One file the panel fetched from Google, sent as raw bytes.
async function receiveFile(req, query) {
  const dir = programFolder(query.checker, query.folder);
  const tmp = path.join(os.tmpdir(), `marking-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, await readBytes(req));
  try {
    const saved = await saveFile(tmp, query.name, dir);
    log(`Saved "${query.name}" as ${saved.join(", ")}`);
    return { ok: true, saved };
  } catch (err) {
    log(`Couldn't save "${query.name}": ${err.message}`);
    throw err;
  }
}

// ---- The PDFs the marking code made ----

function listPdfs(body) {
  const dir = programFolder(body.checker, body.folder);
  const since = Number(body.since) || 0;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .map((name) => ({ name, modified: fs.statSync(path.join(dir, name)).mtimeMs }))
    .filter((f) => f.modified >= since)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  log(`Found ${files.length} new PDF(s) in ${body.folder}`);
  return { ok: true, folder: dir, files };
}

function pdfPath(query) {
  const name = String(query.name ?? "");
  if (!name.toLowerCase().endsWith(".pdf") || path.basename(name) !== name) throw httpError(400, "That isn't a PDF name.");
  const file = path.join(programFolder(query.checker, query.folder), name);
  if (!fs.existsSync(file)) throw httpError(404, `${name} isn't there any more.`);
  return file;
}

function sendPdf(res, query) {
  const file = pdfPath(query);
  res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
  fs.createReadStream(file).pipe(res);
}

// One page's feedback split into questions. feedback.py saves it as scanMD/<page>F.json
// straight from its dictionaries; pages marked before that only have the markdown
// (scanMD/<page>F.md, which the PDF is made from), so that is split instead.
function readQuestions(body) {
  const pdf = String(body.pdf ?? "");
  if (!pdf.toLowerCase().endsWith(".pdf") || path.basename(pdf) !== pdf) throw httpError(400, "That isn't a PDF name.");
  const dir = programFolder(body.checker, body.folder);
  const stem = pdf.slice(0, -4);

  const json = path.join(dir, `${stem}F.json`);
  if (fs.existsSync(json)) {
    const data = JSON.parse(fs.readFileSync(json, "utf8"));
    return {
      ok: true,
      resubmit: Boolean(data.resubmit),
      title: String(data.problem ?? ""),
      questions: (data.questions ?? []).map((q) => ({ label: `Question ${q.question}`, work: String(q.work ?? ""), feedback: String(q.feedback ?? "").trim() })),
    };
  }
  const markdown = [`${stem}F.md`, `${stem}.md`].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
  if (!markdown) throw httpError(404, `There's no feedback for ${pdf} in ${body.folder}/.`);
  return { ok: true, ...parseFeedback(fs.readFileSync(markdown, "utf8")) };
}

// # Problem Pack: <title>
// ## Question 6
// <problem and student work>
// ### Feedback
// <feedback, empty when the answer was right>
// A page that couldn't be read is just "Resubmit".
function parseFeedback(markdown) {
  const text = markdown.replace(/\r/g, "");
  if (/^\s*resubmit\s*$/i.test(text)) return { resubmit: true, title: "", questions: [] };
  const title = text.match(/^# (?:Problem Pack:\s*)?(.+)$/m)?.[1]?.trim() ?? "";
  const questions = text
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const [heading, ...rest] = part.split("\n");
      const [work, feedback = ""] = rest.join("\n").split(/^###\s*Feedback\s*:?\s*$/im);
      return { label: heading.trim(), work: work.trim(), feedback: feedback.trim() };
    });
  return { resubmit: false, title, questions };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Each line also goes to server.log when Chrome started the server.
function log(message) {
  console.log(`[${new Date().toLocaleString()}] ${message}`);
}

function readBytes(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers["content-type"]).startsWith("application/octet-stream")) {
      return reject(httpError(415, "Send the file's bytes."));
    }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_FILE) {
        reject(httpError(413, "That file is over 60 MB."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers["content-type"]).startsWith("application/json")) {
      return reject(httpError(415, "Send JSON."));
    }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(httpError(413, "That request is too big."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(httpError(400, "That wasn't valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!hostAllowed(req.headers.host) || !originAllowed(origin)) {
    return send(res, 403, { error: "Only the Marking Feedback Assistant extension can use this server." });
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    });
    return res.end();
  }

  const route = `${req.method} ${new URL(req.url, `http://${HOST}`).pathname}`;
  try {
    switch (route) {
      case "GET /health":
        return send(res, 200, { ok: true, python: PYTHON, pythonVersion: PYTHON_VERSION });
      case "POST /checker":
        return send(res, 200, { ok: true, file: checkerPath((await readJson(req)).file), python: PYTHON, pythonVersion: PYTHON_VERSION });
      case "POST /run":
        return send(res, 200, await handleRun(await readJson(req)));
      case "POST /note": // something the panel wants in the log, like a file Google wouldn't send
        log(String((await readJson(req)).message ?? "").slice(0, 500));
        return send(res, 200, { ok: true });
      case "POST /files/start":
        return send(res, 200, startFiles(await readJson(req)));
      case "POST /file":
        return send(res, 200, await receiveFile(req, Object.fromEntries(new URL(req.url, `http://${HOST}`).searchParams)));
      case "POST /pdfs":
        return send(res, 200, listPdfs(await readJson(req)));
      case "POST /questions":
        return send(res, 200, readQuestions(await readJson(req)));
      case "GET /pdf":
        return sendPdf(res, Object.fromEntries(new URL(req.url, `http://${HOST}`).searchParams));
      default:
        return send(res, 404, { error: `Nothing at ${route}.` });
    }
  } catch (err) {
    if (!err.status) console.error(err);
    send(res, err.status ?? 500, { error: err.message });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Is the server already running in another window?`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Marking assistant server is running at http://${HOST}:${PORT}`);
  console.log(`  Python:  ${PYTHON} (${PYTHON_VERSION ?? "not found: install Python 3 or set PYTHON"})`);
  console.log(`  Marking code lives in ${SCRIPTS_DIR}`);
  console.log("Leave this window open while you mark. Press Ctrl+C to stop.");
});
