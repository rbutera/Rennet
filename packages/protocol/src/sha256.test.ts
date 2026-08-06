import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

function nodeSha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("sha256Hex", () => {
  // FIPS-180-4 / NIST known-answer vectors. These are ground truth we did not
  // produce, so they prove the implementation rather than merely exercising it.
  it("hashes the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes a 448-bit message spanning a block boundary", () => {
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches node:crypto across ASCII, multibyte, and block-boundary lengths", () => {
    const inputs = [
      "",
      "a",
      "é",
      "🌱 rennet",
      "x".repeat(55),
      "x".repeat(56),
      "x".repeat(64),
      "y".repeat(1000),
    ];
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(nodeSha256(input));
    }
  });

  it("is deterministic and length-stable", () => {
    const digest = sha256Hex("rennet");
    expect(digest).toBe(sha256Hex("rennet"));
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
