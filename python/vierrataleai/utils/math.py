"""math.py - Deterministic, safe arithmetic resolver for VierrataleAI.

Parses arithmetic ( + - * / ^ % parentheses, decimals ) WITHOUT eval(), so it
can never execute arbitrary code. Returns None when the input is not a clean
math expression, so callers fall back to the model.
"""
import re

# Restrict to digits, decimal points, arithmetic operators and parens.
_ALLOWED = re.compile(r"^[0-9+\-*\/^%().\s]+$")


def extract_math_expression(text: str):
    """Pull a bare arithmetic expression out of a chat line, or None."""
    if not text:
        return None
    s = str(text).strip()
    # Strip a leading question/math verb phrase if present.
    s = re.sub(
        r"^(?:what(?:'s| is| are)|what's|compute|calculate|solve|evaluate|equals?)\b\s*",
        "",
        s,
        flags=re.IGNORECASE,
    ).strip()
    s = re.sub(r"[?,!.]$", "", s).strip()
    if not s:
        return None
    if not _ALLOWED.match(s):
        return None
    if not re.search(r"\d", s):
        return None
    if re.search(r"[a-zA-Z]", s):
        return None
    if not re.search(r"[\+\-\*\/\^%]", s):
        return None
    return s


def _tokenize(expr):
    tokens = []
    i = 0
    n = len(expr)
    while i < n:
        c = expr[i]
        if c.isspace():
            i += 1
            continue
        if c in "+-*/^%()":
            tokens.append(c)
            i += 1
            continue
        m = re.match(r"^(\d+(?:\.\d+)?|\.\d+)([eE][+-]?\d+)?", expr[i:])
        if not m:
            return None
        tokens.append(float(m.group(0)))
        i += len(m.group(0))
    return tokens


class _Parser:
    """Recursive-descent parser with correct precedence (right-assoc ^ power)."""

    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def next(self):
        t = self.peek()
        self.pos += 1
        return t

    def expect(self, val):
        t = self.next()
        if t != val:
            raise ValueError("syntax error")

    def parse_expr(self):
        return self.parse_term()

    def parse_term(self):
        left = self.parse_mul()
        while self.peek() in ("+", "-"):
            op = self.next()
            right = self.parse_mul()
            left = left + right if op == "+" else left - right
        return left

    def parse_mul(self):
        left = self.parse_power()
        while self.peek() in ("*", "/", "%"):
            op = self.next()
            right = self.parse_power()
            if op == "*":
                left = left * right
            elif op == "/":
                left = left / right
            else:
                left = left % right
        return left

    def parse_power(self):
        left = self.parse_unary()
        if self.peek() == "^":
            self.next()
            right = self.parse_power()
            left = left ** right
        return left

    def parse_unary(self):
        if self.peek() == "+":
            self.next()
            return self.parse_unary()
        if self.peek() == "-":
            self.next()
            return -self.parse_unary()
        return self.parse_factor()

    def parse_factor(self):
        t = self.peek()
        if t == "(":
            self.next()
            v = self.parse_expr()
            self.expect(")")
            return v
        if isinstance(t, float):
            self.next()
            return t
        raise ValueError("syntax error")


def evaluate_math(expr):
    try:
        tokens = _tokenize(expr)
        if not tokens:
            return None
        p = _Parser(tokens)
        result = p.parse_expr()
        if p.pos != len(tokens):
            return None
        if result != result or result in (float("inf"), float("-inf")):  # NaN / inf
            return None
        return round(result, 10)
    except Exception:
        return None


def try_solve_math(text):
    expr = extract_math_expression(text)
    if expr is None:
        return None
    try:
        value = evaluate_math(expr)
    except Exception:
        return None
    if value is None:
        return None
    return f"{expr} = {value}"
