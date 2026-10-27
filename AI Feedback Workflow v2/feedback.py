"""Gives feedback on one scanned worksheet page, following grading-pipeline-plan.pdf:

0. Answer key  - made once per assignment by the strong model, saved to answerKeys/ for the teacher to check
1. Read        - the page is transcribed without the key, so the reader can't fill a blank with the key's answer
                 (whole page: no answer-box coordinates are stored yet, so this is the plan's fallback)
2. Compare     - small fast model compares the transcription with the key and writes feedback, as strict JSON
3. Code check  - SymPy tests the final answer against the key (mathcheck.py)
5. Escalation  - off by default for speed (SECOND_LOOK); when on, flagged and "wrong" answers go to the bigger model
6. Teacher     - anything unsure is marked "please check" in the output
"""
from google import genai
from google.genai import types
from PIL import Image, ImageOps
from pydantic import BaseModel
from dotenv import load_dotenv
from pathlib import Path
import enum
import json
import os
import re
import threading
import mathcheck
import pymupdf

# Tuned for speed; teachers edit the feedback afterwards. Measured on Unit 2 review pages at 2048px: 3.8 Flash
# (low thinking) reads a page in ~7-10s and is the only reader that describes drawings the student made; Flash-Lite
# (minimal thinking, ~5-7s) ignores drawings and can miss a minus sign or a blank. For more accuracy, set SECOND_LOOK to True.
READER = "gemini-3.8-flash"
WORKER = "gemini-3.1-flash-lite"
ESCALATION = "gemini-3.8-flash"
KEY_MODEL = "gemini-3.8-flash"  # runs once per assignment; the key is reused for every student
SECOND_LOOK = False  # True: unsure and "wrong" answers are re-read by ESCALATION (adds 30-90s a page)
IMAGE_SIZE = 2048  # longest side in pixels; smaller is faster, but medium resolution broke question numbering
CONFIDENCE = 0.8  # below this, the answer is flagged "please check"
# $ per million tokens (input, output), standard tier, October 21 2026. 3.8 Flash rises to 1.50 / 7.50 on Jan 1 2027.
PRICES = {"gemini-3.1-flash-lite": (0.25, 1.50), "gemini-3.8-flash": (0.75, 3.75)}

load_dotenv(Path(__file__).with_name(".env"))
# Many pages are sent at once, so a "too many requests" (429) or busy (503) answer waits and tries again instead of failing the page.
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"), http_options=types.HttpOptions(
    retry_options=types.HttpRetryOptions(attempts=5, initial_delay=2, max_delay=30, http_status_codes=[429, 500, 503, 504])))
instruction = Path("AIprompts")
keyLock = threading.Lock()  # pages are done in parallel; only one may write the key at a time


class KeyEntry(BaseModel):
    question_id: str
    question_text: str
    answer_latex: str
    accepted_forms: list[str]
    required_parts: list[str]
    form_rule: str
    explanation_required: bool
    units: str
    tolerance: float
    solution: str


class KeyPage(BaseModel):
    questions: list[KeyEntry]


class Read(BaseModel):
    question_id: str
    transcription_latex: str
    final_answer_latex: str
    legible: bool
    reading_confidence: float


class PageRead(BaseModel):
    question_ids: list[str]
    worksheet: str
    page_readable: bool
    questions: list[Read]


class Verdict(str, enum.Enum):
    correct = "correct"
    wrong = "wrong"
    incomplete = "incomplete"
    gray_zone = "gray_zone"


class ErrorType(str, enum.Enum):
    none = "none"
    arithmetic = "arithmetic"
    exponent_rule = "exponent_rule"
    negative_sign = "negative_sign"
    square_root = "square_root"
    pythagorean = "pythagorean"
    not_simplified = "not_simplified"
    missing_part = "missing_part"
    missing_explanation = "missing_explanation"
    units = "units"
    misread_question = "misread_question"
    other = "other"


