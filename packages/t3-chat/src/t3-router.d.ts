// The vendored web modules the mount imports are written against T3's own router
// registration (vendor/t3code/apps/web/src/router.ts), which types their `navigate`
// calls. Registering the same router type here checks them as T3 does; the mount's
// memory router is built from that same route tree.
import type { AppRouter } from "~/router";

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
