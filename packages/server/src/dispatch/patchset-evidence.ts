import { posix } from "node:path";
import {
  DIFF_TRUNCATION_MARKER,
  implementationPathFor,
  isTestPath,
  parseCommandInput,
  parseCommandOutput,
  testPathsFor,
} from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

const testFile = (path: string) => isTestPath(path) || /(?:^|\/)__tests__\//.test(path);
const withoutExtension = (path: string) => path.replace(/\.[cm]?[jt]sx?$/, "");

/** Import relationships are evidence; similarly named files alone remain a fallback. */
export function importedImplementations(
  test: string,
  source: string,
  paths: readonly string[],
): string[] {
  const tokens =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|\/(?:\\.|[^/\\\n])+\/[dgimsuvy]*|(?:\bimport\s+(?:[^;'"`]*?\s+from\s*)?|\b(?:import|require)\s*\(\s*)(['"])([^'"\n]+)\1|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
  const imports = [...source.matchAll(tokens)].flatMap((match) => {
    const imported = match[2];
    return imported?.startsWith(".")
      ? [posix.normalize(posix.join(posix.dirname(test), imported))]
      : [];
  });
  return paths.filter(
    (path) =>
      !testFile(path) &&
      imports.some(
        (name) =>
          withoutExtension(path) === withoutExtension(name) ||
          withoutExtension(path) === `${name}/index`,
      ),
  );
}

export function evidenceReader(rt: DispatchRuntime): CommandHandler {
  const indexes = new Map<string, Promise<Map<string, string[]>>>();
  return async (rawInput) => {
    const name = "patchset.readEvidence";
    const { ref, includeSource, includeCounterparts } = parseCommandInput(name, rawInput);
    const patchset = rt.service.patchsetById(ref.patchsetId);
    if (!patchset) throw new Error(`Patchset ${ref.patchsetId} is not in this Rennet's store.`);
    const { repository } = patchset;
    const headOid = repository.reviewedTreeOid ?? repository.headOid;
    const file = patchset.files.find(
      (entry) => entry.path === ref.path || entry.previousPath === ref.path,
    );
    if (file?.binary) throw new Error(`${ref.path} is binary; the capture holds no text to cite.`);
    const path = file?.path ?? ref.path;
    const previousPath = file?.previousPath ?? path;
    const read = async (oid: string, filePath: string) => {
      try {
        return (
          (await rt.deps.readBlobAtOid?.({ root: repository.root, oid, path: filePath })) ?? null
        );
      } catch {
        return null;
      }
    };
    let index = indexes.get(patchset.id);
    if (includeCounterparts && !index) {
      index = (async () => {
        const treePaths =
          (await rt.deps.listTreePaths?.({ root: repository.root, oid: headOid })) ?? [];
        const paths = [...new Set([...treePaths, ...patchset.files.map((entry) => entry.path)])];
        const pairs = new Map<string, string[]>();
        const link = (impl: string, test: string) => {
          pairs.set(impl, [...new Set([...(pairs.get(impl) ?? []), test])]);
          pairs.set(test, [...new Set([...(pairs.get(test) ?? []), impl])]);
        };
        // Bound concurrent object reads without discarding tests in large repositories.
        const tests = paths.filter(testFile);
        for (let start = 0; start < tests.length; start += 16) {
          await Promise.all(
            tests.slice(start, start + 16).map(async (test) => {
              const text = await read(headOid, test);
              for (const impl of importedImplementations(test, text ?? "", paths)) link(impl, test);
              const conventional = implementationPathFor(test);
              if (conventional && paths.includes(conventional)) link(conventional, test);
            }),
          );
        }
        for (const impl of paths.filter((entry) => !testFile(entry))) {
          for (const test of testPathsFor(impl)) if (paths.includes(test)) link(impl, test);
        }
        return pairs;
      })();
      indexes.set(patchset.id, index);
    }
    const completePatch = file?.patch.includes(DIFF_TRUNCATION_MARKER)
      ? ((await rt.deps.readFilePatchAtOids?.({
          root: repository.root,
          baseOid: repository.baseOid,
          headOid,
          paths: [...new Set([previousPath, path])],
        })) ?? null)
      : undefined;
    const sources =
      (includeSource || !file) && completePatch !== null
        ? await Promise.all([
            file?.status === "added" ? null : read(repository.baseOid, previousPath),
            file?.status === "deleted" ? null : read(headOid, path),
          ])
        : undefined;
    const [base, head] = sources ?? [];
    return parseCommandOutput(name, {
      patch: completePatch ?? file?.patch ?? "",
      path,
      ...(previousPath === path ? {} : { previousPath }),
      ...(sources ? { base, head } : {}),
      counterparts: includeCounterparts && index ? ((await index).get(path) ?? []) : [],
      ...(completePatch === null
        ? {
            caption:
              "The captured diff is truncated and the complete reviewed diff is unavailable. Only captured hunks are shown.",
          }
        : {}),
      ...(sources && base == null && head == null
        ? {
            caption: `The reviewed Git objects for ${path} are unavailable. Captured diff hunks remain below.`,
          }
        : {}),
    });
  };
}
