# Marking Feedback Assistant

A Chrome side panel for marking Google Classroom work. On a student's submission it shows the **student's name**, the **assignment**, and the **files** they handed in. Press **Start** and it puts those files into your marking code's folder, runs your marking code on them, and shows the feedback PDFs it makes, ready to copy.

```
Extension/          this whole folder is the Chrome extension
  manifest.json       tells Chrome what the extension is
  popup.html/js       the panel (shown in Chrome's side panel); settings at the top of popup.js
  background.js       makes the toolbar icon open the side panel
  page-reader.js      reads the student, assignment and attached files from the page
  api.js              talks to the server
  backend/
    server.js         the Node.js server: saves files in, runs your code, serves the PDFs; logs to server.log
    pdf_tools.py      turns PDFs the students hand in into page images
    setup.js          one-time setup so Chrome can start the server for you
    native-host.js    what Chrome runs to start the server
    scripts/          your marking code (main.py, feedback.py, convert.py, AIprompts/)
      scans/            the student's files go here for main.py to read
      PDFs/             main.py's feedback PDFs, which the panel shows
```

## Set up (once)

1. **Let Chrome start the server for you.** In a terminal, from the `Extension` folder:

   ```bash
   node backend/setup.js
   ```

   From then on, opening the panel starts the server in the background if it isn't running. Its output goes to `backend/server.log`. Run it again whenever you move or rename this folder, or switch to a different Python. You can also start the server yourself with `node backend/server.js`.

2. **Load the extension.** In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the `Extension` folder. Pin it from the puzzle-piece menu. After changing any file, click the reload arrow on the extension's card.

## Marking a student

1. Open the student's submission in Classroom and click the extension's icon. The panel opens on the right and stays open until you click its **X**. When you move to the next student, it updates by itself.
2. Check the **Student name** and **Assignment** (line 1 of the page is the assignment, line 2 the student) and the list of **files**. Untick any file you don't want marked, such as your own worksheet if it's listed.
3. Press **Start**. The panel shows its progress:
   - **Saving files:** the panel fetches each file from Google Drive with the Google account you're signed into in Chrome (no separate sign-in), and hands it straight to the server. Nothing goes to your Downloads folder. Google Docs, Slides, Sheets and Drawings come as PDFs.
   - The server saves them into `scans/`, named `<student> - <file>`. PDFs become one image per page (`… p1.png`, `… p2.png`), because the marking code reads images. iPhone (HEIC) photos become JPEGs. Anything left in `scans/` from an earlier run is moved into `scans/old/` first, so it isn't marked (and paid for) again.
   - **Marking:** `main.py` runs, marking up to 4 pages at the same time (`WORKERS` in `main.py`). Each page takes Gemini about 1½ minutes. Keep the panel open until it finishes. Pressing Start again while it's still marking is refused, so a run can't be disturbed.
   - **Privacy:** once marking is over, that run's photos are deleted from `scans/` and `finishScan/` (even if marking failed; they can always be fetched again from Classroom). The feedback (markdown, JSON and PDFs) is kept.
4. Each marked page appears in the panel, split into its questions. Every question with feedback has a **Copy feedback** button that copies just that feedback; questions answered correctly say "No feedback needed". **Copy all** copies the whole page's feedback, **Open PDF** shows the PDF in a full tab, and "Problem and student's work" shows what the AI read. Everything `main.py` printed (file names, costs, errors) is under **Python output**.

Each student's results are remembered, so going back to their submission shows their feedback again.

## Settings

At the top of `popup.js`:

| Setting | What it is | Now |
| --- | --- | --- |
| `CHECKER` | Your marking code: a file in `backend/scripts/`, or a full path | `"main.py"` |
| `FILES_FOLDER` | The folder next to it where the student's files go | `"scans"` |
| `DONE_FOLDER` | Where it moves each photo once marked (photos are deleted from here and `FILES_FOLDER` after a run) | `"finishScan"` |
| `FEEDBACK_FOLDER` | Where it writes each page's feedback (`<page>F.json` and `<page>F.md`) | `"scanMD"` |
| `PDF_FOLDER` | Where it writes PDFs | `"PDFs"` |

When you start the server yourself, you can also set `PYTHON` (which Python runs your code; `setup.js` records the `python3` your terminal uses), `RUN_TIMEOUT_MS` (how long your code may run; 15 minutes) and `PORT` (5050; also change `SERVER` in `api.js`).

## Good to know

- **Start uses AI credits**, because `main.py` sends every page to Gemini. Nothing else in the extension calls a paid service.
- Your code runs from `backend/scripts/`, so its relative folders (`scans`, `scanMD`, `finishScan`, `PDFs`, `AIprompts`) are there, and so is its `.env`. The key is stored as `GEMINI_API_KEY`; `feedback.py` asks for `API_KEY`, finds nothing, and Google's library then uses `GEMINI_API_KEY` by itself.
- `feedback.py` saves each page's questions as `scanMD/<page>F.json` (straight from its dictionaries) next to the markdown, and the panel reads that. Pages marked before that only have the markdown, which the panel splits at its `## Question` and `### Feedback` headings instead.
- If a file can't be saved, the panel says why, for example "Google sent a web page instead of the file" when your account can't open it.
- **If something goes wrong, look in `backend/server.log`.** Every Start is logged there: which files arrived (or why not), how your code finished, any error it printed, and how many PDFs it made. Only photos, PDFs and Google Docs/Slides/Sheets/Drawings can be marked.
- The extension can always read Google Classroom. On other sites, it can read the page once you've clicked its icon on that tab.
- The server only listens on your own computer (`127.0.0.1`) and refuses requests from websites.
- To stop the server, run `pkill -f backend/server.js` (or restart). It starts again the next time you open the panel.
