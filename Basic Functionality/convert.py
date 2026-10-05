import subprocess
import shutil

def conv(file):
    subprocess.run([
    "pandoc", f"scanMD/{file}F.md", 
    "-o", f"PDFs/{file}.pdf", 
    "--pdf-engine=typst"
    ])
