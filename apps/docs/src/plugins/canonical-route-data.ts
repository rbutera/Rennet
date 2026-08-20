import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { canonicalPathForProjected } from "./docs-projection";

const editBaseUrl = "https://github.com/rbutera/rennet/edit/main/";

export const onRequest = defineRouteMiddleware((context, next) => {
  const route = context.locals.starlightRoute;
  const canonicalPath = canonicalPathForProjected(route.entry.filePath);
  if (!canonicalPath) return next();

  route.entry.filePath = canonicalPath;
  if (route.entry.data.editUrl !== false && typeof route.entry.data.editUrl !== "string") {
    route.editUrl = new URL(canonicalPath, editBaseUrl);
  }
  return next();
});
