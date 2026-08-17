// ─────────────────────────────────────────────────────────────────────────────
// The line tokenizer (issue #68). Deterministic, synchronous, zero-dependency,
// fail-closed. Given one line of code and a language, it returns a flat list of
// typed tokens that the CodeView paints as coloured spans UNDER the diff row's
// add/removed background (the diff semantic stays dominant; see canvas.css).
//
// It runs only on the WINDOWED rows the CodeView actually paints (never the whole
// file), so the R16 node-count / perf envelope is preserved: a scroll re-tokenizes
// at most a viewport of short lines. Pathological lines degrade gracefully to a
// single plain token rather than blocking the render.
// ─────────────────────────────────────────────────────────────────────────────

import {
  GRAMMARS,
  type Grammar,
  type LanguageId,
  type StringDelim,
  type Token,
  type TokenType,
} from "./languages";

export type { LanguageId, Token, TokenType } from "./languages";
export { detectLanguage } from "./languages";

/**
 * Lines longer than this are not tokenized (rendered as one plain token). A
 * minified bundle or a data blob has no useful token structure and would only
 * spend the node budget — graceful degradation, never a blocked render.
 */
export const MAX_HIGHLIGHT_LINE_LENGTH = 2000;

/**
 * Lines that tokenize into more than this many tokens render as one plain token.
 * Every token becomes a DOM span, and the CodeView's R16 envelope budgets only a
 * few nodes per row (`NODES_PER_ROW`); a pathological dense line (minified-ish, or
 * long runs of alternating single-char tokens) can produce hundreds of spans and
 * blow that budget even though it is under the length cap. Such a line has no
 * useful token structure, so it degrades to plain — the same graceful-degradation
 * contract as the length cap, keyed on the real cost driver (token/node count)
 * rather than the character-length proxy. A full viewport-independent window-node
 * budget is a follow-up; this bounds the realistic dense-line case.
 */
export const MAX_HIGHLIGHT_LINE_TOKENS = 128;

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v";
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

// Radix-specific digit predicates (#92): each base accepts only its own digit
// class (plus the `_` separator). A digit out of range makes the literal malformed,
// which fails closed to plain rather than mis-colouring `0b102` or `0o18` as a number.
function isBinDigit(c: string): boolean {
  return c === "0" || c === "1";
}

function isOctDigit(c: string): boolean {
  return c >= "0" && c <= "7";
}

function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

function readDigitRun(
  code: string,
  start: number,
  isValidDigit: (char: string) => boolean,
): { end: number; valid: boolean } {
  let j = start;
  let sawDigit = false;
  let previousWasDigit = false;
  while (j < code.length) {
    const char = code.charAt(j);
    if (isValidDigit(char)) {
      sawDigit = true;
      previousWasDigit = true;
      j += 1;
      continue;
    }
    if (char === "_") {
      if (!previousWasDigit || !isValidDigit(code.charAt(j + 1))) {
        return { end: j + 1, valid: false };
      }
      previousWasDigit = false;
      j += 1;
      continue;
    }
    break;
  }
  return { end: j, valid: sawDigit && previousWasDigit };
}

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

const OPERATOR_CHARS = new Set("+-*/%=&|<>!?~^".split(""));
const PUNCT_CHARS = new Set("{}()[].,;:@".split(""));

/** The first non-whitespace char at or after `from`, or "" if none remains. */
function peekNonSpace(code: string, from: number): string {
  let j = from;
  const n = code.length;
  while (j < n && isWhitespace(code.charAt(j))) j += 1;
  return j < n ? code.charAt(j) : "";
}

/**
 * End index (exclusive) of a number starting at `i`, or `i` itself when the
 * candidate is a MALFORMED numeric literal (out-of-range radix digit, or an
 * identifier char glued to a radix literal). Returning `i` fails the number closed
 * to plain — scan then lets the identifier/plain branches carry the text losslessly.
 * Assumes a numeric start.
 */
