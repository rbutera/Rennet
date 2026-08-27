---
title: Rennet in a browser
description: Open the daemon's browser client, switch daemons, and use browser-specific repository and editor actions.
---

The desktop window and browser client run the same Rennet interface. The daemon
serves the browser bundle and handles the commands issued by either shell.

## Open Rennet in a browser

The daemon serves HTTP and WebSocket traffic on the same port.

With the desktop app running, read the host and port from
`~/.rennet/daemon.json` or run:

```sh
rennet status
```

Then open `http://127.0.0.1:<port>/` on the daemon's machine.

To serve a browser build from the standalone CLI, run:

```sh
rennet serve --ui-dist /path/to/dist/browser
```

`rennet status` prints the bound host and port. The packaged desktop app finds
its browser bundle automatically. A standalone daemon without `--ui-dist`
continues to provide its command interface but does not serve the browser app.

## Switch between daemons

The connection control in the top-left corner shows the active daemon.

- **This machine** selects the desktop daemon in the desktop shell. In a browser,
  it selects the daemon that served the page.
- **Saved daemons** lists paired remote daemons. Use **Add a daemon** and enter
  the host plus a current pairing code.

The browser stores the exchanged device token in that browser. See
[Remote access](./remote-access.md) for binding and pairing instructions.

Switching daemons reloads the interface from the selected daemon's state.
Reviews and threads are not merged between daemons. Connecting the desktop app
to a remote daemon does not stop its local daemon.

If a connection drops, a banner reports the interruption and retries. A brief
reconnected message appears when an established connection returns. Protocol
mismatches and rejected device tokens are reported separately and provide a
**Retry** action.

## Browser-specific actions

A browser cannot open the operating system's directory picker. When Rennet needs
a repository path, enter an absolute path on the daemon's machine. Later commands
refer to the registered repository instead of asking for the path again.

**Open in editor** also runs on the daemon's machine. Against a remote daemon, it
opens the file in an editor there. If no supported editor is available, Rennet
reports that result in the browser.

Review capture, boards, conversations, staged asks, and outbound operations
otherwise use the same daemon commands as the desktop shell.
