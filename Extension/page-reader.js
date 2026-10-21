// readPage() runs inside the tab you're marking: popup.js injects it with
// chrome.scripting.executeScript. Chrome copies just this function into the page,
// so it can't use anything defined outside it.

function readPage() {
  const MAX_TEXT = 60000; // plenty for a submission, small enough to send quickly

  // Google's pages put icon glyphs (private-use characters) and invisible marks into labels.
  const clean = (s) => (s ?? "").replace(/[\uE000-\uF8FF\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  const text = (document.body?.innerText ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = text.split("\n").map(clean).filter(Boolean);
  const headings = [...document.querySelectorAll("h1, h2, h3")].map((el) => clean(el.innerText)).filter(Boolean);

  // On the pages being marked, the first line of text is always the assignment and the
  // second line is always the student's name. Anything long isn't either, so it's skipped.
  const line = (i) => ((lines[i] ?? "").length <= 120 ? lines[i] ?? "" : "");

  // Google Drive and Docs files linked from the page: a student's attachments on a Classroom
  // submission. The file ID in each address is enough to download it; the name comes from
  // the link. Classroom keeps some of these addresses in data attributes, so look at all of them.
  const FILE_URL = /(?:drive\.google\.com\/(?:file\/d\/|(?:open|uc)\?(?:[^"'\s<>]*?&)?id=)|docs\.google\.com\/(document|presentation|spreadsheets|drawings)\/d\/)([\w-]{20,})/;
  const NOT_NAMES = /^(open|preview|view|image|photo|pdf|file|attachment|google (drive|docs?|slides|sheets|drawings)|microsoft \w+)$/i;
  const pageUser = location.pathname.match(/^\/u\/(\d+)\//)?.[1] ?? "0";
  // Classroom labels attachment links like: Open “IMG_2041.jpg” in new window. The quoted
  // part is the file's name; otherwise drop the "Open … in new window" wording.
  const tidyName = (s) => {
    s = clean(s);
    const quoted = s.match(/[“"]([^”"]+)[”"]/)?.[1];
    if (quoted) return quoted.trim();
    return s.replace(/^(attachment|open|preview)\b\s*:?\s*/i, "").replace(/\s*\(?(opens )?in (a )?new (window|tab)\)?$/i, "");
  };
  // The name is on the link or just around it; stop before reaching the whole page.
  const nameOf = (el) => {
    for (let node = el, up = 0; node && node !== document.body && up < 3 && node.textContent.length < 300; node = node.parentElement, up++) {
      const name = [node.getAttribute("aria-label"), node.getAttribute("title"), node.innerText?.split("\n")[0]]
        .map(tidyName)
        .find((s) => s && s.length <= 150 && !NOT_NAMES.test(s));
      if (name) return name;
    }
    return "";
  };
  const files = new Map();
  for (const el of document.body?.querySelectorAll("*") ?? []) {
    for (const attr of el.attributes) {
      if (!attr.value.includes("google.com/")) continue;
      const match = attr.value.match(FILE_URL);
      if (!match) continue;
      const [, kind = "drive", id] = match;
      const known = files.get(id);
      if (known?.name) continue;
      const authuser = attr.value.match(/[?&]authuser=(\d+)/)?.[1] ?? pageUser;
      files.set(id, { id, kind, authuser, name: nameOf(el) || known?.name || "" });
    }
  }

  return {
    title: clean(document.title),
    url: location.href,
    host: location.hostname,
    description: clean(document.querySelector('meta[name="description"]')?.content),
    headings: [...new Set(headings)].slice(0, 15),
    selection: String(getSelection() ?? "").trim().slice(0, MAX_TEXT),
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
    wordCount: text ? text.split(/\s+/).length : 0,
    guess: {
      assignment: line(0),
      student: line(1),
    },
    files: [...files.values()],
  };
}
