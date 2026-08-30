// The package's single export: a re-export seam over the five contract folders
// (B3, #489) plus the parked legacy residue below.
export * from "./board";
export * from "./commands";
export * from "./delta";
// Parked residue (B3 reconciliation 7): these surfaces have no contract folder
// yet and migrate with the changes that rework them (B4–B11) — domain.ts
// (project/settings/handoff/locus families), wire.ts (the pre-registry command
// payload schemas, split out in B3 task 4.1), sha256.ts (portable hash util).
// public-schema.ts also parks at root; it was never an index export.
export * from "./domain";
export * from "./forge";
export * from "./manifests";
export * from "./session";
export * from "./sha256";
export * from "./wire";
