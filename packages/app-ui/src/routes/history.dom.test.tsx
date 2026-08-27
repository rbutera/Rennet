// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Route, Router, useParams, useSearch } from "wouter";
import { mount } from "../test/dom";
import { hashHistory } from "./history";

// Finding 3 regression: an Electron hash DEEP LINK keeps BOTH the path and the query
// inside the fragment (`#/s/review-1?view=map`). wouter's bundled hash hook returns the
// whole fragment un-split (corrupting `:slug` into `review-1?view=map`) and reads the
// empty real `location.search`. The paired hooks must split the fragment on `?`.

function Probe() {
  const params = useParams();
  const search = useSearch();
  return <div data-testid="probe" data-slug={params.slug} data-search={search} />;
}

describe("hashHistory — paired hash location + search hooks", () => {
  it("splits a REAL hash deep link: the slug stays clean and the query is seen", () => {
    window.location.hash = "#/s/review-1?view=map"; // a real fragment, not memory history
    const { getByTestId } = mount(
      <Router hook={hashHistory.hook} searchHook={hashHistory.searchHook}>
        <Route path="/s/:slug" component={Probe} />
      </Router>,
    );
    const probe = getByTestId("probe");
    expect(probe.getAttribute("data-slug")).toBe("review-1"); // NOT "review-1?view=map"
    expect(probe.getAttribute("data-search")).toBe("view=map");
    window.location.hash = "";
  });
});