function readNumber(code: string, i: number): number {
  const n = code.length;
  let j = i;
  if (code.charAt(j) === "0" && j + 1 < n) {
    const prefix = code.charAt(j + 1).toLowerCase();
    if (prefix === "x" || prefix === "b" || prefix === "o") {
      const isRadixDigit = prefix === "x" ? isHexDigit : prefix === "b" ? isBinDigit : isOctDigit;
      j += 2;
      const digits = readDigitRun(code, j, isRadixDigit);
      if (!digits.valid) return i;
      j = digits.end;
      // Fail closed: no digits (`0x`), or a digit/identifier char out of range for
      // this radix immediately follows (`0b102`, `0o18`, `0xffg`) → not a number.
      if (j < n && (isDigit(code.charAt(j)) || isIdentPart(code.charAt(j)))) return i;
      return j;
    }
  }
  if (code.charAt(j) !== ".") {
    const integer = readDigitRun(code, j, isDigit);
    if (!integer.valid) return i;
    j = integer.end;
  }
  if (j < n && code.charAt(j) === ".") {
    j += 1;
    if (j < n && code.charAt(j) === "_") return i;
    if (j < n && isDigit(code.charAt(j))) {
      const fraction = readDigitRun(code, j, isDigit);
      if (!fraction.valid) return i;
      j = fraction.end;
    }
  }
  if (j < n && (code.charAt(j) === "e" || code.charAt(j) === "E")) {
    let k = j + 1;
    if (k < n && (code.charAt(k) === "+" || code.charAt(k) === "-")) k += 1;
    const exponent = readDigitRun(code, k, isDigit);
    if (!exponent.valid) return i;
    j = exponent.end;
  }
  return j;
}

/** End index (exclusive) of a string opened at `i` by `delim`, or null if no open. */
function readString(code: string, i: number, delim: StringDelim): number | null {
  if (!code.startsWith(delim.open, i)) return null;
  const n = code.length;
  let j = i + delim.open.length;
  while (j < n) {
    if (delim.escape !== null && code.startsWith(delim.escape, j)) {
      j += delim.escape.length + 1;
      continue;
    }
    if (code.startsWith(delim.close, j)) return j + delim.close.length;
    j += 1;
  }
  return n; // unterminated on this line → runs to end of line
}

class TokenSink {
  private readonly tokens: Token[] = [];

  push(type: TokenType, text: string): void {
    if (text.length === 0) return;
    // Merge adjacent same-type runs so a line does not explode into per-char spans
    // (keeps the CodeView inside the R16 node budget).
    const last = this.tokens[this.tokens.length - 1];
    if (last !== undefined && last.type === type) {
      this.tokens[this.tokens.length - 1] = { type, text: last.text + text };
      return;
    }
    this.tokens.push({ type, text });
  }

  drain(): Token[] {
    return this.tokens;
  }
}

function classifyWord(code: string, word: string, wordEnd: number, grammar: Grammar): TokenType {
  if (grammar.keywords.has(word)) return "keyword";
  if (grammar.types.has(word)) return "type";
  const next = peekNonSpace(code, wordEnd);
  if (grammar.functionCall && next === "(") return "function";
  if (grammar.propertyBeforeColon && next === ":") return "property";
  if (grammar.capitalizedTypes && word.charAt(0) >= "A" && word.charAt(0) <= "Z") return "type";
  return "plain";
}

