import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINDING_VERIFICATION_CONTRACT, renderFindingVerificationPrompt } from "@rennet/prompts";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "./claude-query";
import { createVerificationTurn } from "./finding-verification-backend";

// ─────────────────────────────────────────────────────────────────────────────
// THE PROOF that a verification turn ACTUALLY RUNS the code (issue #259). #179's
// deterministic tests prove the WIRING carries an executed command to a verdict;
// this proves the BEHAVIOUR: given the execution-inviting contract and a real
// shell, a live verifier runs a command against the real code and the adapter
// observes it. It builds a tiny throwaway git repo with a genuine bug, points a
// real Claude verification turn at it, and asserts the turn's `execution` records
// a command that actually ran — the exact thing that was impossible under the old
// read-only posture ("reproduce" with nothing to run).
//
// It spends NO metered tokens but DOES spend subscription quota and needs a
// discoverable `claude`, so it is SKIPPED unless RENNET_VERIFY_EXEC=1:
//
//   RENNET_VERIFY_EXEC=1 \
//     pnpm exec vitest run packages/adapters/src/finding-verification-executes.real.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const RUN = process.env.RENNET_VERIFY_EXEC === "1";

/** A throwaway git repo whose `sum` throws on an empty array — a bug you can RUN to see. */
function makeBuggyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-verify-exec-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // `sum([])` reads `nums[0].valueOf()` on an undefined element → throws. The finding
  // below claims exactly this; a verifier with a shell can reproduce it in one command.
  writeFileSync(
    join(root, "src", "sum.js"),
    [
      "function sum(nums) {",
      "  let total = nums[0].valueOf();",
      "  for (let i = 1; i < nums.length; i++) total += nums[i];",
      "  return total;",
      "}",
      "module.exports = { sum };",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "buggy", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  const git = (args: string): void => {
    execSync(`git ${args}`, {
      cwd: root,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  };
  git("init -q");
  git("add -A");
  git("commit -q -m init");
  return root;
}

describe("verification turn executes the code (gated real turn, #259)", () => {
  it.skipIf(!RUN)(
    "runs a command against the real repo and records it as executed evidence",
    async () => {
      const { adapter, discovery } = await createClaudeHarness({ env: process.env });
      expect(
        adapter,
        `no claude binary discovered: ${JSON.stringify(discovery.health)}`,
      ).not.toBeNull();
      if (!adapter) return;

      const root = makeBuggyRepo();
      const prompt = renderFindingVerificationPrompt(FINDING_VERIFICATION_CONTRACT, {
        file: {
          path: "src/sum.js",
          startLine: 1,
          endLine: 6,
          text: [
            "function sum(nums) {",
            "  let total = nums[0].valueOf();",
            "  for (let i = 1; i < nums.length; i++) total += nums[i];",
            "  return total;",
            "}",
            "module.exports = { sum };",
          ].join("\n"),
        },
        findings: [
          {
            ref: "f1",
            severity: "high",
            summary:
              "sum([]) throws instead of returning 0 — nums[0] is undefined and .valueOf() dereferences it",
            hunk: "+  let total = nums[0].valueOf();",
          },
        ],
      });

      const runTurn = createVerificationTurn(adapter, { cwd: root });
      const result = await runTurn(prompt);

      // The proof: the turn EMITTED a verdict AND it got there by RUNNING something —
      // `execution` carries at least one COMPLETED command, and that command's output
      // SUPPORTS the verdict (#268 F2: not merely "some command existed"). The bug is a
      // TypeError on empty input, so the observed output must show that failure.
      expect(result.status).toBe("emitted");
      if (result.status === "emitted") {
        console.log("[#259 live] execution:", JSON.stringify(result.execution, null, 2));
        console.log("[#259 live] body:", JSON.stringify(result.body, null, 2));
        expect(result.execution).toBeDefined();
        const commands = result.execution?.commands ?? [];
        expect(commands.length).toBeGreaterThan(0);
        // The observed run reproduces the actual failure the finding is about.
        const provingRun = commands.some((c) =>
          /valueOf|TypeError|undefined|throw/i.test(c.outputTail),
        );
        expect(provingRun).toBe(true);
        // The model returned a reproduced verdict for the one finding.
        const body = result.body as { verifications?: { verdict?: string }[] };
        expect(body.verifications?.[0]?.verdict).toBe("reproduced");
      }
    },
    600_000,
  );
});
