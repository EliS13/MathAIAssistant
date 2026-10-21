// The marking assistant in Chrome's side panel. It fills in the student and assignment from
// the page you're on (line 1 of its text is the assignment, line 2 the student) and lists the
// files attached to it. Start saves those files into the folder your marking code reads, runs
// the marking code, and shows the PDFs it makes. The panel stays open, so it reads the page
// again when you switch tab or student.
//
// Opened outside the extension (popup.html as a plain web page), it uses SAMPLE_PAGE and
// localStorage instead, so the layout can be previewed.

// Your marking code: a file name in backend/scripts/, or a full path. After changing any of
// these, click the extension's reload arrow in chrome://extensions.
const CHECKER = "main.py";
// Folders next to the marking code: where it reads the student's files, where it moves each
// photo once it's marked, where it writes each page's feedback (F.json and F.md), and its PDFs.
// After every run the photos are deleted from FILES_FOLDER and DONE_FOLDER, for privacy.
const FILES_FOLDER = "scans";
const DONE_FOLDER = "finishScan";
const FEEDBACK_FOLDER = "scanMD";
const PDF_FOLDER = "PDFs";

const IN_EXTENSION = Boolean(globalThis.chrome?.scripting);
const $ = (id) => document.getElementById(id);
const FIELDS = ["student", "assignment"];
const KIND_LABELS = { document: "Google Doc", presentation: "Google Slides", spreadsheets: "Google Sheet", drawings: "Google Drawing" };

let page = null; // what readPage() found on the tab
let draftKey = null; // storage key for this page's saved boxes, file choices and last run
let lastRun = null; // the last Start on this page: files saved, problems, the PDFs made
let typed = {}; // boxes you typed in, which the page must not overwrite
let skipped = new Set(); // IDs of files you unticked on this page
let reads = 0; // counts page reads, so a slow read can't overwrite a newer one
let busy = false; // a Start is in progress
let programProblem = null; // why Start can't run: no marking code set, file missing, server off

const storage = {
  async get(key) {
    if (IN_EXTENSION) return (await chrome.storage.local.get(key))[key];
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return undefined;
    }
  },
  async set(key, value) {
    if (IN_EXTENSION) return chrome.storage.local.set({ [key]: value });
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- The page: student, assignment and its files ----

async function loadPage() {
  const read = ++reads;
  const found = IN_EXTENSION ? await readActiveTab() : SAMPLE_PAGE;
  if (read !== reads) return;
  page = found;
  page.classroom = parseClassroomUrl(page.url);
  await loadDraft();
}

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
    if (injection?.result) return injection.result;
  } catch {}
  // A page Chrome won't let extensions read (chrome:// pages, the Web Store, sites other
  // than Classroom you haven't opened the panel on): nothing to fill in, but you can type.
  return { title: tab?.title ?? "", url: tab?.url ?? "", text: "", selection: "", headings: [], guess: {}, files: [] };
}

async function loadDraft() {
  draftKey = `draft:${page.url || "no-page"}`;
  const draft = (await storage.get(draftKey)) ?? {};
  typed = draft.typed ?? {};
  skipped = new Set(draft.skipped ?? []);
  for (const field of FIELDS) $(field).value = (!typed[field] && page.guess?.[field]) || draft[field] || "";
  lastRun = draft.lastRun ?? null;
  renderFiles();
  showResult();
}

function collect() {
  return Object.fromEntries(FIELDS.map((field) => [field, $(field).value]));
}

function saveDraft() {
  return storage.set(draftKey, { ...collect(), typed, skipped: [...skipped], lastRun, savedAt: Date.now() });
}

const fileLabel = (f, i) => f.name || `${KIND_LABELS[f.kind] ?? "Drive file"} ${i + 1}`;
const chosenFiles = () => (page?.files ?? []).filter((f) => !skipped.has(f.id));

