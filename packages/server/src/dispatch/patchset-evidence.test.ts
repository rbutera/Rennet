import { describe, expect, it } from "vitest";
import { importedImplementations } from "./patchset-evidence";

const paths = ["src/cheese.ts", "src/curd.ts", "tests/maturing.test.ts"];

describe("immutable counterpart import evidence", () => {
  it("resolves multiline static imports, runtime imports and require paths", () => {
    expect(
      importedImplementations(
        "tests/maturing.test.ts",
        'import {\n cheese\n} from "../src/cheese.js";\nconst curd = require("../src/curd");',
        paths,
      ),
    ).toEqual(["src/cheese.ts", "src/curd.ts"]);
    expect(
      importedImplementations("tests/maturing.test.ts", 'await import("../src/cheese")', paths),
    ).toEqual(["src/cheese.ts"]);
  });
  it("does not fabricate relationships from commented code, examples or regex literals", () => {
    const source = [
      '// import cheese from "../src/cheese";',
      '/* import curd from "../src/curd"; */',
      "const example = 'import cheese from \"../src/cheese\";';",
      'const template = `import curd from "../src/curd";`;',
      'const pattern = /import cheese from "..src.cheese"/;',
    ].join("\n");
    expect(importedImplementations("tests/maturing.test.ts", source, paths)).toEqual([]);
  });
});
