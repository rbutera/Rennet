import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { PublishCompositionStore } from "./publish-composition-store";

function root(): string {
  return mkdtempSync(join(tmpdir(), "rennet-publish-compositions-"));
}

describe("PublishCompositionStore", () => {
  it("persists one opener and a fresh store instance reads the exact bytes", () => {
    const directory = root();
    const first = new PublishCompositionStore(directory);
    expect(first.readReviewOpener("review-1", "source-1")).toEqual({ status: "missing" });

    expect(
      first.saveReviewOpener({
        reviewId: "review-1",
        sourceId: "source-1",
        opener: "The retry boundary now has one owner.",
        model: "gpt-5.6-luna",
      }),
    ).toEqual({
      status: "stored",
      value: {
        version: 1,
        reviewId: "review-1",
        sourceId: "source-1",
        opener: "The retry boundary now has one owner.",
        model: "gpt-5.6-luna",
      },
    });

    expect(
      new PublishCompositionStore(directory).readReviewOpener("review-1", "source-1"),
    ).toMatchObject({
      status: "stored",
      value: { opener: "The retry boundary now has one owner." },
    });
  });

  it("keeps the first successful value when two writers race for one source identity", () => {
    const directory = root();
    const first = new PublishCompositionStore(directory);
    const second = new PublishCompositionStore(directory);
    first.saveReviewOpener({
      reviewId: "review-1",
      sourceId: "source-1",
      opener: "First stable opener.",
      model: "model-a",
    });
    expect(
      second.saveReviewOpener({
        reviewId: "review-1",
        sourceId: "source-1",
        opener: "Different later opener.",
        model: "model-b",
      }),
    ).toMatchObject({
      status: "stored",
      value: { opener: "First stable opener.", model: "model-a" },
    });
  });

  it("reports malformed persisted state and never overwrites it", () => {
    const directory = root();
    const path = join(directory, sha256Hex("review-1"), "source-1.json");
    const store = new PublishCompositionStore(directory);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json", { flag: "wx" });
    expect(store.readReviewOpener("review-1", "source-1")).toMatchObject({
      status: "malformed",
    });
    expect(
      store.saveReviewOpener({
        reviewId: "review-1",
        sourceId: "source-1",
        opener: "Would hide corruption.",
        model: "model",
      }),
    ).toMatchObject({ status: "malformed" });
  });

  it("stores changed source identities independently", () => {
    const directory = root();
    const store = new PublishCompositionStore(directory);
    for (const sourceId of ["source-1", "source-2"]) {
      expect(
        store.saveReviewOpener({
          reviewId: "review-1",
          sourceId,
          opener: `Opener for ${sourceId}.`,
          model: "model",
        }),
      ).toMatchObject({ status: "stored", value: { sourceId } });
    }
  });
});
