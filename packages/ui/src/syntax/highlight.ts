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

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v";
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isHexOrSep(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F") || c === "_";
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

/** End index (exclusive) of a number starting at `i`. Assumes a numeric start. */
function readNumber(code: string, i: number): number {
  const n = code.length;
  let j = i;
  if (code.charAt(j) === "0" && j + 1 < n) {
    const prefix = code.charAt(j + 1).toLowerCase();
    if (prefix === "x" || prefix === "b" || prefix === "o") {
      j += 2;
      while (j < n && isHexOrSep(code.charAt(j))) j += 1;
      return j;
    }
  }
  while (j < n && (isDigit(code.charAt(j)) || code.charAt(j) === "_")) j += 1;
  if (j < n && code.charAt(j) === ".") {
    j += 1;
    while (j < n && (isDigit(code.charAt(j)) || code.charAt(j) === "_")) j += 1;
  }
  if (j < n && (code.charAt(j) === "e" || code.charAt(j) === "E")) {
    let k = j + 1;
    if (k < n && (code.charAt(k) === "+" || code.charAt(k) === "-")) k += 1;
    if (k < n && isDigit(code.charAt(k))) {
      j = k + 1;
      while (j < n && isDigit(code.charAt(j))) j += 1;
    }
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

    // Line comment: consumes the rest of the line.
    let matchedLineComment = false;
    for (const marker of grammar.lineComments) {
      if (marker.length > 0 && code.startsWith(marker, i)) {
        sink.push("comment", code.slice(i));
        i = n;
        matchedLineComment = true;
        break;
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
      if (end !== null) {
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
  return scan(code, grammar);
}