function renderFiles() {
  const files = page?.files ?? [];
  $("start").disabled = busy || Boolean(programProblem) || chosenFiles().length === 0;
  if (files.length === 0) {
    return fill($("files"), h("p", { class: "muted" }, "No files on this page. Open a student's submission in Classroom."));
  }
  fill(
    $("files"),
    h(
      "ul",
      { class: "files" },
      files.map((f, i) =>
        h(
          "li",
          {},
          h(
            "label",
            {},
            h("input", {
              type: "checkbox",
              checked: !skipped.has(f.id),
              onchange: (e) => {
                if (e.target.checked) skipped.delete(f.id);
                else skipped.add(f.id);
                renderFiles();
                saveDraft();
              },
            }),
            h("span", { class: "file-label" }, fileLabel(f, i)),
            KIND_LABELS[f.kind] && f.name && h("span", { class: "muted" }, KIND_LABELS[f.kind]),
          ),
        ),
      ),
    ),
  );
}

// ---- Start: save the files, run the marking code, show the PDFs ----

// Shows which marking code Start runs, and keeps Start off until the server has found it.
async function findProgram() {
  $("program").textContent = CHECKER ? `Runs ${CHECKER}` : "No marking code set";
  if (!CHECKER) {
    programProblem = { tone: "warn", error: "Type your marking code's file name into CHECKER at the top of popup.js, then reload the extension." };
  } else {
    const res = await api("/checker", { file: CHECKER });
    programProblem = res.ok ? null : res;
    if (res.ok) $("program").title = res.file;
  }
  renderFiles();
  showResult();
}

const EXPORTS = { document: "export?format=pdf", presentation: "export/pdf", spreadsheets: "export?format=pdf", drawings: "export/pdf" };

// Drive files come as they are; Google Docs, Slides, Sheets and Drawings as PDFs.
function downloadUrl(f) {
  if (f.kind === "drive") return `https://drive.usercontent.google.com/download?id=${f.id}&export=download&confirm=t&authuser=${f.authuser}`;
  const exp = EXPORTS[f.kind];
  return `https://docs.google.com/${f.kind}/d/${f.id}/${exp}${exp.includes("?") ? "&" : "?"}authuser=${f.authuser}`;
}

// Fetches one file with your Google sign-in: the extension may use Drive and Docs (see
// host_permissions in manifest.json), so Chrome sends your Google cookies with the request.
// Nothing goes to your Downloads folder.
async function fetchFile(f) {
  let res;
  try {
    res = await fetch(downloadUrl(f), { credentials: "include" });
  } catch {
    throw new Error("Couldn't reach Google Drive. Check your internet connection.");
  }
  if (!res.ok) throw new Error(`Google answered ${res.status}${[401, 403, 404].includes(res.status) ? ": your account can't open this file" : ""}.`);
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error("Google sent a web page instead of the file. Check you can open it from Classroom.");
  }
  return res.blob();
}

