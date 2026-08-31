import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { PublishReceiptStore } from "./publish-receipt-store";

const RECEIPT = {
  reviewId: "review-1",
  marker: "a".repeat(64),
  verdict: "REQUEST_CHANGES" as const,
  lineCommentCount: 2,
  reviewRef: "PRR_17",
  url: "https://github.com/acme/widget/pull/7#pullrequestreview-17",
};

function root(): string {
  return mkdtempSync(join(tmpdir(), "rennet-publish-receipts-"));
}

describe("PublishReceiptStore", () => {
  it("persists a provider receipt by review and marker across store instances", () => {
    const directory = root();
    const first = new PublishReceiptStore(directory);

    expect(first.read(RECEIPT.reviewId, RECEIPT.marker)).toEqual({ status: "missing" });
    expect(first.save(RECEIPT)).toEqual({
      status: "stored",
      value: { version: 1, ...RECEIPT },
    });
    expect(new PublishReceiptStore(directory).read(RECEIPT.reviewId, RECEIPT.marker)).toEqual({
      status: "stored",
      value: { version: 1, ...RECEIPT },
    });
  });

  it("keeps the first successful receipt for one operation identity", () => {
    const directory = root();
    const first = new PublishReceiptStore(directory);
    const second = new PublishReceiptStore(directory);
    first.save(RECEIPT);

    expect(
      second.save({
        ...RECEIPT,
        reviewRef: "PRR_wrong",
        url: "https://github.com/acme/widget/pull/7#pullrequestreview-wrong",
      }),
    ).toEqual({ status: "stored", value: { version: 1, ...RECEIPT } });
  });

  it("reports malformed state and does not overwrite it", () => {
    const directory = root();
    const path = join(directory, sha256Hex(RECEIPT.reviewId), `${RECEIPT.marker}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json", { flag: "wx" });
    const store = new PublishReceiptStore(directory);

    expect(store.read(RECEIPT.reviewId, RECEIPT.marker)).toMatchObject({ status: "malformed" });
    expect(store.save(RECEIPT)).toMatchObject({ status: "malformed" });
  });
});
