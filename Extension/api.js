// Talks to the Node server (backend/server.js) that runs your checker, plus small helpers
// for building the panel's HTML.

const SERVER = "http://127.0.0.1:5050"; // keep in sync with PORT in backend/server.js
const NATIVE_HOST = "com.marking_assistant.server"; // keep in sync with HOST_NAME in backend/setup.js
const SETUP_COMMAND = "node backend/setup.js";
const START_COMMAND = "node backend/server.js";

let starting = null; // shared while a start is in progress, so two requests don't both start it

// Always resolves, never throws: { ok: true, ...body } or { ok: false, offline?, error }.
// If the server isn't running, it asks Chrome to start it first.
async function api(path, body) {
  const res = await request(path, body);
  if (!res.offline) return res;
  starting ??= startServer().finally(() => (starting = null));
  return (await starting) ? request(path, body) : res;
}

// body: an object (sent as JSON), or a Blob, a file's bytes.
async function request(path, body) {
  const bytes = body instanceof Blob;
  const options = body
    ? { method: "POST", headers: { "Content-Type": bytes ? "application/octet-stream" : "application/json" }, body: bytes ? body : JSON.stringify(body) }
    : undefined;
  let res;
  try {
    res = await fetch(SERVER + path, options);
  } catch {
    return { ok: false, offline: true, error: "The Python server isn't running." };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ...data, ok: false, error: data.error ?? `The server answered ${res.status}.` };
  return { ok: true, ...data };
}

// Chrome runs backend/native-host.js, which starts the server in the background.
// This only works once `node backend/setup.js` has told Chrome about it.
async function startServer() {
  if (!globalThis.chrome?.runtime?.sendNativeMessage) return false;
  try {
    const reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "start" });
    if (!reply?.ok) return false;
  } catch {
    return false; // setup hasn't been run
  }
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(SERVER + "/health")).ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// Builds DOM without innerHTML, since much of what we show comes from web pages and scripts.
// h("p", { class: "x", onclick: fn }, "text", childNode, null)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...present(children));
  return el;
}

// Replaces el's children, skipping the null/false that `cond && h(...)` leaves behind.
function fill(el, ...children) {
  el.replaceChildren(...present(children));
}

const present = (children) => children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== "");

// An error box. When the server is off, it also says how to start it.
function problemNote(res) {
  return h(
    "div",
    { class: `notice ${res.tone ?? "bad"}`, role: "alert" },
    h("p", {}, res.error),
    res.offline && [
      h("p", {}, "To have it start by itself, run this once in a terminal in the Extension folder:"),
      h("code", { class: "cmd" }, SETUP_COMMAND),
      h("p", { class: "muted" }, "Already did? Start it yourself with ", h("code", {}, START_COMMAND), " and check backend/server.log."),
    ],
  );
}

function showServerStatus(el, state, text) {
  el.dataset.state = state; // checking | on | warn | off (styles.css colours the dot)
  el.querySelector(".status-text").textContent = text;
}
