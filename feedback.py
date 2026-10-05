from google import genai
from google.genai import types
from PIL import Image
from dotenv import load_dotenv
from pathlib import Path
import ast
import os
import re
import functionality.convert as convert
import shutil

def cleanR(text):
    text = text.strip()
    text = text.removeprefix("```")
    text = text.removeprefix("json")
    text = text.removeprefix("python")
    text = text.removesuffix("```")
    return text.strip()

def latexToText(s):
    s = re.sub(r"\\frac\{(.*?)\}\{(.*?)\}", r"\1/\2", s)
    s = re.sub(r"\\sqrt\{(.*?)\}", r"√\1", s)
    return (s.replace("\\pi", "π")
             .replace("\\times", "x")
             .replace("\\div", "÷")
             .replace("\\checkmark", "✓")
             .replace("\\geq", "≥")
             .replace("\\leq", "≤")
             .replace("\\ge", "≥")
             .replace("\\le", "≤")
             .replace("$", ""))

def makeTable(data):
    headers, width, *rows = data
    if len(rows) == 1 and rows[0] and isinstance(rows[0][0], list):
        rows = rows[0]

    def fit(cell):
        return latexToText(str(cell)).ljust(width)

    def make_row(cells):
        return "| " + " | ".join(fit(c) for c in cells) + " |"

    lines = [make_row(headers), "| " + " | ".join("-" * width for _ in headers) + " |"]
    for row in rows:
        row = list(row) + [""] * (len(headers) - len(row))
        lines.append(make_row(row[:len(headers)]))
    return "\n\n" + "\n".join(lines) + "\n\n"

def OCR(file):
    load_dotenv()
    instruction = Path("AIprompts")
    OCR = (instruction/"OCR.txt").read_text(encoding="utf-8")
    FB = (instruction/"feedback.txt").read_text(encoding="utf-8")
    client = genai.Client(api_key=os.getenv("API_KEY"))
    img = Image.open(f"{file}")
    response = client.models.generate_content(
        model="gemini-3.8-flash",
        contents=[img, "Transcribe this page."],
        config=types.GenerateContentConfig(system_instruction= OCR, temperature=0.0, media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH))

    feedback = client.models.generate_content(
        model="gemini-3.5-flash-lite",
        contents=[response.text, "Mark this student's work."],
        config=types.GenerateContentConfig(system_instruction= FB, temperature=0.0, media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH))

    responseDict = ast.literal_eval(cleanR(response.text).strip())
    feedbackDict = ast.literal_eval(cleanR(feedback.text).strip())
    responseDict = {str(k).strip().rstrip("."): v for k, v in responseDict.items()}
    feedbackDict = {str(k).strip().rstrip("."): v for k, v in feedbackDict.items()}
    u = response.usage_metadata
    v = feedback.usage_metadata
    cost = (u.prompt_token_count * 0.30 + (u.candidates_token_count + (u.thoughts_token_count or 0)) * 2.50) / 1000000 + (v.prompt_token_count * 0.30 + (v.candidates_token_count + (v.thoughts_token_count or 0)) * 2.50) / 1000000
    
    photoN = file.stem
    with open(f"scanMD/{photoN}F.md", "w", encoding="utf-8") as q:
        if responseDict["problem"] != "invalid photo":
            q.write(f"# Problem Pack: {responseDict['problem']}\n")
            c = ''
            for i in list(responseDict.keys())[1:]:
                if 'table' in i:
                    c = "\n" + makeTable(responseDict[i])
                else:
                    q.write(f"## Question {i}\n{latexToText(responseDict[i])}{c}\n\n")
                    q.write(f"### Feedback\n{latexToText(feedbackDict.get(i, ''))}\n\n")
                    c = ''
        else:
            q.write("Resubmit")
    shutil.move(f"{file}", f"finishScan/{file.name}")
    print(f"${cost}")
    convert.conv(photoN)