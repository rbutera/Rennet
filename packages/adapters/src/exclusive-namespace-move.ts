import { execFile } from "node:child_process";

export type ExclusiveNamespaceMoveOutcome =
  | { readonly kind: "moved" }
  | { readonly kind: "destination-exists"; readonly nativeCode: number }
  | { readonly kind: "path-missing"; readonly nativeCode: number }
  | { readonly kind: "cross-device"; readonly nativeCode: number }
  | { readonly kind: "unsupported"; readonly nativeCode: number }
  | { readonly kind: "failed"; readonly nativeCode: number }
  | {
      readonly kind: "helper-unavailable";
      readonly code: string;
      readonly detail: string;
    }
  | { readonly kind: "outcome-unknown"; readonly detail: string };

export interface ExclusiveNamespaceMover {
  move(input: {
    readonly sourcePath: string;
    readonly destinationPath: string;
  }): Promise<ExclusiveNamespaceMoveOutcome>;
}

export type ExclusiveMoveHelperExecution =
  | { readonly kind: "exited"; readonly exitCode: number; readonly stderr: string }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly detail: string;
    }
  | {
      readonly kind: "interrupted";
      readonly signal: NodeJS.Signals | null;
      readonly detail: string;
    };

export type RunExclusiveMoveHelper = (input: {
  readonly helperPath: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
}) => Promise<ExclusiveMoveHelperExecution>;

const runExclusiveMoveHelper: RunExclusiveMoveHelper = (input) =>
  new Promise((resolve) => {
    execFile(
      input.helperPath,
      [input.sourcePath, input.destinationPath],
      {
        encoding: "utf8",
        maxBuffer: 1024,
        shell: false,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ kind: "exited", exitCode: 0, stderr });
          return;
        }

        if (typeof error.code === "number") {
          resolve({ kind: "exited", exitCode: error.code, stderr });
          return;
        }

        if (error.signal !== undefined && error.signal !== null) {
          resolve({
            kind: "interrupted",
            signal: error.signal,
            detail: `exclusive move helper terminated by ${error.signal}`,
          });
          return;
        }

        const code = typeof error.code === "string" ? error.code : "EXEC_FAILED";
        if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC") {
          resolve({ kind: "unavailable", code, detail: error.message });
          return;
        }

        resolve({ kind: "interrupted", signal: null, detail: error.message });
      },
    );
  });

function nativeCodeOf(stderr: string): number | null {
  const match = /^native-code=(\d+)\r?\n?$/.exec(stderr);
  const value = match?.[1];
  if (value === undefined) return null;
  const nativeCode = Number.parseInt(value, 10);
  return Number.isSafeInteger(nativeCode) ? nativeCode : null;
}

function unknownHelperResult(execution: {
  readonly exitCode: number;
  readonly stderr: string;
}): ExclusiveNamespaceMoveOutcome {
  return {
    kind: "outcome-unknown",
    detail: `exclusive move helper returned exit ${execution.exitCode} with stderr ${JSON.stringify(execution.stderr)}`,
  };
}

function outcomeOf(execution: ExclusiveMoveHelperExecution): ExclusiveNamespaceMoveOutcome {
  switch (execution.kind) {
    case "unavailable":
      return {
        kind: "helper-unavailable",
        code: execution.code,
        detail: execution.detail,
      };
    case "interrupted":
      return { kind: "outcome-unknown", detail: execution.detail };
    case "exited": {
      if (execution.exitCode === 0) return { kind: "moved" };
      const nativeCode = nativeCodeOf(execution.stderr);
      if (nativeCode === null) return unknownHelperResult(execution);
      switch (execution.exitCode) {
        case 10:
          return { kind: "destination-exists", nativeCode };
        case 11:
          return { kind: "path-missing", nativeCode };
        case 12:
          return { kind: "cross-device", nativeCode };
        case 13:
          return { kind: "unsupported", nativeCode };
        case 14:
          return { kind: "failed", nativeCode };
        default:
          return unknownHelperResult(execution);
      }
    }
    default: {
      const _exhaustive: never = execution;
      return _exhaustive;
    }
  }
}

export function createExclusiveNamespaceMover(input: {
  readonly helperPath: string;
  readonly runHelper?: RunExclusiveMoveHelper;
}): ExclusiveNamespaceMover {
  const runHelper = input.runHelper ?? runExclusiveMoveHelper;
  return {
    async move(paths) {
      return outcomeOf(
        await runHelper({
          helperPath: input.helperPath,
          sourcePath: paths.sourcePath,
          destinationPath: paths.destinationPath,
        }),
      );
    },
  };
}