async function startMarking() {
  if (!IN_EXTENSION) return fill($("result"), h("p", { class: "notice warn" }, "Saving files only works in the extension."));
  const key = draftKey;
  const files = chosenFiles();
  const student = $("student").value.trim();
  busy = true;
  renderFiles();
  // Only shows progress while you're still on the page being marked.
  const progress = (text) => key === draftKey && fill($("result"), h("p", { class: "running" }, h("span", { class: "spinner", "aria-hidden": "true" }), text));

  // 1. Clear out an earlier run's files, then fetch each file and hand it to the server,
  //    which saves it into FILES_FOLDER.
  const problems = [];
  const saved = { ok: true, saved: [] };
  const ready = await api("/files/start", { checker: CHECKER, folder: FILES_FOLDER });
  if (!ready.ok) Object.assign(saved, ready);
  for (const [i, f] of (ready.ok ? files : []).entries()) {
    progress(`Saving files… ${i + 1} of ${files.length}`);
    const name = student ? `${student} - ${fileLabel(f, i)}` : fileLabel(f, i);
    try {
      const bytes = await fetchFile(f).catch((err) => {
        api("/note", { message: `Couldn't get "${name}" from Google: ${err.message}` }); // for backend/server.log
        throw err;
      });
      const res = await api(`/file?${new URLSearchParams({ checker: CHECKER, folder: FILES_FOLDER, name })}`, bytes);
      if (!res.ok) throw new Error(res.error);
      saved.saved.push(...res.saved);
    } catch (err) {
      problems.push({ name, error: err.message });
    }
  }

  // 2. Run the marking code on them.
  let run = saved.ok ? null : saved;
  const started = Date.now();
  if (saved.ok && saved.saved.length) {
    const tick = () => progress(`Marking ${saved.saved.length} ${saved.saved.length === 1 ? "page" : "pages"}… ${Math.round((Date.now() - started) / 1000)}s (keep this open)`);
    tick();
    const ticker = setInterval(tick, 1000);
    run = await api("/run", {
      file: CHECKER,
      input: { ...collect(), files: saved.saved, page: { title: page.title, url: page.url, text: page.text } },
      cleanup: { folders: [FILES_FOLDER, DONE_FOLDER], names: saved.saved }, // the server deletes the photos afterwards
    });
    clearInterval(ticker);
  } else if (saved.ok) {
    run = { ok: false, error: "None of the files could be saved, so nothing was marked." };
  }

  // 3. The PDFs it made during this run.
  const pdfs = run?.stdout !== undefined ? await api("/pdfs", { checker: CHECKER, folder: PDF_FOLDER, since: started - 2000 }) : null;

  const result = {
    ok: Boolean(run?.ok),
    offline: run?.offline,
    error: run?.error,
    saved: saved.saved,
    problems,
    pdfs: pdfs?.ok ? pdfs.files : [],
    stdout: run?.stdout?.slice(-4000),
    stderr: run?.stderr?.slice(-4000),
    ranAt: Date.now(),
  };
  busy = false;
  if (key !== draftKey) {
    // You moved to another page while it ran, so it belongs with the page it was run on.
    await storage.set(key, { ...((await storage.get(key)) ?? {}), lastRun: result });
  } else {
    lastRun = result;
    saveDraft();
  }
  renderFiles();
  showResult();
}

function showResult() {
  if (busy) return;
  fill($("result"), programProblem && problemNote(programProblem), lastRun && runView(lastRun));
}

