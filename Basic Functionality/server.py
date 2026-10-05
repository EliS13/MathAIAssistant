# Local server that the Classroom button (extension/) talks to. Leave it running while grading:
#   python -m functionality.server
# The first start opens a browser to sign in to Google.

import os
import sys
import threading
import traceback
import uuid
from pathlib import Path

# The scan code uses paths like "scans/" and "AIprompts/", so always work from the project root.
# Adding the root to sys.path also lets VS Code's Run button start this file directly.
ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

from flask import Flask, jsonify, request
from googleapiclient.errors import HttpError

import functionality.classroomAccess as classroomAccess
import functionality.feedback as feedback

PORT = 8000  # keep in sync with SERVER in extension/service-worker.js

app = Flask(__name__)
jobs = {}
oneAtATime = threading.Lock()  # scans share the scans/ and finishScan/ folders

def scan(job, context):
    job["message"] = "Waiting for the previous scan…"
    with oneAtATime:
        job["state"] = "running"
        try:
            job["message"] = "Downloading files…"
            images, skipped = classroomAccess.downloadSubmission(context["courseId"], context["courseWorkId"], context["studentId"])
            if not images:
                raise RuntimeError("No photos or PDFs to scan in this submission.")

            failed = []
            for i, image in enumerate(images, 1):
                job["message"] = f"Scanning page {i} of {len(images)}…"
                try:
                    feedback.OCR(image)
                except Exception:
                    traceback.print_exc()
                    failed.append(image.name)

            scanned = len(images) - len(failed)
            if not scanned:
                raise RuntimeError(f"Couldn't scan {', '.join(failed)}. Details are in the server window.")
            message = f"Scanned {scanned} page{'s' if scanned > 1 else ''}. Feedback is in PDFs/."
            if failed:
                message += f" Couldn't scan: {', '.join(failed)}."
            if skipped:
                message += f" Skipped: {', '.join(skipped)}."
            job.update(state="done", message=message)
        except HttpError as err:
            traceback.print_exc()
            job.update(state="error", message=f"Google said: {err.reason}")
        except Exception as err:
            traceback.print_exc()
            job.update(state="error", message=str(err) or type(err).__name__)

@app.post("/scan")
def startScan():
    context = request.get_json(silent=True) or {}
    if not all(context.get(k) for k in ("courseId", "courseWorkId", "studentId")):
        return jsonify(state="error", message="Open a student's submission first."), 400
    job = {"id": uuid.uuid4().hex, "state": "queued", "message": "Starting…"}
    jobs[job["id"]] = job
    # The scan takes a while, so it runs in the background and the button polls /scan/<id>.
    threading.Thread(target=scan, args=(job, context), daemon=True).start()
    return jsonify(job)

@app.get("/scan/<jobId>")
def scanStatus(jobId):
    job = jobs.get(jobId)
    if not job:
        return jsonify(state="error", message="The server restarted during the scan. Try again."), 404
    return jsonify(job)

if __name__ == "__main__":
    classroomAccess.creds()  # sign in now rather than on the first click
    print("Ready. Leave this running and use the Scan with AI button in Classroom.")
    app.run(host="127.0.0.1", port=PORT)
