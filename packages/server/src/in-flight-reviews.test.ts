import { describe, expect, it } from "vitest";
import { InFlightReviews } from "./in-flight-reviews";

describe("InFlightReviews — the running-turn set (#383 batch)", () => {
  it("a review is running between enter and leave", () => {
    const inFlight = new InFlightReviews();
    expect(inFlight.has("r1")).toBe(false);
    inFlight.enter("r1");
    expect(inFlight.has("r1")).toBe(true);
    inFlight.leave("r1");
    expect(inFlight.has("r1")).toBe(false);
  });

  it("stays running until the LAST overlapping turn leaves (counted)", () => {
    const inFlight = new InFlightReviews();
    inFlight.enter("r1");
    inFlight.enter("r1"); // an ask starts while a regenerate is still running
    inFlight.leave("r1");
    expect(inFlight.has("r1")).toBe(true); // one turn still in flight
    inFlight.leave("r1");
    expect(inFlight.has("r1")).toBe(false);
  });

  it("leave past zero is a harmless no-op", () => {
    const inFlight = new InFlightReviews();
    inFlight.leave("r1");
    expect(inFlight.has("r1")).toBe(false);
  });
});