class Judged(BaseModel):
    question_id: str
    parts_answered: list[str]
    verdict: Verdict
    error_type: ErrorType
    feedback: str
    confidence: float


class JudgedPage(BaseModel):
    questions: list[Judged]


class Reread(BaseModel):
    question_id: str
    legible: bool
    transcription_latex: str
    final_answer_latex: str
    parts_answered: list[str]
    verdict: Verdict
    error_type: ErrorType
    feedback: str
    confidence: float


class RereadPage(BaseModel):
    questions: list[Reread]


def latexToText(s):
    s = re.sub(r"\\(?:text|mathrm)\{(.*?)\}", r"\1", s)
    s = re.sub(r"\\frac\{(.*?)\}\{(.*?)\}", r"\1/\2", s)
    s = re.sub(r"\\sqrt\{(.*?)\}", r"√\1", s)
    return (s.replace("\\pi", "π")
             .replace("\\times", "x")
             .replace("\\cdot", "·")
             .replace("\\div", "÷")
             .replace("\\pm", "±")
             .replace("\\checkmark", "✓")
             .replace("\\geq", "≥")
             .replace("\\leq", "≤")
             .replace("\\ge", "≥")
             .replace("\\le", "≤")
             .replace("$", ""))


def normId(qid):
    """'Question 1 (a).' -> '1a', '3 (225)' -> '3': a question number and at most one letter,
    so ids from different calls line up with the key's."""
    m = re.search(r"(\d+)\s*[.(]?\s*([a-z])?(?![a-z])", str(qid).lower())
    return m.group(1) + (m.group(2) or "") if m else ""


def ask(model, contents, prompts, schema, thinking):
    r = client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(
            system_instruction="\n\n".join((instruction/p).read_text(encoding="utf-8") for p in prompts),
            temperature=0.0,
            media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
            response_mime_type="application/json",
            response_schema=schema,
            thinking_config=types.ThinkingConfig(thinking_level=thinking)))
    if r.parsed is None:
        raise ValueError(f"{model} didn't return usable JSON: {(r.text or '')[:300]}")
    u = r.usage_metadata
    inPrice, outPrice = PRICES[model]
    cost = (u.prompt_token_count * inPrice + ((u.candidates_token_count or 0) + (u.thoughts_token_count or 0)) * outPrice) / 1000000
    return r.parsed, cost


def keyPath(assignment):
    return Path("answerKeys") / (re.sub(r"[^\w-]+", "-", assignment).strip("-").lower() + ".json")


def loadKey(assignment):
    p = keyPath(assignment)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"assignment": assignment, "teacher_checked": False, "questions": {}}


