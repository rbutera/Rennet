import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeReviewEvent } from "@rennet/core";
import { sha256Hex } from "@rennet/protocol";

export interface StoredPublishReceipt {
  readonly version: 1;
  readonly reviewId: string;
  readonly marker: string;
  readonly verdict: ForgeReviewEvent;
  readonly lineCommentCount: number;
  readonly reviewRef: string;
  readonly url: string;
}

export type StoredPublishReceiptRead =
  | { readonly status: "missing" }
  | { readonly status: "stored"; readonly value: StoredPublishReceipt }
  | { readonly status: "malformed"; readonly reason: string };

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isForgeReviewEvent(value: unknown): value is ForgeReviewEvent {
  return value === "APPROVE" || value === "REQUEST_CHANGES" || value === "COMMENT";
}

function parseRecord(raw: string, reviewId: string, marker: string): StoredPublishReceiptRead {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "malformed", reason: "the stored publication receipt is not valid JSON" };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("reviewId" in value) ||
    value.reviewId !== reviewId ||
    !("marker" in value) ||
    value.marker !== marker ||
    !("verdict" in value) ||
    !isForgeReviewEvent(value.verdict) ||
    !("lineCommentCount" in value) ||
    typeof value.lineCommentCount !== "number" ||
    !Number.isInteger(value.lineCommentCount) ||
    value.lineCommentCount < 0 ||
    !("reviewRef" in value) ||
    typeof value.reviewRef !== "string" ||
    value.reviewRef.length === 0 ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !URL.canParse(value.url)
  ) {
    return { status: "malformed", reason: "the stored publication receipt has an invalid shape" };
  }
  return {
    status: "stored",
    value: {
      version: 1,
      reviewId,
      marker,
      verdict: value.verdict,
      lineCommentCount: value.lineCommentCount,
      reviewRef: value.reviewRef,
      url: value.url,
    },
  };
}

export class PublishReceiptStore {
  constructor(private readonly root: string) {}

  private entryPath(reviewId: string, marker: string): string {
    return join(this.root, sha256Hex(reviewId), `${marker}.json`);
  }

  read(reviewId: string, marker: string): StoredPublishReceiptRead {
    let raw: string;
    try {
      raw = readFileSync(this.entryPath(reviewId, marker), "utf8");
    } catch (error) {
      return errorCode(error) === "ENOENT"
        ? { status: "missing" }
        : { status: "malformed", reason: "the stored publication receipt could not be read" };
    }
    return parseRecord(raw, reviewId, marker);
  }

  save(record: Omit<StoredPublishReceipt, "version">): StoredPublishReceiptRead {
    const existing = this.read(record.reviewId, record.marker);
    if (existing.status !== "missing") return existing;

    const directory = join(this.root, sha256Hex(record.reviewId));
    const path = this.entryPath(record.reviewId, record.marker);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, ...record })}\n`, { flag: "wx" });
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
    return this.read(record.reviewId, record.marker);
  }
}
