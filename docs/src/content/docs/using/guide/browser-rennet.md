---
title: Rennet in a browser
description: Open Rennet as a browser tab the daemon serves, switch between local and remote daemons, and understand what the browser shell does differently.
---

Rennet is one app with two shells. You can run it as the desktop application, or
open it as a **browser tab that the daemon serves itself** — same surfaces, same
capabilities, no read-only mode and no feature that lives in only one shell. A tab
on the machine that runs the daemon is a full, trusted client, exactly like the
desktop window.

## Open the app in a browser

The daemon serves the browser client on the same port it speaks WebSocket on.

- **With the desktop app running.** The app already spawns a daemon. Find its port
  in `~/.rennet` (or run `rennet status`), then open `http://127.0.0.1:<port>/` in
  a browser. The tab loads the app and connects straight back to that daemon.
- **From the CLI.** Run the daemon in the foreground and point it at a built UI:

  ```sh
  rennet serve --ui-dist /path/to/dist/browser
  ```

  `rennet status` prints the host and port it bound. The packaged app resolves its
  own browser bundle automatically, so `--ui-dist` is only needed when you run the
  standalone `rennet` CLI against a UI build.

Without a UI bundle the daemon runs headless exactly as before — serving the
browser client is a capability, not a requirement.

## Switch between daemons

Both shells carry the same connection indicator in the top-left corner. Click it to
see which daemon this window is attached to and to switch:

- **This machine** is always there — your local daemon, the default.
- **Saved daemons** are remote daemons you have paired. Add one with **Add a
  daemon**: type its host (a Tailscale IP, optionally `host:port`) and the pairing
  code the remote daemon minted, and Rennet exchanges the code for a device token it
  stores in this browser. See [Remote access](/using/guide/remote-access/) for how
  to mint a code and how Tailscale carries the connection.

Switching daemons remounts the app against the chosen one — its reviews and threads
live on that daemon, so you are moving between worlds, not merging them. The desktop
app attaching to a remote daemon never disturbs its own local one.

## What the browser shell does differently

Two small things differ from the desktop window, both by design:

- **Choosing a repository is a path prompt.** A browser tab has no native directory
  picker, so the first time you point Rennet at a repository it asks you to type an
  absolute path **on the daemon's machine**. Every command still works everywhere;
  most flows never need a raw path again, because Rennet refers to repositories by
  reference after first contact.
- **Editor-open happens on the daemon's machine.** Open-in-editor — like every
  machine-bound action — resolves where the daemon runs, not where the tab is. Against
  a remote daemon it opens an editor on the remote machine (or reports honestly that
  none is available); it is not a bug that the file does not open on your laptop.

Everything else — capturing reviews, the canvases, conversations, dispositions,
and posting — is identical to the desktop app, because it is the same app.
