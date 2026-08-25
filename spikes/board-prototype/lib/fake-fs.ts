/**
 * In-memory stand-in for the daemon's `fs.listDir` RPC, so the ported
 * DirectoryBrowser browses something believable per source kind.
 */

export interface FsEntry {
  path: string
  name: string
  isRepo?: boolean
  unreadable?: boolean
}

export interface ListDirResult {
  path: string
  parent: string | null
  entries: FsEntry[]
}

interface DirNode {
  repo?: boolean
  unreadable?: boolean
  children?: Record<string, DirNode>
}

const LOCAL_HOME = "/Users/rai"
const REMOTE_HOME = "/home/rai"

const LOCAL_TREE: Record<string, DirNode> = {
  Users: {
    children: {
      rai: {
        children: {
          dev: {
            children: {
              rennet: { repo: true, children: { packages: {}, apps: {}, docs: {} } },
              orbital: { repo: true, children: { packages: {}, docs: {} } },
              meridian: { repo: true, children: { apps: {}, infra: {} } },
              "helio-cms": { repo: true, children: { src: {} } },
              dotfiles: { repo: true, children: {} },
              "t3-lander": { repo: true, children: { public: {} } },
              clients: {
                children: {
                  "acme-storefront": { repo: true, children: { src: {} } },
                  "acme-admin": { repo: true, children: { src: {} } },
                },
              },
              scratch: { children: {} },
            },
          },
          work: {
            children: {
              atlas: { repo: true, children: { services: {}, tools: {} } },
              "atlas-docs": { repo: true, children: {} },
              navcore: { repo: true, children: { src: {} } },
              archive: { children: {} },
            },
          },
          Documents: { children: {} },
          Downloads: { children: {} },
          Library: { unreadable: true },
        },
      },
    },
  },
}

const REMOTE_TREE: Record<string, DirNode> = {
  home: {
    children: {
      rai: {
        children: {
          srv: {
            children: {
              "ledger-api": { repo: true, children: { migrations: {} } },
              "edge-workers": { repo: true, children: {} },
            },
          },
          data: { unreadable: true },
          logs: { children: {} },
        },
      },
    },
  },
}

function resolve(tree: Record<string, DirNode>, path: string): DirNode | null {
  let children: Record<string, DirNode> | undefined = tree
  let node: DirNode = { children: tree }
  for (const part of path.split("/").filter(Boolean)) {
    if (!children || !(part in children)) return null
    node = children[part]
    children = node.children
  }
  return node
}

export function makeListDir(kind: "local" | "remote") {
  const tree = kind === "local" ? LOCAL_TREE : REMOTE_TREE
  const home = kind === "local" ? LOCAL_HOME : REMOTE_HOME

  return async function listDir(target?: string): Promise<ListDirResult> {
    // A beat of latency so loading order is observable, like a real RPC.
    await new Promise((r) => setTimeout(r, 150))
    const path = target?.trim() ? target.trim().replace(/\/+$/, "") || "/" : home
    const node = resolve(tree, path)
    if (!node || node.unreadable) throw new Error("No such directory")
    const parent = path === "/" ? null : path.split("/").slice(0, -1).join("/") || "/"
    const entries: FsEntry[] = Object.entries(node.children ?? {})
      .map(([name, child]) => ({
        path: path === "/" ? `/${name}` : `${path}/${name}`,
        name,
        isRepo: child.repo,
        unreadable: child.unreadable,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { path, parent, entries }
  }
}
