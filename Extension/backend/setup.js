// One-time setup so the extension starts the server by itself when you open the popup.
// Run it from a terminal, so it can see the Python you normally use:
//
//   node backend/setup.js           set up
//   node backend/setup.js remove    undo
//
// It registers native-host.js with Chrome as a "native messaging host": a program only this
// extension (see EXTENSION_ID) is allowed to ask Chrome to run. Chrome starts programs with a
// bare PATH, so the launcher it writes remembers your PATH and Python.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOST_NAME = "com.marking_assistant.server"; // keep in sync with NATIVE_HOST in api.js
const EXTENSION_ID = "pgejgkkgmbhhllpnfmcljjdclnkmehle"; // fixed by "key" in manifest.json

// NATIVE_HOSTS_DIR lets you point this at a test Chrome profile instead of your own.
const HOSTS_DIR =
  process.env.NATIVE_HOSTS_DIR ??
  {
    darwin: path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
    linux: path.join(os.homedir(), ".config/google-chrome/NativeMessagingHosts"),
  }[process.platform];

if (!HOSTS_DIR) {
  console.error("Automatic start is only set up for macOS and Linux. On Windows, start the server with: node backend/server.js");
  process.exit(1);
}

const manifestFile = path.join(HOSTS_DIR, `${HOST_NAME}.json`);
const launcherFile = path.join(HOSTS_DIR, `${HOST_NAME}.sh`);

if (process.argv[2] === "remove") {
  for (const file of [manifestFile, launcherFile]) fs.rmSync(file, { force: true });
  console.log("Removed. The extension won't start the server any more; run node backend/server.js yourself.");
  process.exit(0);
}

// The PATH copy of node (e.g. /opt/homebrew/bin/node) survives upgrades; process.execPath may not.
const node = findOnPath("node") ?? process.execPath;
const python = process.env.PYTHON ?? findPython();
if (!python) {
  console.error("Couldn't find python3. Install Python 3, or run: PYTHON=/path/to/python node backend/setup.js");
  process.exit(1);
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
fs.mkdirSync(HOSTS_DIR, { recursive: true });
fs.writeFileSync(
  launcherFile,
  [
    "#!/bin/sh",
    "# Written by Extension/backend/setup.js. Chrome runs this to start the marking server.",
    `export PATH=${quote(process.env.PATH)}`,
    `export PYTHON=${quote(python)}`,
    `exec ${quote(node)} ${quote(path.join(__dirname, "native-host.js"))}`,
    "",
  ].join("\n"),
  { mode: 0o755 },
);
fs.writeFileSync(
  manifestFile,
  JSON.stringify(
    {
      name: HOST_NAME,
      description: "Starts the Marking Feedback Assistant server",
      path: launcherFile,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  ) + "\n",
);

console.log("Done. Opening the popup now starts the server by itself.");
console.log(`  Python: ${python}`);
console.log(`  Server output goes to ${path.join(__dirname, "server.log")}`);
console.log("If the extension was already loaded, click its reload arrow in chrome://extensions.");
console.log("If you move the Extension folder or change Python, run this again.");

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

function findPython() {
  const out = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : null;
}
