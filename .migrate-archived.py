p = "packages/app-ui/src/project/archived-view.dom.test.tsx"
s = open(p).read()
s = s.replace(
    'import type { Project } from "@rennet/protocol";\nimport { useState } from "react";',
    'import type { Project } from "@rennet/protocol";',
)
s = s.replace(
    'import {\n  type SidebarSession,\n  type SidebarSessionProjection,\n  SidebarSessionProjectionProvider,\n} from "../shell/sidebar-data";\nimport { cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";\nimport { MemoryBridge } from "../test/memory-bridge";',
    'import { cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";\nimport { type SessionSeed, sessionHandlers } from "../test/fixtures/sessions";\nimport { MemoryBridge } from "../test/memory-bridge";',
)

NEW = '''/** The compact age tokens these fixtures use, as an age in ms (the row's `time` line is
 *  derived from `createdAt` by the sidebar seam, so the seed carries the timestamp). */
const AGE_MS: Record<string, number> = {
  now: 0,
  "2d": 2 * 86_400_000,
  "3w": 21 * 86_400_000,
};

function session(over: Partial<SessionSeed> & { time?: string } = {}): SessionSeed {
  const { time, ...rest } = over;
  return {
    id: "s1",
    projectId: "p1",
    title: "Review the auth refactor",
    target: "your-branch",
    archived: true,
    createdAt: Date.now() - (AGE_MS[time ?? "2d"] ?? 0),
    ...rest,
  };
}

/**
 * Mounts ArchivedView over the stateful `session.*` fixture, so Unarchive genuinely
 * writes and the re-read returns the restored row — the same served path the live client
 * takes. Two projects (rennet / webapp) so project-name search + project sort have
 * something to discriminate; `projects.list` supplies the tree.
 */
function renderArchived(byProject: Record<string, SessionSeed[]>) {
  const history = memoryHistory("/archived");
  const seeds = Object.entries(byProject).flatMap(([projectId, rows]) =>
    rows.map((row) => ({ ...row, projectId })),
  );
  const bridge = new MemoryBridge({
    "projects.list": () => ({
      projects: [
        project("p1", "rennet", REPO_ONE),
        project("p2", "webapp", REPO_TWO),
      ],
    }),
    ...sessionHandlers(seeds),
  });
  return {
    ...mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <ArchivedView />
        </Router>
      </BridgeProvider>,
    ),
    history,
  };
}

'''

start = s.index("function session(over")
end = s.index("/** The archived row titles in DOM order")
s = s[:start] + NEW + s[end:]
s = s.replace('session({ slug: "auth-refactor" })', 'session({ id: "auth-refactor" })')
open(p, "w").write(s)
print("ok")
