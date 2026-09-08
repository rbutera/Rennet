import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { archiveEncryptedCookies } from "./cookie-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("archives only cookies, resumes a partial archive, and leaves new cookies on restart", () => {
  const root = mkdtempSync(join(tmpdir(), "rennet-cookie-store-"));
  roots.push(root);
  const archive = join(root, "encrypted-cookies-backup");
  mkdirSync(archive);
  writeFileSync(join(archive, "Cookies"), "already moved encrypted database");
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    writeFileSync(join(root, `Cookies${suffix}`), suffix);
  }
  writeFileSync(join(root, "Preferences"), "appearance");
  mkdirSync(join(root, "Local Storage"));
  writeFileSync(join(root, "Local Storage", "state"), "onboarding and projects");

  archiveEncryptedCookies(root);

  expect(readdirSync(root).sort()).toEqual([
    "Local Storage",
    "Preferences",
    "encrypted-cookies-backup",
  ]);
  expect(readFileSync(join(archive, "Cookies"), "utf8")).toBe("already moved encrypted database");
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    expect(readFileSync(join(archive, `Cookies${suffix}`), "utf8")).toBe(suffix);
  }
  expect(readFileSync(join(root, "Preferences"), "utf8")).toBe("appearance");
  expect(readFileSync(join(root, "Local Storage", "state"), "utf8")).toBe(
    "onboarding and projects",
  );

  writeFileSync(join(root, "Cookies"), "new unencrypted cookies");
  archiveEncryptedCookies(root);
  expect(readFileSync(join(root, "Cookies"), "utf8")).toBe("new unencrypted cookies");
  expect(readFileSync(join(archive, "Cookies"), "utf8")).toBe("already moved encrypted database");
});

it("initializes a fresh profile and archives an existing database byte for byte", () => {
  for (const existing of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "rennet-cookie-store-"));
    roots.push(root);
    const bytes = Buffer.from([0, 255, 1, 128]);
    if (existing) writeFileSync(join(root, "Cookies"), bytes);
    archiveEncryptedCookies(root);
    const archive = join(root, "encrypted-cookies-backup");
    expect(readdirSync(archive).sort()).toEqual(existing ? ["Cookies", "complete"] : ["complete"]);
    if (existing) expect(readFileSync(join(archive, "Cookies"))).toEqual(bytes);
  }
});
