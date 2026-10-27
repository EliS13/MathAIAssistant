import os
import shutil
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# scans/, scanMD/, AIprompts/ ... are next to this file, wherever it's started from (e.g. VS Code's Run button).
os.chdir(Path(__file__).resolve().parent)

import feedback

# Pages are marked at the same time: each one spends most of its time waiting for Gemini (~13s a page),
# so a whole batch takes about as long as its slowest page. 10 pages: 20s with 10 workers, 38s with 4.
# Gemini's "too many requests" answers are retried; lower this only if pages still fail with 429 / RESOURCE_EXHAUSTED.
WORKERS = 16

# Every scan in scans/ is checked against this assignment's answer key in answerKeys/.
# Change it when you start a new assignment, or give one when running: python main.py "Unit 3 Review"
ASSIGNMENT = "Unit 2 Review"

assignment = sys.argv[1] if len(sys.argv) > 1 else ASSIGNMENT
print(f"Assignment: {assignment}", flush=True)
folder = Path("scans")
for out in ("scanMD", "finishScan"):  # a missing output folder would fail every page at the very end
    Path(out).mkdir(exist_ok=True)


def mark(job):
    f, page = job
    label = f.name if page is None else f"{f.name} page {page + 1}"
    try:
        result = feedback.grade(f, assignment, page)
        print(label, flush=True)
        return result
    except Exception:
        # One bad page shouldn't stop the others being marked. Its file stays in scans/ to try again.
        print(f"Couldn't mark {label}:", file=sys.stderr)
        traceback.print_exc()
        return None


# One job per photo, and one per page of each PDF, so a PDF's pages are marked at the same time too.
files = [f for f in folder.iterdir() if f.is_file() and not f.name.startswith(".")]
jobs = []
for f in files:
    try:
        n = feedback.pageCount(f)
    except Exception as err:
        print(f"Couldn't open {f.name}: {err}", file=sys.stderr)
        jobs.append((f, None))  # still tried, so its failure is reported with the others
        continue
    jobs += [(f, None)] if n is None else [(f, p) for p in range(n)]

with ThreadPoolExecutor(max_workers=WORKERS) as pool:
    marked = list(pool.map(mark, jobs))

# Every page's feedback, by page name. Each is also saved as scanMD/<page>F.json for the extension.
results = {result["page"]: result for result in marked if result}

# The original photo or PDF is kept in finishScan/ once all its pages are marked.
for f in files:
    if all(result for (g, _), result in zip(jobs, marked) if g == f):
        shutil.move(f, Path("finishScan") / f.name)

if len(results) < len(jobs):
    sys.exit(1)