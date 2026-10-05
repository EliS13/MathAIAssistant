// Adds a "Scan with AI" button to Classroom while a student's work is open.
// Clicking it asks the Python server (functionality/server.py) to download that
// student's files and run them through the scan code, then shows its progress.

const IDLE_TEXT = "Scan with AI";

// The button lives in a shadow root so Classroom's CSS can't restyle it. Its look is in button.css.
const host = document.createElement("div");
const root = host.attachShadow({ mode: "closed" });
const style = Object.assign(document.createElement("link"), {
  rel: "stylesheet",
  href: chrome.runtime.getURL("button.css"),
});
const button = Object.assign(document.createElement("button"), { type: "button" });
const icon = Object.assign(document.createElement("span"), { className: "icon" });
const label = Object.assign(document.createElement("span"), { className: "label" });
label.setAttribute("aria-live", "polite");
button.append(icon, label);
root.append(style, button);

let busy = false;
let resetTimer = null;

// state is one of: idle, working, done, error (button.css styles each one)
function show(state, text) {
  button.dataset.state = state;
  button.setAttribute("aria-busy", state === "working");
  label.textContent = text;
  button.title = text;
}

async function send(msg) {
  try {
    return (await chrome.runtime.sendMessage(msg)) ?? { state: "error", message: "No answer from the extension." };
  } catch {
    return { state: "error", message: "The extension was reloaded. Refresh this page." };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

button.addEventListener("click", async () => {
  const context = parseClassroomUrl(location.href);
  if (busy || !context?.studentId) return;
  busy = true;
  clearTimeout(resetTimer);
  show("working", "Starting…");

  // The scan takes a while, so the server answers right away with a job and we poll it.
  let job = await send({ type: "scan:start", context });
  while (job.state === "queued" || job.state === "running") {
    show("working", job.message);
    await sleep(1500);
    job = await send({ type: "scan:status", id: job.id });
  }

  show(job.state, job.message);
  busy = false;
  resetTimer = setTimeout(() => show("idle", IDLE_TEXT), job.state === "done" ? 8000 : 12000);
});

// Classroom is a single-page app, so watch the URL instead of waiting for page loads.
// The button only shows when a student's submission is open (or while a scan is running).
function update() {
  if (!host.isConnected) document.body.append(host);
  host.hidden = !busy && !parseClassroomUrl(location.href)?.studentId;
}

show("idle", IDLE_TEXT);
update();
setInterval(update, 500);
