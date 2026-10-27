"""Step 3 of the pipeline: a free, deterministic check of the model's reading against the key.

SymPy parses the student's final answer and the key's answer and tests whether they are the
same number/expression. When the model and this check disagree, the answer goes to the bigger
model for a second look.
"""
import re
import warnings

import sympy
from lark import Tree
from sympy.parsing.latex import parse_latex

UNITS = r"(?:mm|cm|km|m|in|ft|yd|mi|kg|g|mL|L|s|min|h)(?:\^\{?[23]\}?)?"

# Odd student answers (lists, pairs) make SymPy print deprecation notices; they don't change the result.
warnings.filterwarnings("ignore", category=sympy.utilities.exceptions.SymPyDeprecationWarning)


def normalize(latex):
    s = latex.strip().strip("$").strip()
    s = re.sub(r"\\(?:left|right|displaystyle)", "", s)
    s = s.replace("\\dfrac", "\\frac").replace("\\tfrac", "\\frac")
    s = s.replace("÷", "\\div ").replace("×", "\\times ").replace("−", "-").replace("·", "\\cdot ")
    return s


def stripUnits(s):
    # the unit's own exponent goes with it: \text{cm}^2 must not square the answer
    s = re.sub(r"\\(?:text|mathrm|operatorname)\{[^{}]*\}(?:\^\{?[23]\}?)?", "", s)
    return re.sub(rf"\s*{UNITS}\s*$", "", s).strip()


def sides(latex):
    r"""The parts of an equals chain: students write both "c = 5\sqrt{2}" and "\sqrt{50} = c"."""
    return [s for s in normalize(latex).split("=") if s.strip()]


def toSympy(latex, units=False):
    s = normalize(latex)
    if units:
        s = stripUnits(s)
    s = s.strip()
    if not s or "," in s or "\\pm" in s:
        return None
    # The LaTeX parser reads "2^3p" as an error, so make every exponent explicit: 2^{3} \cdot p
    s = re.sub(r"\^(\w)", r"^{\1}", s)
    s = re.sub(r"(\^\{[^{}]*\})(?=[\w\\(])", r"\1 \\cdot ", s)
    try:
        expr = parse_latex(s, backend="lark")
    except Exception:
        return None
    while isinstance(expr, Tree):  # ambiguous parse: every branch is the same value
        expr = expr.children[0]
    return expr if isinstance(expr, sympy.Basic) else None


def sameForm(a, b):
    def squash(s):
        s = stripUnits(normalize(s))
        return re.sub(r"\\cdot|\\times|\s|\{|\}", "", s)
    return squash(a) == squash(b)


def check(studentLatex, key):
    """Compare a student's final answer with one answer-key entry.

    Returns {"result": "n/a" | "equivalent" | "different", "form_ok": bool | None}.
    "n/a" means the code can't judge it (word answers, lists, ±), which is not a disagreement.
    """
    units = bool(key.get("units"))
    # Every side of the student's equals chain that is a value, so "\sqrt{33} = a" is judged by \sqrt{33}.
    studentSides = sides(studentLatex)
    student = [e for e in (toSympy(s, units) for s in studentSides) if e is not None]
    if not student:
        return {"result": "n/a", "form_ok": None}

    tolerance = float(key.get("tolerance") or 0)
    candidates = [key.get("answer_latex", "")] + list(key.get("accepted_forms", []))
    parsedAny = False
    for c in candidates:
        expected = toSympy((sides(c) or [""])[-1], units)  # keys put the answer last: "c = 5\sqrt{2}"
        if expected is None:
            continue
        parsedAny = True
        for side in student:
            try:
                if tolerance:
                    same = abs(float(sympy.N(side - expected))) <= tolerance + 1e-9
                else:
                    same = sympy.simplify(side - expected) == 0
            except Exception:
                continue
            if same:
                formOk = (any(sameForm(s, (sides(f) or [""])[-1]) for s in studentSides for f in candidates)
                          if key.get("form_rule") else True)
                return {"result": "equivalent", "form_ok": formOk}
    return {"result": "different" if parsedAny else "n/a", "form_ok": None}
