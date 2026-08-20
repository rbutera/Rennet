import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import {
  type DocsProjectionPaths,
  syncDocsProjection,
  watchDocsProjection,
} from "./docs-projection";

const projectionPaths: DocsProjectionPaths = {
  canonicalRoot: fileURLToPath(new URL("../../../../docs/", import.meta.url)),
  projectionRoot: fileURLToPath(new URL("../content/docs/", import.meta.url)),
};

export default function docsProjection(): AstroIntegration {
  return {
    name: "rennet-docs-projection",
    hooks: {
      "astro:config:setup": async () => {
        await syncDocsProjection(projectionPaths);
      },
      "astro:server:setup": ({ server, logger, refreshContent }) => {
        watchDocsProjection({
          ...projectionPaths,
          watcher: server.watcher,
          onProjected: async () => {
            await refreshContent?.({ loaders: ["starlight-docs-loader"] });
            server.ws.send({ type: "full-reload" });
          },
          onError: (error, canonicalPath) => {
            logger.error(
              `Failed to project ${canonicalPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        });
      },
    },
  };
}
