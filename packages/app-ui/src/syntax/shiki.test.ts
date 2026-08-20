import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  MAX_HIGHLIGHT_LINE_LENGTH,
  MAX_HIGHLIGHT_LINE_TOKENS,
  type Token,
  tokenizeLine,
} from "./shiki";

function reassemble(tokens: readonly Token[]): string {
  return tokens.map((t) => t.text).join("");
}

function hasToken(tokens: readonly Token[], type: Token["type"], text: string): boolean {
  return tokens.some((t) => t.type === type && t.text === text);
}

function typesOf(tokens: readonly Token[]): Set<Token["type"]> {
  return new Set(tokens.map((t) => t.type));
}

describe("detectLanguage — extension → language, fail-closed", () => {
  it("maps the common extensions in this codebase", () => {
    expect(detectLanguage("src/app.ts")).toBe("typescript");
    expect(detectLanguage("packages/ui/src/x.tsx")).toBe("typescript");
    expect(detectLanguage("a/b/c.js")).toBe("javascript");
    expect(detectLanguage("tsconfig.json")).toBe("json");
    expect(detectLanguage("styles/main.css")).toBe("css");
    expect(detectLanguage("scripts/run.py")).toBe("python");
    expect(detectLanguage("bin/deploy.sh")).toBe("shell");
    expect(detectLanguage("README.md")).toBe("markdown");
    expect(detectLanguage("ci/config.yml")).toBe("yaml");
    expect(detectLanguage("index.html")).toBe("html");
  });

  it("returns null for unknown, missing, or dotfile extensions (→ plain text)", () => {
    expect(detectLanguage("Makefile")).toBeNull();
    expect(detectLanguage("data.bin")).toBeNull();
    expect(detectLanguage("no-extension")).toBeNull();
    expect(detectLanguage(".zshrc")).toBeNull(); // leading-dot dotfile, not an extension
    expect(detectLanguage("weird.")).toBeNull();
  });

  it("ignores query/hash suffixes and directory dots", () => {
    expect(detectLanguage("a.b.dir/file.ts?raw")).toBe("typescript");
    expect(detectLanguage("x.ts#L10")).toBe("typescript");
  });
});

describe("tokenizeLine — the lossless invariant (never drops or duplicates a char)", () => {
  const samples: Array<[string, ReturnType<typeof detectLanguage>]> = [
    ["const value5 = compute(5) + 1;", "typescript"],
    ["+  const b = 3; // added", "typescript"],
    ["-  const legacy = compute(2);", "typescript"],
    ['{ "name": "rennet", "count": 42, "ok": true }', "json"],
    [".code-view { color: red; padding: 12px; } /* c */", "css"],
    ["def handle(self, x): return x  # note", "python"],
    ["for f in *.ts; do echo $HOME; done  # loop", "shell"],
    ["plain text with unicode ☕ and no language", null],
  ];
  it.each(samples)("reassembles %j exactly", (line, lang) => {
    const tokens = tokenizeLine(line, lang);
    expect(reassemble(tokens)).toBe(line);
  });
});

describe("tokenizeLine — TypeScript", () => {
  it("colours keywords, strings, numbers, comments, functions, types", () => {
    const line = "export const x: number = f(41 + 1); // note";
    const tokens = tokenizeLine(line, "typescript");
    expect(hasToken(tokens, "keyword", "export")).toBe(true);
    expect(hasToken(tokens, "keyword", "const")).toBe(true);
    expect(hasToken(tokens, "type", "number")).toBe(true);
    expect(hasToken(tokens, "function", "f")).toBe(true);
    expect(hasToken(tokens, "number", "41")).toBe(true);
    expect(hasToken(tokens, "number", "1")).toBe(true);
    // The `//` marker merges with the comment body into one comment run.
    expect(hasToken(tokens, "comment", "// note")).toBe(true);
  });

  it("recognises strings (single, double, template) and Capitalized types", () => {
    expect(hasToken(tokenizeLine('const s = "hi";', "typescript"), "string", '"hi"')).toBe(true);
    expect(hasToken(tokenizeLine("const s = 'yo';", "typescript"), "string", "'yo'")).toBe(true);
    expect(hasToken(tokenizeLine("const s = `t`;", "typescript"), "string", "`t`")).toBe(true);
    expect(hasToken(tokenizeLine("let m: Widget;", "typescript"), "type", "Widget")).toBe(true);
  });

  it("keeps the leading diff marker as a non-semantic token (it inherits the row tint)", () => {
    // The CodeView tokenizes the whole row text INCLUDING the +/- marker; the marker
    // must never become a keyword/string/etc — it stays operator/plain so it inherits
    // the diff-tinted base colour. (tokenizeDiffLine owns the marker split; here the
    // whole line is tokenized so the first token is the leading whitespace/plain run.)
    const added = tokenizeLine("+  const b = 3;", "typescript");
    const first = added[0];
    expect(first).toBeDefined();
    expect(first?.type === "operator" || first?.type === "plain").toBe(true);
    expect(hasToken(added, "keyword", "const")).toBe(true);
    expect(hasToken(added, "number", "3")).toBe(true);
  });
});

