# tray-presence Specification

## Purpose
Defines the desktop tray, windowless operation, owned-daemon shutdown, and update-ready state.
## Requirements
### Requirement: Closing the window keeps Rennet resident

Closing the last window SHALL NOT quit the app. The shell SHALL stay tray-resident with the daemon and every stream running. On macOS it SHALL hide the Dock icon while no window exists and restore it when a window opens.

#### Scenario: close then reopen mid-stream

- **WHEN** the user closes the window during a streaming review turn and later chooses Open Rennet from the tray
- **THEN** the window returns (Dock icon back on macOS), the turn is still live, and the stream paints current state

### Requirement: The tray menu reflects current state

The tray menu SHALL contain exactly: Open Rennet; a "Restart Rennet to update" item only when an update is staged; a version line; and one Quit item. The Quit label SHALL read "Quit Rennet and stop daemon" when an owned local daemon is running and "Quit Rennet" otherwise.

#### Scenario: the quit label matches reality

- **WHEN** the desktop app is attached only to a remote daemon (no owned local daemon running)
- **THEN** the quit item reads "Quit Rennet" and quitting leaves the remote daemon untouched

### Requirement: Quit completely stops exactly what the app owns

The tray quit SHALL stop the owned daemon claimed by `daemon.json` in the app data directory, regardless of whether the app or CLI spawned it. It SHALL use the same graceful path as `rennet stop`: send SIGTERM, persist in-flight turns as interrupted, and clear the verified claim. It SHALL never signal an attached remote daemon or show a confirmation prompt. It SHALL exit the app after the bounded wait even if the daemon does not confirm death, and SHALL log the timeout.

#### Scenario: quit during a streaming turn

- **WHEN** the user picks the quit item while a review turn is streaming on the owned daemon
- **THEN** the turn is aborted and persists as interrupted, the daemon claim clears, and the app exits without a dialog

### Requirement: The tray surfaces the staged update

The tray icon SHALL show its update-ready variant only while an update is staged. The tray and in-app badge SHALL read the same main-process readiness state, and the update item SHALL use the same restart path. When no update is staged, the icon SHALL use the plain mark and the menu SHALL omit the update item.

#### Scenario: one readiness, two surfaces

- **WHEN** the updater stages a new version while the window is closed
- **THEN** the tray icon switches to its update-ready variant, and choosing "Restart Rennet to update" runs the same apply action as the in-app badge
