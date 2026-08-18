// The R19 public-contract fixtures (issue #380). The projected schemas in
// `index.ts` are turned into JSON Schema here, checked in under
// `packages/protocol/public-schema/`, and guarded by `public-schema.test.ts`,
// which fails on any drift. The fixtures ARE the deliverable a future mobile
// client builds against — files, not a running server.
//
// Regenerate after an intended contract change:
//   UPDATE_PUBLIC_SCHEMA=1 pnpm nx test rennet-protocol
// then review the diff.

import { z } from "zod";
import { type PublicProjectionName, publicProjectionSchemas } from "./index";

export const PUBLIC_SCHEMA_NAMES = Object.keys(
  publicProjectionSchemas,
) as readonly PublicProjectionName[];

/** The JSON Schema for one projected shape, with the unresolvable `$schema` meta-ref stripped (bodies.ts §). */
export function publicSchemaJson(name: PublicProjectionName): Record<string, unknown> {
  const projected = z.toJSONSchema(publicProjectionSchemas[name]) as Record<string, unknown>;
  delete projected.$schema;
  return projected;
}

/** The exact bytes the fixture file holds: pretty JSON + trailing newline (stable across runs). */
export function publicSchemaText(name: PublicProjectionName): string {
  return `${JSON.stringify(publicSchemaJson(name), null, 2)}\n`;
}