describe("tokenizeLine — JSON / Python / shell keys and comments", () => {
  it("JSON values keep their type; a quoted key is an inert string, not a symbol", () => {
    const tokens = tokenizeLine('  "name": "rennet",', "json");
    expect(hasToken(tokens, "string", '"rennet"')).toBe(true);
    // Line-locally (no `{` on the row) a quoted key reads as a plain string — inert,
    // never a clickable property. Either way it is a string, so the symbol layer
    // leaves it alone.
    expect(hasToken(tokens, "string", '"name"')).toBe(true);
    expect(typesOf(tokens).has("keyword")).toBe(false);
  });

  it("Python def/comment", () => {
    const tokens = tokenizeLine("def handle(x):  # do it", "python");
    expect(hasToken(tokens, "keyword", "def")).toBe(true);
    expect(hasToken(tokens, "function", "handle")).toBe(true);
    expect(hasToken(tokens, "comment", "# do it")).toBe(true);
  });

  it("shell variables and comments", () => {
    const tokens = tokenizeLine("echo $HOME  # print", "shell");
    expect(hasToken(tokens, "variable", "$HOME")).toBe(true);
    expect(hasToken(tokens, "comment", "# print")).toBe(true);
  });

  it("shell: a `#` glued to a word is not a comment", () => {
    const glued = tokenizeLine("echo foo#bar", "shell");
    expect(typesOf(glued).has("comment")).toBe(false);
    expect(reassemble(glued)).toBe("echo foo#bar");
  });
});

describe("tokenizeLine — number literals fail closed when malformed (#92)", () => {
  // shiki 4.4.3 scopes some malformed numeric literals as `number`; the old bespoke
  // scanner failed them CLOSED to plain. A canonical numeric-literal validator in
  // shiki.ts reclassifies a malformed `number` token back to plain. Each case is a
  // single token, so it must be exactly one plain token when malformed.
  it.each([
    "0b10_", // trailing separator
    "1_", // trailing separator
    "1__0", // doubled separator
    "1e10_", // exponent with trailing separator
    "0b102", // binary digit out of range
    "0o18", // octal digit out of range
    "0x_", // hex prefix, no digit before separator
    "0b_", // binary prefix, bare separator
  ])("a malformed literal is one plain token, never a number: %s", (candidate) => {
    expect(tokenizeLine(candidate, "typescript")).toEqual([{ text: candidate, type: "plain" }]);
  });

  it.each(["0b101", "0o17", "0xFF", "0xFF_FF", "1_000", "1e10", "1.5", "1e10_000"])(
    "a valid literal still colours as a number: %s",
    (candidate) => {
      expect(hasToken(tokenizeLine(candidate, "typescript"), "number", candidate)).toBe(true);
    },
  );
});

describe("tokenizeLine — fail-closed and graceful degradation", () => {
  it("an unknown language yields exactly one plain token", () => {
    const tokens = tokenizeLine("const x = 1;", null);
    expect(tokens).toEqual([{ text: "const x = 1;", type: "plain" }]);
    expect(typesOf(tokens)).toEqual(new Set(["plain"]));
  });

  it("an empty line yields no tokens", () => {
    expect(tokenizeLine("", "typescript")).toEqual([]);
  });

  it("a line past the length cap degrades to a single plain token (never blocks render)", () => {
    const long = `const x = ${"a".repeat(MAX_HIGHLIGHT_LINE_LENGTH)};`;
    const tokens = tokenizeLine(long, "typescript");
    expect(tokens).toEqual([{ text: long, type: "plain" }]);
  });

  it("a token-dense line UNDER the length cap still degrades to a single plain token (R16 node budget)", () => {
    // A line of alternating single-char tokens is short in characters but explodes
    // into one DOM span per token — enough to blow the CodeView's node envelope. It
    // has no useful structure, so it degrades to plain (the same contract as the
    // length cap, keyed on token count). Red-able: remove MAX_HIGHLIGHT_LINE_TOKENS
    // and this line tokenizes into hundreds of spans instead of one.
    const dense = `${"a+".repeat(MAX_HIGHLIGHT_LINE_TOKENS)}a`;
    expect(dense.length).toBeLessThanOrEqual(MAX_HIGHLIGHT_LINE_LENGTH); // NOT caught by length
    const tokens = tokenizeLine(dense, "typescript");
    expect(tokens).toEqual([{ text: dense, type: "plain" }]);
  });

  it("a line at or under the token cap keeps its highlighting (the cap does not touch real code)", () => {
    const normal = "export const value = compute(41 + 1) + other(2) - third(3);";
    const tokens = tokenizeLine(normal, "typescript");
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.length).toBeLessThanOrEqual(MAX_HIGHLIGHT_LINE_TOKENS);
    expect(hasToken(tokens, "keyword", "const")).toBe(true);
  });

  it("never fabricates colour: a line of only whitespace/punctuation has no semantic hue", () => {
    const tokens = tokenizeLine("   {}[](),;", "typescript");
    const semantic = tokens.filter(
      (t) => t.type === "keyword" || t.type === "string" || t.type === "type",
    );
    expect(semantic).toHaveLength(0);
    expect(reassemble(tokens)).toBe("   {}[](),;");
  });
});
