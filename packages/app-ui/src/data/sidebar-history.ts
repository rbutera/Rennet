import { type CommandOutput, parseCommandOutput } from "@rennet/protocol";
import { useEffect, useState } from "react";

interface HistorySnapshot {
  readonly projects: CommandOutput<"projects.list">;
  readonly sessions: CommandOutput<"session.list">;
}

function readSnapshot(key: string | undefined): HistorySnapshot | undefined {
  if (!key) return undefined;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || !("projects" in value) || !("sessions" in value))
      return undefined;
    return {
      projects: parseCommandOutput("projects.list", value.projects),
      sessions: parseCommandOutput("session.list", value.sessions),
    };
  } catch {
    return undefined;
  }
}

export function useSidebarHistory(
  targetId: string | undefined,
  projects: CommandOutput<"projects.list"> | undefined,
  sessions: CommandOutput<"session.list"> | undefined,
) {
  const key = targetId ? `rennet.history.${targetId}` : undefined;
  const [saved] = useState(() => readSnapshot(key));
  useEffect(() => {
    if (!key || !projects || !sessions) return;
    try {
      localStorage.setItem(key, JSON.stringify({ projects, sessions } satisfies HistorySnapshot));
    } catch {
      // Storage can be unavailable; live history still works.
    }
  }, [key, projects, sessions]);
  return {
    projects: projects ?? saved?.projects,
    sessions: sessions ?? saved?.sessions,
    cached: Boolean(saved && (!projects || !sessions)),
  };
}