def addToKey(assignment, img, ids):
    """Step 0: solve this page's printed questions once, so no student's page is ever re-solved."""
    with keyLock:
        key = loadKey(assignment)  # another page may have just added these
        missing = [i for i in ids if i not in key["questions"]]
        if not missing:
            return key, 0
        built, cost = ask(KEY_MODEL, [img, f"Write the key for questions {', '.join(missing)} on the main page."],
                          ["answerKey.txt"], KeyPage, "low")
        added = []
        for q in built.questions:
            qid = normId(q.question_id)
            if qid in missing and qid not in key["questions"]:
                key["questions"][qid] = {**q.model_dump(), "question_id": qid}
                added.append(qid)
        if added:
            key["teacher_checked"] = False
            keyPath(assignment).parent.mkdir(exist_ok=True)
            keyPath(assignment).write_text(json.dumps(key, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"Answer key: added {', '.join(added)} to {keyPath(assignment)}. Check it, then set teacher_checked to true.", flush=True)
        return key, cost


def keyText(key, ids):
    return "Answer key and rubric:\n" + json.dumps([key["questions"][i] for i in ids if i in key["questions"]], ensure_ascii=False)


def compare(key, reads):
    """Step 2: text only. The model sees what was read, never the photo, so it judges the student's actual work."""
    keyed = [i for i in reads if i in key["questions"]]
    if not keyed:
        return {}, 0
    work = json.dumps([{"question_id": i, "transcription_latex": reads[i]["transcription_latex"],
                        "final_answer_latex": reads[i]["final_answer_latex"]} for i in keyed], ensure_ascii=False)
    # Key and prompt come first: they are the same for every student, so Gemini can cache them.
    page, cost = ask(WORKER, [keyText(key, keyed), f"Student's work, as read from the page:\n{work}"],
                     ["grade.txt"], JudgedPage, "minimal")
    return {normId(q.question_id): q.model_dump(mode="json") for q in page.questions if normId(q.question_id) in keyed}, cost


def unmarked(read, reason):
    return {**read, "parts_answered": [], "verdict": "no_key", "error_type": "none", "feedback": "",
            "confidence": 0.0, "escalated": False, "flag": reason}


def flagReason(g, entry):
    """Why this answer can't go straight to the side panel, or None if it can."""
    if g["verdict"] == "no_key" or entry is None:
        return "No answer key for this question."
    if not g["legible"]:
        return "Could not read the handwriting. Please check the photo."
    if g["verdict"] == "gray_zone":
        return "The answer is right, but whether it's acceptable depends on your rubric."
    code = mathcheck.check(g["final_answer_latex"], entry)
    g["code_check"] = code["result"]
    if code["result"] == "different" and g["verdict"] in ("correct", "gray_zone"):
        return "The AI thought this was right, but the answer it read doesn't match the key."
    if code["result"] == "equivalent":
        if g["verdict"] == "correct" and code["form_ok"] is False:
            return "The answer equals the key, but isn't in the form the key gives."
        if g["verdict"] == "wrong" and code["form_ok"] is not False and g["error_type"] in ("none", "arithmetic", "exponent_rule", "negative_sign", "square_root", "pythagorean", "other"):
            return "The AI thought this was wrong, but the answer it read matches the key."
    if g["confidence"] < CONFIDENCE:
        return "The AI wasn't confident in its reading."
    return None


def escalate(img, key, flagged):
    """Step 5: only the flagged answers go to the bigger model, which reads them again from the photo."""
    ids = [g["question_id"] for g in flagged]
    notes = json.dumps([{"question_id": g["question_id"], "first_reading": g["transcription_latex"], "first_verdict": g["verdict"],
                         "why_flagged": g["flag"] or "Marked wrong. Check the reading before the student is told so."}
                        for g in flagged], ensure_ascii=False)
    page, cost = ask(ESCALATION, [keyText(key, ids), img,
                                  f"A first marker was unsure about these questions: {notes}\n"
                                  f"Read the handwriting for only questions {', '.join(ids)} again, very carefully, then judge them. "
                                  "Return only those questions."],
                     ["readPage.txt", "grade.txt"], RereadPage, "medium")
    return {normId(q.question_id): q.model_dump(mode="json") for q in page.questions}, cost


def pageCount(file):
    """How many pages a PDF has, or None for a photo."""
    if file.suffix.lower() != ".pdf":
        return None
    with pymupdf.open(file) as doc:
        return doc.page_count


def loadPage(file, page):
    """The photo, or page `page` (from 0) of a PDF, as an image no bigger than IMAGE_SIZE."""
    if page is None:
        img = ImageOps.exif_transpose(Image.open(file)).convert("RGB")
    else:
        with pymupdf.open(file) as doc:
            p = doc[page]
            zoom = IMAGE_SIZE / max(p.rect.width, p.rect.height)  # scanned PDF pages are often huge
            pix = p.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    img.thumbnail((IMAGE_SIZE, IMAGE_SIZE))  # phone photos are ~5700px; smaller uploads and reads faster
    return img


def grade(file, assignment, pageNo=None):
    """Feedback for one photo, or for one page of a PDF (pageNo counts from 0)."""
    name = file.stem if pageNo is None else f"{file.stem} p{pageNo + 1}"
    img = loadPage(file, pageNo)

    page, cost = ask(READER, [img, "Transcribe this page."], ["readPage.txt"], PageRead,
                     "minimal" if READER == "gemini-3.1-flash-lite" else "low")
    reads = {}
    for i in map(normId, page.question_ids):
        if i:
            reads[i] = {"question_id": i, "transcription_latex": "", "final_answer_latex": "", "legible": True, "reading_confidence": 1.0}
    filled = set()
    for q in page.questions:
        i = normId(q.question_id)
        if not i:
            continue
        r = {**q.model_dump(), "question_id": i}
        if i in filled:  # items of one question that the reader listed separately
            old = reads[i]
            r["transcription_latex"] = f"{old['transcription_latex']}\n{r['transcription_latex']}".strip()
            r["final_answer_latex"] = ", ".join(a for a in (old["final_answer_latex"], r["final_answer_latex"]) if a.strip())
            r["legible"] = old["legible"] and r["legible"]
            r["reading_confidence"] = min(old["reading_confidence"], r["reading_confidence"])
        reads[i] = r
        filled.add(i)

    results = []
    key = loadKey(assignment)
    if page.page_readable and reads:
        key, c = addToKey(assignment, img, list(reads))
        judged, c2 = compare(key, reads)
        cost += c + c2
        for i, r in reads.items():
            if i not in key["questions"]:
                results.append(unmarked(r, "No answer key for this question."))
            elif i not in judged:
                results.append(unmarked(r, "The AI didn't return feedback for this question. Please check it yourself."))
            else:
                g = {**r, **judged[i], "question_id": i, "escalated": False}
                g["confidence"] = min(g["confidence"], r["reading_confidence"])
                if not r["transcription_latex"].strip() and not r["final_answer_latex"].strip():
                    g["verdict"], g["error_type"] = "incomplete", "missing_part"  # nothing written can't be right
                g["flag"] = flagReason(g, key["questions"][i])
                results.append(g)

    # Telling a student they're wrong when they aren't hurts trust most, so every "wrong" gets a second look too.
    flagged = [g for g in results if (g["flag"] or g["verdict"] == "wrong") and g["verdict"] != "no_key"]
    if SECOND_LOOK and flagged:
        second, c = escalate(img, key, flagged)
        cost += c
        for i, g in enumerate(results):
            if g in flagged and g["question_id"] in second:
                redo = {**second[g["question_id"]], "question_id": g["question_id"], "escalated": True}
                redo["flag"] = flagReason(redo, key["questions"].get(g["question_id"]))
                results[i] = redo

    # One entry per question, so the extension can show each one with its own Copy button.
    questions = []
    for g in results if page.page_readable else []:
        i = g["question_id"]
        problem = latexToText(key["questions"].get(i, {}).get("question_text", ""))
        work = latexToText(g["transcription_latex"])
        feedbackText = latexToText(g["feedback"])
        lines = lambda s: s.replace("\n", "  \n")  # keep each written line on its own line in markdown
        md = (f"## Question {i}\n\n**Problem:** {lines(problem)}\n\n**Student work:**\n\n{lines(work)}\n\n"
              f"**Feedback:** {lines(feedbackText) or 'No feedback needed.'}")
        if g["flag"]:
            md += f"\n\n**Please check:** {g['flag']}"
        questions.append({
            "question": i,
            "problem": problem,
            "student_work": work,
            "feedback": feedbackText,  # empty when the answer looks right
            "needs_review": bool(g["flag"]),
            "review_reason": g["flag"] or "",
            "markdown": md,  # the whole question formatted, ready to display
            "work": f"Problem: {problem}\n\n### Student Work: \n{work}",  # what the extension shows today
        })
    result = {
        "page": file.name if pageNo is None else f"{file.name} p{pageNo + 1}",
        "problem": page.worksheet,
        "resubmit": not page.page_readable,
        "assignment": assignment,
        "key_checked": bool(key.get("teacher_checked")),
        "questions": questions,
    }
    Path(f"scanMD/{name}F.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"${cost:.4f}")
    return result
