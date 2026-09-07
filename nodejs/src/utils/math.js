// utils/math.js - Deterministic, safe math evaluator.
// Parses arithmetic ( + - * / ^ % parentheses, decimals, scientific notation )
// WITHOUT using eval(), so it can never execute arbitrary code. Returns null
// when the input is not a clean math expression, so callers fall back to the
// model.

// Extract a bare arithmetic expression from a line of chat text.
export function extractMathExpression(text) {
  const s = String(text || '').trim();
  // Strip a leading question/math verb phrase if present.
  const cleaned = s.replace(
    /^(?:what(?:'s| is| are)|what's|compute|calculate|solve|evaluate|equals?)\b\s*/i,
    ''
  ).replace(/\??$/, '').trim();
  const expr = cleaned.replace(/[?,!.]$/, '').trim();
  if (!expr) return null;
  // Guard: must be purely numeric + arithmetic operators + parens + spaces.
  if (!/^[0-9+\-*\/^%().\s]+$/.test(expr)) return null;
  if (!/\d/.test(expr)) return null;
  if (/[a-zA-Z]/.test(expr)) return null;
  // Must contain at least one operator (otherwise "2" alone isn't a math ask).
  if (!/[\+\-\*\/\^%]/.test(expr)) return null;
  return expr;
}

// Tokenize an expression into numbers and operators.
function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('+-*/^%()'.includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    // read a number (int, decimal, scientific)
    const num = expr.slice(i).match(/^(\d+(?:\.\d+)?|\.\d+)([eE][+-]?\d+)?/);
    if (!num) return null;
    tokens.push(parseFloat(num[0]));
    i += num[0].length;
  }
  return tokens;
}

// Recursive-descent parser with correct precedence:
//   expr   := term (('+'|'-') term)*
//   term   := power (('*'|'/'|'%') power)*
//   power  := unary ('^' power)?        right-associative
//   unary  := ('+'|'-') unary | factor
//   factor := '(' expr ')' | number
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(val) {
    const t = this.next();
    if (t !== val) throw new Error('syntax error');
  }
  parseExpr() { return this.parseTerm(); }
  parseTerm() {
    let left = this.parseMul();
    while (['+', '-'].includes(this.peek())) {
      const op = this.next();
      const right = this.parseMul();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  parseMul() {
    let left = this.parsePower();
    while (['*', '/', '%'].includes(this.peek())) {
      const op = this.next();
      const right = this.parsePower();
      if (op === '*') left = left * right;
      else if (op === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }
  parsePower() {
    let left = this.parseUnary();
    if (this.peek() === '^') {
      this.next();
      const right = this.parsePower();
      left = Math.pow(left, right);
    }
    return left;
  }
  parseUnary() {
    if (this.peek() === '+') { this.next(); return this.parseUnary(); }
    if (this.peek() === '-') {
      this.next();
      return -this.parseUnary();
    }
    return this.parseFactor();
  }
  parseFactor() {
    const t = this.peek();
    if (t === '(') {
      this.next();
      const v = this.parseExpr();
      this.expect(')');
      return v;
    }
    if (typeof t === 'number') {
      this.next();
      return t;
    }
    throw new Error('syntax error');
  }
}

export function evaluateMath(expr) {
  try {
    const tokens = tokenize(expr);
    if (!tokens || !tokens.length) return null;
    const p = new Parser(tokens);
    const result = p.parseExpr();
    if (p.pos !== tokens.length) return null; // leftover tokens = not a clean expr
    if (!Number.isFinite(result)) return null;
    // Round to avoid floating point noise like 0.30000000000000004
    const rounded = Math.round((result + Number.EPSILON) * 1e10) / 1e10;
    return Number(rounded.toPrecision(12));
  } catch {
    return null;
  }
}

// Front-door: given a chat line, return a clean math answer or null.
export function trySolveMath(text) {
  const expr = extractMathExpression(text);
  if (!expr) return null;
  const value = evaluateMath(expr);
  if (value === null) return null;
  return `${expr} = ${value}`;
}
