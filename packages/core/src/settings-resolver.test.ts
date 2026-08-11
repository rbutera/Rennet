import type { GlobalConfig } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_SCHEME,
  BUILTIN_VISIBILITY,
  resolvePromoted,
  resolveScheme,
  resolveVisibility,
} from "./settings-resolver";

describe("resolveScheme", () => {
  it("falls back to the builtin when the global config sets nothing", () => {
    const resolved = resolveScheme({ version: 1 });
    expect(resolved.value).toBe(BUILTIN_SCHEME);
    expect(resolved.layer).toBe("builtin");
    // The builtin contribution is the effective one, and it is the only one.
    expect(resolved.provenance.layer).toBe("builtin");
    expect(resolved.provenance.contributions).toEqual([
      { layer: "builtin", value: "system", effective: true },
    ]);
  });

  it("lets the global layer override the builtin, carrying both contributions", () => {
    const global: GlobalConfig = { version: 1, appearance: { scheme: "light" } };
    const resolved = resolveScheme(global);
    expect(resolved.value).toBe("light");
    expect(resolved.layer).toBe("global");
    expect(resolved.provenance.contributions).toEqual([
      { layer: "builtin", value: "system", effective: false },
      { layer: "global", value: "light", effective: true },
    ]);
  });
});

describe("resolveVisibility", () => {
  it("resolves to the builtin `local` when the project has no stored value", () => {
    const resolved = resolveVisibility(undefined);
    expect(resolved.value).toBe(BUILTIN_VISIBILITY);
    expect(resolved.layer).toBe("builtin");
    expect(resolved.provenance.contributions).toEqual([
      { layer: "builtin", value: "local", effective: true },
    ]);
  });

  it("lets the repo layer override the builtin, flagging the effective contribution", () => {
    const resolved = resolveVisibility("git-visible");
    expect(resolved.value).toBe("git-visible");
    expect(resolved.layer).toBe("repo");
    expect(resolved.provenance.contributions).toEqual([
      { layer: "builtin", value: "local", effective: false },
      { layer: "repo", value: "git-visible", effective: true },
    ]);
  });

  it("keeps the effective flag on exactly one contribution even when the repo value equals the builtin", () => {
    const resolved = resolveVisibility("local");
    // Both offers are `local`, but only the highest (repo) is effective.
    expect(resolved.layer).toBe("repo");
    const effective = resolved.provenance.contributions.filter((c) => c.effective);
    expect(effective).toHaveLength(1);
    expect(effective[0]?.layer).toBe("repo");
  });
});

describe("resolvePromoted", () => {
  it("resolves to the builtin `false` when the project has no stored value, stringifying for display", () => {
    const resolved = resolvePromoted(undefined);
    expect(resolved.value).toBe(false);
    expect(resolved.layer).toBe("builtin");
    // A boolean setting renders its value as a string on the provenance surface.
    expect(resolved.provenance.contributions).toEqual([
      { layer: "builtin", value: "false", effective: true },
    ]);
  });

  it("distinguishes a repo-set `false` from the builtin `false` (the wireframe's source rule)", () => {
    const resolved = resolvePromoted(false);
    // Value is the same `false`, but the LAYER is `repo` — an explicit set, not a default.
    expect(resolved.value).toBe(false);
    expect(resolved.layer).toBe("repo");
    expect(resolved.provenance.contributions).toEqual([
      { layer: "builtin", value: "false", effective: false },
      { layer: "repo", value: "false", effective: true },
    ]);
  });

  it("carries a repo-set `true` with provenance", () => {
    const resolved = resolvePromoted(true);
    expect(resolved.value).toBe(true);
    expect(resolved.layer).toBe("repo");
    expect(resolved.provenance.contributions.at(-1)).toEqual({
      layer: "repo",
      value: "true",
      effective: true,
    });
  });
});
