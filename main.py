import functionality.feedback as feedback
from pathlib import Path

folder = Path("scans")

for f in folder.iterdir():
    if f.is_file():
        feedback.OCR(f)
        print(f.name)