import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import feedback

# Pages are marked at the same time: each one spends most of its time waiting for Gemini,
# so 4 pages take about as long as 1. Lower this if Gemini answers 429 / RESOURCE_EXHAUSTED.
WORKERS = 4

folder = Path("scans")


def mark(f):
    try:
        feedback.OCR(f)
        print(f.name, flush=True)
        return True
    except Exception:
        # One bad page shouldn't stop the others being marked.
        print(f"Couldn't mark {f.name}:", file=sys.stderr)
        traceback.print_exc()
        return False


files = [f for f in folder.iterdir() if f.is_file() and not f.name.startswith(".")]
with ThreadPoolExecutor(max_workers=WORKERS) as pool:
    marked = list(pool.map(mark, files))
if not all(marked):
    sys.exit(1)
