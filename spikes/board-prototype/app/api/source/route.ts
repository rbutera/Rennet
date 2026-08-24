import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

// Serves a slice of a real repo file for click-to-reveal code refs. The spike
// runs from spikes/board-prototype, so cited repo-root-relative paths resolve
// two levels up. Prototype-only: clamped to the repo root, read-only.
const REPO_ROOT = resolve(process.cwd(), "../..")
const CONTEXT_LINES = 8

export async function GET(request: Request) {
  const url = new URL(request.url)
  const path = url.searchParams.get("path") ?? ""
  const line = Number(url.searchParams.get("line") ?? "1")
  // Explicit span (code-ref hydration) beats the ±context default.
  const spanStart = url.searchParams.get("start")
  const spanEnd = url.searchParams.get("end")

  const absolute = resolve(REPO_ROOT, path)
  if (!absolute.startsWith(REPO_ROOT + "/")) {
    return Response.json({ error: "outside repo" }, { status: 400 })
  }

  let text: string
  try {
    text = await readFile(absolute, "utf8")
  } catch {
    return Response.json({ error: "unreadable" }, { status: 404 })
  }

  const lines = text.split("\n")
  const startLine = spanStart ? Math.max(1, Number(spanStart)) : Math.max(1, line - CONTEXT_LINES)
  const endLine = spanEnd
    ? Math.min(lines.length, Number(spanEnd))
    : Math.min(lines.length, line + CONTEXT_LINES)
  return Response.json({
    path,
    startLine,
    code: lines.slice(startLine - 1, endLine).join("\n"),
  })
}