function runView(run) {
  const time = new Date(run.ranAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return [
    run.problems?.length > 0 &&
      h("div", { class: "notice warn" }, h("p", {}, "Some files couldn't be saved:"), h("ul", { class: "problems" }, run.problems.map((p) => h("li", {}, `${p.name}: ${p.error}`)))),
    run.error && problemNote(run),
    run.pdfs?.length > 0
      ? run.pdfs.map(pageCard)
      : run.ok && h("p", { class: "notice warn" }, `${CHECKER} finished, but no new PDFs appeared in ${PDF_FOLDER}/.`),
    h("div", { class: "result-foot" }, h("span", {}, `Started at ${time}`), outputDetails(run, !run.ok)),
  ];
}

// One marked page: its questions, each with the feedback and a button that copies just that.
function pageCard(pdf) {
  const url = `${SERVER}/pdf?${new URLSearchParams({ checker: CHECKER, folder: PDF_FOLDER, name: pdf.name })}`;
  const copyAll = h("button", { class: "btn small", type: "button", disabled: true }, "Copy all");
  const open = h("button", { class: "btn small", type: "button", onclick: () => (IN_EXTENSION ? chrome.tabs.create({ url }) : window.open(url)) }, "Open PDF");
  const body = h("div", { class: "questions" }, h("p", { class: "muted" }, "Loading feedback…"));

  api("/questions", { checker: CHECKER, folder: FEEDBACK_FOLDER, pdf: pdf.name }).then((res) => {
    if (!res.ok) return fill(body, h("p", { class: "notice warn" }, res.error));
    if (res.resubmit) return fill(body, h("p", { class: "notice warn" }, "This photo couldn't be read. Ask the student to resubmit it."));
    const feedback = res.questions.map((q) => readable(q.feedback)).filter(Boolean);
    if (feedback.length) {
      copyAll.disabled = false;
      copyAll.addEventListener("click", () => copied(copyAll, feedback.join("\n\n")));
    }
    fill(body, res.title && h("p", { class: "muted" }, res.title), res.questions.map(questionView));
  });

  return h(
    "div",
    { class: "page" },
    h("div", { class: "page-head" }, h("span", { class: "page-name", title: pdf.name }, pdf.name.replace(/\.pdf$/i, "")), copyAll, open),
    body,
  );
}

function questionView(q) {
  const feedback = readable(q.feedback);
  const copy = h("button", { class: "btn small", type: "button" }, "Copy feedback");
  copy.addEventListener("click", () => copied(copy, feedback));
  return h(
    "div",
    { class: "question" },
    h("div", { class: "q-head" }, h("strong", {}, q.label), feedback ? copy : h("span", { class: "muted" }, "No feedback needed")),
    feedback && h("p", { class: "q-feedback" }, feedback),
    q.work && h("details", {}, h("summary", {}, "Problem and student's work"), h("pre", { class: "output" }, readable(q.work).replace(/^#+\s*/gm, ""))),
  );
}

// Leftover LaTeX and markdown from the AI, turned into plain text for reading and pasting.
const LATEX = [
  [/\\(?:rightarrow|to)\b/g, "→"],
  [/\\Rightarrow\b/g, "⇒"],
  [/\\text\{([^}]*)\}/g, "$1"],
  [/\\square\b/g, "□"],
  [/\\cdot\b/g, "·"],
  [/\\approx\b/g, "≈"],
  [/\\neq\b/g, "≠"],
  [/\\pm\b/g, "±"],
  [/\^\{?2\}?(?!\d)/g, "²"],
  [/\^\{?3\}?(?!\d)/g, "³"],
  [/\*\*(.+?)\*\*/g, "$1"],
];
const readable = (s) => LATEX.reduce((text, [pattern, plain]) => text.replace(pattern, plain), String(s ?? "")).trim();

// Copies text, and says so on the button for a moment.
async function copied(button, text) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = (await copyText(text)) ? "Copied" : "Couldn't copy";
  await sleep(1500);
  button.textContent = label;
  button.disabled = false;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", {}, text);
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

// What the marking code printed (file names, costs, errors), for checking on a run.
function outputDetails(run, open = false) {
  const text = [run.stdout?.trim(), run.stderr?.trim()].filter(Boolean).join("\n\n");
  return text ? h("details", { open }, h("summary", {}, "Python output"), h("pre", { class: "output" }, text)) : null;
}

// ---- Wiring ----

for (const field of FIELDS) {
  $(field).addEventListener("input", () => {
    typed[field] = true;
    saveDraft();
  });
}
$("start").addEventListener("click", startMarking);

// The panel stays open while you work, so read the page again when you switch tab, load a
// new page, or move to another student (Classroom changes the address without reloading).
// Pages draw their content a moment after the address changes, hence the wait.
if (IN_EXTENSION) {
  let windowId = null;
  let timer = null;
  const rereadSoon = (wait) => {
    clearTimeout(timer);
    timer = setTimeout(loadPage, wait);
  };
  chrome.windows.getCurrent().then((win) => (windowId = win.id));
  chrome.tabs.onActivated.addListener((info) => info.windowId === windowId && rereadSoon(150));
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (tab.active && tab.windowId === windowId && (change.url || change.status === "complete")) rereadSoon(800);
  });
}

const SAMPLE_PAGE = {
  title: "Fractions homework 3",
  url: "https://example.com/homework/fractions-3/maya-okafor",
  text: "Fractions homework 3\nMaya Okafor\nTurned in",
  selection: "",
  headings: [],
  guess: { assignment: "Fractions homework 3", student: "Maya Okafor" },
  files: [
    { id: "sample-photo-1", kind: "drive", authuser: "0", name: "IMG_2041.jpg" },
    { id: "sample-doc-2", kind: "document", authuser: "0", name: "Fractions working" },
  ],
};

// The saved boxes (and the last run's PDFs) load before the server check.
loadPage().then(findProgram);
