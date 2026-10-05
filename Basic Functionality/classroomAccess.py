# Downloads one student's submitted files from Google Classroom into scans/ as images,
# ready for feedback.OCR. Signs in with credentials.json (an OAuth "Desktop app" client)
# kept next to this file, and remembers the sign-in in token.json.

import io
import mimetypes
import re
from pathlib import Path

import pymupdf
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

HERE = Path(__file__).parent
CREDENTIALS = HERE / "credentials.json"
TOKEN = HERE / "token.json"
SCOPES = [
    "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
    "https://www.googleapis.com/auth/classroom.rosters.readonly",  # student names, for file names
    "https://www.googleapis.com/auth/drive.readonly",
]
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/tiff"}
# Google Docs/Slides/Drawings can't be downloaded as they are, so they're exported as PDF.
EXPORT_AS_PDF = {
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.presentation",
    "application/vnd.google-apps.drawing",
}

def creds():
    c = Credentials.from_authorized_user_file(TOKEN) if TOKEN.exists() else None
    if c and not c.has_scopes(SCOPES):
        c = None  # signed in before with fewer permissions, sign in again
    if c and c.expired and c.refresh_token:
        try:
            c.refresh(Request())
        except RefreshError:
            c = None  # sign-in expired or was revoked, sign in again
    if not c or not c.valid:
        if not CREDENTIALS.exists():
            raise FileNotFoundError(f"Missing {CREDENTIALS}. Download it from Google Cloud Console (OAuth client, Desktop app).")
        # Opens a browser to sign in. After that, token.json is reused.
        c = InstalledAppFlow.from_client_secrets_file(CREDENTIALS, SCOPES).run_local_server(port=0)
    TOKEN.write_text(c.to_json())
    return c

def download(request):
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue()

def pdfPages(data, base, dest):
    # The scan code reads images, so each PDF page becomes its own PNG.
    paths = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        for page in doc:
            path = dest / (f"{base} p{page.number + 1}.png" if len(doc) > 1 else f"{base}.png")
            page.get_pixmap(dpi=200).save(str(path))
            paths.append(path)
    return paths

def downloadSubmission(courseId, courseWorkId, studentId, dest=Path("scans")):
    """Saves the student's attached files into dest as images. Returns (image paths, names of skipped attachments)."""
    c = creds()
    classroom = build("classroom", "v1", credentials=c)
    drive = build("drive", "v3", credentials=c)

    student = classroom.courses().students().get(courseId=courseId, userId=studentId).execute()
    name = student["profile"]["name"]["fullName"]
    subs = classroom.courses().courseWork().studentSubmissions().list(
        courseId=courseId, courseWorkId=courseWorkId, userId=studentId
    ).execute().get("studentSubmissions", [])

    dest.mkdir(exist_ok=True)
    images, skipped, used = [], [], set()
    for sub in subs:
        for att in sub.get("assignmentSubmission", {}).get("attachments", []):
            f = att.get("driveFile")
            if not f:
                # links, YouTube videos and Forms
                skipped.append(next(iter(att.values()), {}).get("title") or "a link")
                continue

            meta = drive.files().get(fileId=f["id"], fields="name,mimeType").execute()
            mime = meta["mimeType"]
            title = meta["name"] if mime in EXPORT_AS_PDF else Path(meta["name"]).stem
            # "<student> - <file>", numbered if two attachments share a name
            base = re.sub(r'[\\/:*?"<>|]+', "-", f"{name} - {title}").strip()
            n = 1
            while (f"{base} ({n})" if n > 1 else base) in used:
                n += 1
            base = f"{base} ({n})" if n > 1 else base
            used.add(base)

            if mime == "application/pdf":
                images += pdfPages(download(drive.files().get_media(fileId=f["id"])), base, dest)
            elif mime in EXPORT_AS_PDF:
                images += pdfPages(download(drive.files().export_media(fileId=f["id"], mimeType="application/pdf")), base, dest)
            elif mime in IMAGE_TYPES:
                path = dest / (base + (mimetypes.guess_extension(mime) or ".jpg"))
                path.write_bytes(download(drive.files().get_media(fileId=f["id"])))
                images.append(path)
            else:
                skipped.append(meta["name"])
    return images, skipped
