export interface ChangeRequestCopy {
  readonly noun: "pull request" | "merge request";
  readonly opening: "Opening pull request…" | "Opening merge request…";
  readonly opened: "Pull request opened" | "Merge request opened";
  readonly sigil: "#" | "!";
}

const pullRequestCopy: ChangeRequestCopy = {
  noun: "pull request",
  opening: "Opening pull request…",
  opened: "Pull request opened",
  sigil: "#",
};

const mergeRequestCopy: ChangeRequestCopy = {
  noun: "merge request",
  opening: "Opening merge request…",
  opened: "Merge request opened",
  sigil: "!",
};

export function changeRequestCopy(forge: string | undefined): ChangeRequestCopy {
  return forge === "gitlab" ? mergeRequestCopy : pullRequestCopy;
}
