import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@rennet/protocol";

export interface StoredReviewOpener {
  readonly version: 1;
  readonly reviewId: string;
  readonly sourceId: string;
  readonly opener: string;
  readonly model: string;
}

export type StoredReviewOpenerRead =
  | { readonly status: "missing" }
  | { readonly status: "stored"; readonly value: StoredReviewOpener }
  | { readonly status: "malformed"; readonly reason: string };

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function parseRecord(raw: string, reviewId: string, sourceId: string): StoredReviewOpenerRead {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "malformed", reason: "the stored review opener is not valid JSON" };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("reviewId" in value) ||
    value.reviewId !== reviewId ||
    !("sourceId" in value) ||
    value.sourceId !== sourceId ||
    !("opener" in value) ||
    typeof value.opener !== "string" ||
    value.opener.trim() === "" ||
    !("model" in value) ||
    typeof value.model !== "string" ||
    value.model.trim() === ""
  ) {
    return { status: "malformed", reason: "the stored review opener has an invalid shape" };
  }
  return {
    status: "stored",
    value: {
      version: 1,
      reviewId,
      sourceId,
      opener: value.opener,
      model: value.model,
    },
  };
}

export class PublishCompositionStore {
  constructor(private readonly root: string) {}

  private entryPath(reviewId: string, sourceId: string): string {
    return join(this.root, sha256Hex(reviewId), `${sourceId}.json`);
  }

  readReviewOpener(reviewId: string, sourceId: string): StoredReviewOpenerRead {
    let raw: string;
    try {
      raw = readFileSync(this.entryPath(reviewId, sourceId), "utf8");
    } catch (error) {
      return errorCode(error) === "ENOENT"
        ? { status: "missing" }
        : { status: "malformed", reason: "the stored review opener could not be read" };
    }
    return parseRecord(raw, reviewId, sourceId);
  }

  saveReviewOpener(
    record: Omit<StoredReviewOpener, "version">,
  ): Exclude<StoredReviewOpenerRead, { status: "missing" }> {
    const existing = this.readReviewOpener(record.reviewId, record.sourceId);
    if (existing.status !== "missing") return existing;

    const path = this.entryPath(record.reviewId, record.sourceId);
    const directory = join(this.root, sha256Hex(record.reviewId));
    mkdirSync(directory, { recursive: true });
    const value: StoredReviewOpener = { version: 1, ...record };
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { flag: "wx" });
    let linkFailure: unknown;
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") linkFailure = error;
    }
    let cleanupFailure: unknown;
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") cleanupFailure = error;
    }
    if (linkFailure !== undefined) throw linkFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;

    const stored = this.readReviewOpener(record.reviewId, record.sourceId);
    if (stored.status === "missing") {
      return { status: "malformed", reason: "the review opener was not persisted" };
    }
    return stored;
  }
}
