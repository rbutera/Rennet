// Metro config for the pnpm monorepo (Expo docs "monorepo" shape): watch the
// workspace root so Metro sees `@rennet/*` source, and resolve modules from both
// the app's and the root's node_modules (pnpm's hoisted layout). No forked tooling.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
