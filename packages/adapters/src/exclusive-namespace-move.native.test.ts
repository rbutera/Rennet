import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExclusiveNamespaceMover } from "./exclusive-namespace-move";

const binaryName =
  process.platform === "win32" ? "rennet-exclusive-move.exe" : "rennet-exclusive-move";
const helperPath = join(
  dirname(import.meta.dirname),
  "dist",
  "native",
  `${process.platform}-${process.arch}`,
  binaryName,
);
const mover = createExclusiveNamespaceMover({ helperPath });

async function expectMissing(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("exclusive namespace move native semantics", () => {
  let scratchRoot: string;

  beforeEach(async () => {
    scratchRoot = await mkdtemp(join(tmpdir(), "rennet-exclusive-move-test-"));
  });

  afterEach(async () => {
    await rm(scratchRoot, { force: true, recursive: true });
  });

  it("moves a regular file to an absent destination", async () => {
    const sourcePath = join(scratchRoot, "source ; $ literal ' ü.txt");
    const destinationPath = join(scratchRoot, "destination [literal] ü.txt");
    await writeFile(sourcePath, "source payload");
    const sourceInode = (await lstat(sourcePath)).ino;

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toEqual({ kind: "moved" });

    await expectMissing(sourcePath);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe("source payload");
    expect((await lstat(destinationPath)).ino).toBe(sourceInode);
  });

  it("does not replace an existing destination", async () => {
    const sourcePath = join(scratchRoot, "source.txt");
    const destinationPath = join(scratchRoot, "destination.txt");
    await writeFile(sourcePath, "source payload");
    await writeFile(destinationPath, "destination payload");

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toMatchObject({
      kind: "destination-exists",
    });

    await expect(readFile(sourcePath, "utf8")).resolves.toBe("source payload");
    await expect(readFile(destinationPath, "utf8")).resolves.toBe("destination payload");
  });

  it("moves a dangling symlink without following it", async () => {
    const sourcePath = join(scratchRoot, "source-link");
    const destinationPath = join(scratchRoot, "destination-link");
    await symlink("missing-target", sourcePath, process.platform === "win32" ? "file" : undefined);

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toEqual({ kind: "moved" });

    await expectMissing(sourcePath);
    expect((await lstat(destinationPath)).isSymbolicLink()).toBe(true);
    await expect(readlink(destinationPath)).resolves.toBe("missing-target");
  });

  it("moves a non-empty directory as one namespace entry", async () => {
    const sourcePath = join(scratchRoot, "source-directory");
    const destinationPath = join(scratchRoot, "destination-directory");
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, "child.txt"), "child payload");

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toEqual({ kind: "moved" });

    await expectMissing(sourcePath);
    await expect(readFile(join(destinationPath, "child.txt"), "utf8")).resolves.toBe(
      "child payload",
    );
  });

  it("does not replace an existing directory", async () => {
    const sourcePath = join(scratchRoot, "source-directory");
    const destinationPath = join(scratchRoot, "destination-directory");
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, "source-child.txt"), "source payload");
    await mkdir(destinationPath);
    await writeFile(join(destinationPath, "destination-child.txt"), "destination payload");
    const destinationInode = (await lstat(destinationPath)).ino;

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toMatchObject({
      kind: "destination-exists",
    });

    await expect(readFile(join(sourcePath, "source-child.txt"), "utf8")).resolves.toBe(
      "source payload",
    );
    expect((await lstat(destinationPath)).ino).toBe(destinationInode);
    await expect(readFile(join(destinationPath, "destination-child.txt"), "utf8")).resolves.toBe(
      "destination payload",
    );
    await expectMissing(join(destinationPath, "source-child.txt"));
  });

  it("reports a missing source without creating the destination", async () => {
    const sourcePath = join(scratchRoot, "missing-source");
    const destinationPath = join(scratchRoot, "destination");

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toMatchObject({
      kind: "path-missing",
    });
    await expectMissing(destinationPath);
  });

  it("allows exactly one winner when contenders race for one destination", async () => {
    const destinationPath = join(scratchRoot, "winner.txt");
    const contenders = Array.from({ length: 32 }, (_, index) => ({
      path: join(scratchRoot, `contender-${index}.txt`),
      payload: `payload-${index}`,
    }));
    await Promise.all(contenders.map((contender) => writeFile(contender.path, contender.payload)));

    const outcomes = await Promise.all(
      contenders.map((contender) => mover.move({ sourcePath: contender.path, destinationPath })),
    );
    const winners = outcomes.flatMap((outcome, index) => (outcome.kind === "moved" ? [index] : []));

    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (winner === undefined) throw new Error("exclusive move race had no winner");
    const winningContender = contenders[winner];
    if (winningContender === undefined)
      throw new Error("exclusive move race winner was out of range");
    expect(outcomes.filter((outcome) => outcome.kind === "destination-exists")).toHaveLength(31);
    expect(
      outcomes.every(
        (outcome) => outcome.kind === "moved" || outcome.kind === "destination-exists",
      ),
    ).toBe(true);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe(winningContender.payload);
    await expectMissing(winningContender.path);
    for (const [index, contender] of contenders.entries()) {
      if (index !== winner)
        await expect(readFile(contender.path, "utf8")).resolves.toBe(contender.payload);
    }
  });

  it("allows exactly one directory winner when contenders race for one destination", async () => {
    const destinationPath = join(scratchRoot, "winner-directory");
    const contenders = Array.from({ length: 32 }, (_, index) => ({
      path: join(scratchRoot, `contender-directory-${index}`),
      payload: `payload-${index}`,
    }));
    await Promise.all(
      contenders.map(async (contender) => {
        await mkdir(contender.path);
        await writeFile(join(contender.path, "payload.txt"), contender.payload);
      }),
    );

    const outcomes = await Promise.all(
      contenders.map((contender) => mover.move({ sourcePath: contender.path, destinationPath })),
    );
    const winners = outcomes.flatMap((outcome, index) => (outcome.kind === "moved" ? [index] : []));

    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (winner === undefined) throw new Error("exclusive directory move race had no winner");
    const winningContender = contenders[winner];
    if (winningContender === undefined)
      throw new Error("exclusive directory move race winner was out of range");
    expect(outcomes.filter((outcome) => outcome.kind === "destination-exists")).toHaveLength(31);
    expect(
      outcomes.every(
        (outcome) => outcome.kind === "moved" || outcome.kind === "destination-exists",
      ),
    ).toBe(true);
    await expect(readFile(join(destinationPath, "payload.txt"), "utf8")).resolves.toBe(
      winningContender.payload,
    );
    await expectMissing(winningContender.path);
    for (const [index, contender] of contenders.entries()) {
      if (index !== winner)
        await expect(readFile(join(contender.path, "payload.txt"), "utf8")).resolves.toBe(
          contender.payload,
        );
    }
  });
});
