import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyDetectedLogo,
  detectedLogoExists,
  extensionForLogoMime,
  logoFile,
  logoMimeForExtension,
  readLogo,
  writeUploadLogo,
} from "./project-mark-store";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mark-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(root: string, path: string, body: string | Uint8Array = "x"): string {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
}

describe("project mark store (#900, ADR 0004)", () => {
  it("maps MIME and extension through one table, both ways", () => {
    expect(extensionForLogoMime("image/jpeg")).toBe("jpg");
    expect(extensionForLogoMime("image/svg+xml")).toBe("svg");
    // A `.jpeg` in the repository reads as the same MIME the `.jpg` copy is stored under.
    expect(logoMimeForExtension(".jpeg")).toBe("image/jpeg");
    expect(logoMimeForExtension("jpg")).toBe("image/jpeg");
    expect(logoMimeForExtension("WEBP")).toBe("image/webp");
    expect(logoMimeForExtension(".gif")).toBeUndefined();
    expect(logoMimeForExtension(".ts")).toBeUndefined();
  });

  it("round-trips a detected logo: bytes, MIME, and the repo-relative source", () => {
    const store = new ProjectSnapshotStore(tempDir());
    const repo = tempDir();
    file(repo, "public/brand/mark.svg", "<svg>rennet</svg>");

    expect(detectedLogoExists(store, "esc")).toBe(false);
    expect(readLogo(store, "esc", "detected")).toBeNull();

    const written = copyDetectedLogo(store, "esc", repo, "public/brand/mark.svg");
    expect(written?.mimeType).toBe("image/svg+xml");
    expect(written?.path.endsWith("mark-detected.svg")).toBe(true);
    expect(detectedLogoExists(store, "esc")).toBe(true);

    const read = readLogo(store, "esc", "detected");
    expect(read?.mimeType).toBe("image/svg+xml");
    expect(Buffer.from(read?.bytesBase64 ?? "", "base64").toString("utf8")).toBe(
      "<svg>rennet</svg>",
    );
    expect(read?.source).toBe("public/brand/mark.svg");
  });

  it("a re-detect in another format REPLACES the previous file rather than shadowing it", () => {
    const store = new ProjectSnapshotStore(tempDir());
    const repo = tempDir();
    file(repo, "logo.png", "png-bytes");
    file(repo, "logo.svg", "svg-bytes");

    copyDetectedLogo(store, "esc", repo, "logo.png");
    expect(logoFile(store, "esc", "detected")?.mimeType).toBe("image/png");
    const stale = logoFile(store, "esc", "detected")?.path ?? "";

    copyDetectedLogo(store, "esc", repo, "logo.svg");
    // `logoFile` finds svg FIRST by table order, so a surviving png would be invisible
    // here — the assertion that matters is that the old file is gone from disk.
    expect(existsSync(stale)).toBe(false);
    expect(logoFile(store, "esc", "detected")?.mimeType).toBe("image/svg+xml");
    expect(readLogo(store, "esc", "detected")?.source).toBe("logo.svg");
  });

  it("refuses an escape, a directory, a missing file, and an unsupported format", () => {
    const store = new ProjectSnapshotStore(tempDir());
    const repo = tempDir();
    const outside = tempDir();
    file(outside, "secret.png", "secret");
    file(repo, "notes.txt");
    file(repo, "logo.gif");
    mkdirSync(join(repo, "assets"), { recursive: true });
    symlinkSync(join(outside, "secret.png"), join(repo, "linked.png"));

    for (const bad of [
      "../secret.png",
      join(outside, "secret.png"),
      "linked.png",
      "assets",
      "nothing-here.png",
      "notes.txt",
      "logo.gif",
    ]) {
      expect(copyDetectedLogo(store, "esc", repo, bad)).toBeNull();
    }
    expect(detectedLogoExists(store, "esc")).toBe(false);
    // The control: the same call with a real, supported, in-repo file DOES copy — so the
    // seven refusals above are the guard, not a copier that never works.
    file(repo, "logo.png", "png");
    expect(copyDetectedLogo(store, "esc", repo, "logo.png")).not.toBeNull();
  });

  it("an upload is stored per MIME with the picked file's name as its provenance", () => {
    const store = new ProjectSnapshotStore(tempDir());
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const written = writeUploadLogo(store, "esc", "image/png", bytes, "acme-mark@2x.png");
    expect(written.path.endsWith("mark-upload.png")).toBe(true);

    const read = readLogo(store, "esc", "upload");
    expect(read?.mimeType).toBe("image/png");
    expect(Buffer.from(read?.bytesBase64 ?? "", "base64")).toEqual(bytes);
    expect(read?.source).toBe("acme-mark@2x.png");
    // The two kinds are independent: an upload does not make a detected logo exist.
    expect(detectedLogoExists(store, "esc")).toBe(false);
  });

  it("a logo whose file was deleted underneath reads as absent, never as empty bytes", () => {
    const store = new ProjectSnapshotStore(tempDir());
    writeUploadLogo(store, "esc", "image/webp", Buffer.from("webp"), "x.webp");
    rmSync(logoFile(store, "esc", "upload")?.path ?? "", { force: true });
    expect(readLogo(store, "esc", "upload")).toBeNull();
  });

  it("a missing or malformed sidecar reads as a blank provenance, never an invented one", () => {
    const store = new ProjectSnapshotStore(tempDir());
    writeUploadLogo(store, "esc", "image/png", Buffer.from("png"), "real-name.png");
    const sidecar = join(store.paths("esc").projectDir, "mark-upload.json");
    writeFileSync(sidecar, "{not json");
    expect(readLogo(store, "esc", "upload")?.source).toBe("");
    rmSync(sidecar, { force: true });
    expect(readLogo(store, "esc", "upload")?.source).toBe("");
  });
});
