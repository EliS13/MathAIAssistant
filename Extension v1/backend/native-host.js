// Chrome runs this when the popup can't reach the server, so you don't have to start it
// yourself. It starts server.js in the background, answers Chrome, and exits; the server
// keeps running until you log out or restart. `node backend/setup.js` tells Chrome about it.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 5050; // keep in sync with PORT in server.js
const SERVER = path.join(__dirname, "server.js");
const LOG = path.join(__dirname, "server.log");

// Chrome's native messaging format: a 4-byte little-endian length, then that much JSON.
function reply(message) {
  const json = Buffer.from(JSON.stringify(message));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  process.stdout.write(Buffer.concat([length, json]), () => process.exit(0));
}

function serverRunning() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function handle(message) {
  if (message?.type !== "start") return reply({ ok: false, error: "Unknown request." });
  if (await serverRunning()) return reply({ ok: true, started: false });

  // detached puts the server in its own process group, so it outlives this process and Chrome.
  const log = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, [SERVER], { cwd: path.dirname(__dirname), detached: true, stdio: ["ignore", log, log] });
  child.unref();
  reply({ ok: true, started: true });
}

let input = Buffer.alloc(0);
let handled = false;
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (handled || input.length < 4 || input.length < 4 + input.readUInt32LE(0)) return;
  handled = true;
  let message = null;
  try {
    message = JSON.parse(input.subarray(4, 4 + input.readUInt32LE(0)));
  } catch {}
  handle(message);
});
process.stdin.on("end", () => handled || process.exit(0));