function scan(code: string, grammar: Grammar): Token[] {
  const sink = new TokenSink();
  const n = code.length;
  let i = 0;

  while (i < n) {
    const c = code.charAt(i);

    // Whitespace run.
    if (isWhitespace(c)) {
      let j = i + 1;
      while (j < n && isWhitespace(code.charAt(j))) j += 1;
      sink.push("plain", code.slice(i, j));
      i = j;
      continue;
    }

    // Line comment: consumes the rest of the line. When the grammar requires a word
    // boundary (shell, yaml), a marker only opens a comment at line start or after
    // whitespace — so `echo foo#bar` and a `#frag` inside a URL stay code, while
    // `echo foo #bar` is a comment. Python keeps the flag off (`x=1#c` is a comment).
    const atWordBoundary = i === 0 || isWhitespace(code.charAt(i - 1));
    let matchedLineComment = false;
    if (!grammar.commentNeedsWordBoundary || atWordBoundary) {
      for (const marker of grammar.lineComments) {
        if (marker.length > 0 && code.startsWith(marker, i)) {
          sink.push("comment", code.slice(i));
          i = n;
          matchedLineComment = true;
          break;
        }
      }
    }
    if (matchedLineComment) continue;

    // Block comment (line-local): if the close is not on this line, run to EOL.
    if (grammar.blockComment && code.startsWith(grammar.blockComment[0], i)) {
      const [open, close] = grammar.blockComment;
      const closeAt = code.indexOf(close, i + open.length);
      const end = closeAt === -1 ? n : closeAt + close.length;
      sink.push("comment", code.slice(i, end));
      i = end;
      continue;
    }

    // Variable sigil, e.g. `$name` in shell (checked before generic identifiers).
    if (grammar.variableSigil !== null && c === grammar.variableSigil) {
      let j = i + 1;
      if (j < n && code.charAt(j) === "{") {
        const braceEnd = code.indexOf("}", j);
        j = braceEnd === -1 ? n : braceEnd + 1;
      } else {
        while (j < n && isIdentPart(code.charAt(j))) j += 1;
      }
      sink.push("variable", code.slice(i, j));
      i = j;
      continue;
    }

    // String literal.
    let matchedString = false;
    for (const delim of grammar.strings) {
      const end = readString(code, i, delim);
      // `end > i` guards the loop-advance invariant: a (future) zero-width delim
      // must never match without consuming input, or `scan` would not terminate.
      if (end !== null && end > i) {
        const text = code.slice(i, end);
        // A JSON/YAML/CSS key ("name":) reads as a property, not a bare string.
        const asProperty = grammar.propertyBeforeColon && peekNonSpace(code, end) === ":";
        sink.push(asProperty ? "property" : "string", text);
        i = end;
        matchedString = true;
        break;
      }
    }
    if (matchedString) continue;

    // Number literal (a leading `.` counts only when a digit follows).
    if (grammar.numbers && (isDigit(c) || (c === "." && isDigit(code.charAt(i + 1))))) {
      const end = readNumber(code, i);
      if (end > i) {
        sink.push("number", code.slice(i, end));
        i = end;
        continue;
      }
      let malformedEnd = i + 1;
      while (malformedEnd < n && isIdentPart(code.charAt(malformedEnd))) malformedEnd += 1;
      sink.push("plain", code.slice(i, malformedEnd));
      i = malformedEnd;
      continue;
    }

    // Identifier / keyword / type / function / property.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(code.charAt(j))) j += 1;
      const word = code.slice(i, j);
      sink.push(classifyWord(code, word, j, grammar), word);
      i = j;
      continue;
    }

    // Operator run.
    if (OPERATOR_CHARS.has(c)) {
      let j = i + 1;
      while (j < n && OPERATOR_CHARS.has(code.charAt(j))) j += 1;
      sink.push("operator", code.slice(i, j));
      i = j;
      continue;
    }

    // Punctuation (single char).
    if (PUNCT_CHARS.has(c)) {
      sink.push("punctuation", c);
      i += 1;
      continue;
    }

    // Anything else (unicode, stray marks) → plain, one char.
    sink.push("plain", c);
    i += 1;
  }

  return sink.drain();
}

/**
 * Tokenize one line of code for `languageId`. An unknown/absent language, or a
 * line past the length cap, returns a single plain token — fail-closed, never a
 * crash and never fabricated colouring.
 */
export function tokenizeLine(code: string, languageId: LanguageId | null): Token[] {
  if (code.length === 0) return [];
  if (languageId === null) return [{ text: code, type: "plain" }];
  if (code.length > MAX_HIGHLIGHT_LINE_LENGTH) return [{ text: code, type: "plain" }];
  const grammar = GRAMMARS[languageId];
  const tokens = scan(code, grammar);
  // A line that shatters into more spans than the row-node budget can hold has no
  // useful token structure — degrade it to plain rather than blow the R16 envelope.
  if (tokens.length > MAX_HIGHLIGHT_LINE_TOKENS) return [{ text: code, type: "plain" }];
  return tokens;
}

/** Tokenize diff source with its one-character marker outside the language grammar. */
export function tokenizeDiffLine(code: string, languageId: LanguageId | null): Token[] {
  if (languageId === null || !["+", "-", " "].includes(code.charAt(0))) {
    return tokenizeLine(code, languageId);
  }
  const source = tokenizeLine(code.slice(1), languageId);
  if (source.length === 1 && source[0]?.type === "plain") {
    return [{ text: code, type: "plain" }];
  }
  return [{ text: code.charAt(0), type: "plain" }, ...source];
}
