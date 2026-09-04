// The package's single export: a re-export seam over the five contract folders
// (B3, #489), the declared root contract modules that own one boundary each and have
// no folder to sit in (`app-owned-paths`, `round-evidence`, `forge`), and the parked
// legacy residue described below. A root module is not automatically residue.
export * from "./app-owned-paths";
export * from "./benchmarks";
export * from "./board";
export * from "./commands";
export * from "./delta";
export * from "./design/bmad-model";
// Parked residue (B3 reconciliation 7): these surfaces have no contract folder
// yet and migrate with the changes that rework them (B4–B11) — domain.ts
// (project/settings/handoff/locus families), wire.ts (the pre-registry command
// payload schemas, split out in B3 task 4.1), sha256.ts (portable hash util).
// public-schema.ts also parks at root; it was never an index export.
export * from "./domain";
export * from "./forge";
export * from "./manifests";
export * from "./round-evidence";
export * from "./session";
export * from "./sha256";
export * from "./wire";
