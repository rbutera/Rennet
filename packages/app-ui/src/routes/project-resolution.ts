interface ProjectIdentity {
  readonly id: string;
  readonly name: string;
}

/** Resolve a project route token without allowing an ambiguous display name to win. */
export function resolveProject<T extends ProjectIdentity>(
  projects: readonly T[],
  requested: string | null | undefined,
  fallbackId?: string | null,
): T | undefined {
  if (requested) {
    const exactId = projects.find((project) => project.id === requested);
    if (exactId) return exactId;

    const exactName = projects.filter((project) => project.name === requested);
    if (exactName.length === 1) return exactName[0];
  }

  return projects.find((project) => project.id === fallbackId) ?? projects[0];
}
