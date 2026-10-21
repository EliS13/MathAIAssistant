"""
PDF helpers for server.js. Uses pymupdf, which the marking code's Python already has.

  python pdf_tools.py pages <file.pdf> <folder> <name>
      Saves each page as "<name> p1.png", "<name> p2.png"... in <folder> ("<name>.png" for a
      one-page PDF), because the marking code reads images. Prints the new file names as JSON.
"""

import json
import sys
from pathlib import Path

import pymupdf


def pages(pdf, folder, name):
    saved = []
    with pymupdf.open(pdf) as doc:
        for page in doc:
            file = f"{name} p{page.number + 1}.png" if len(doc) > 1 else f"{name}.png"
            page.get_pixmap(dpi=200).save(str(Path(folder) / file))
            saved.append(file)
    print(json.dumps(saved))


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    {"pages": pages}[command](*args)
