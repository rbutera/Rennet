# tray-presence Specification

## Purpose

The desktop shell's ambient presence: a tray icon (macOS menu bar, Windows tray) that keeps Rennet reachable while window-less, offers the only complete-exit path, and surfaces a staged update — truthfully, with no ceremony.

## ADDED Requirements

### Requirement: Closing the window keeps Rennet resident

Closing the last window SHALL NOT quit the app: the shell stays tray-resident with the daemon and every stream untouched, on macOS hiding the Dock icon while window-less and restoring it when a window reopens. Window close SHALL stop nothing — the daemon-outlives-the-app invariant is unchanged.

#### Scenario: close then reopen mid-stream

- **WHEN** the user closes the window during a streaming review turn and later chooses Open Rennet from the tray
- **THEN** the window returns (Dock icon back on macOS), the turn is still live, and the stream paints current state

### Requirement: The tray menu is minimal and truthful

The tray menu SHALL contain exactly: Open Rennet; a "Restart Rennet to update" line present only when an update is staged; a version line; and one Quit item whose label states what it will do — "Quit Rennet and stop daemon" when an owned local daemon is running, "Quit Rennet" otherwise. No other entries.

#### Scenario: the quit label matches reality

- **WHEN** the desktop app is attached only to a remote daemon (no owned local daemon running)
- **THEN** the quit item reads "Quit Rennet" and quitting leaves the remote daemon untouched

### Requirement: Quit completely stops exactly what the app owns

The tray quit SHALL stop the owned daemon — the one claimed by `daemon.json` in the app's data directory, regardless of who spawned it — via the same graceful path as `rennet stop` (SIGTERM → the daemon's shutdown settles in-flight turns as persisted, resumable interrupted state), then exit the app. It SHALL never signal an attached remote daemon, SHALL show no confirmation prompt, and SHALL exit the app even if the daemon does not confirm death within the bounded wait (reported truthfully in the log, matching `rennet stop`'s warning behavior).

#### Scenario: quit during a streaming turn

- **WHEN** the user picks the quit item while a review turn is streaming on the owned daemon
- **THEN** the turn is aborted and persists as interrupted (resumable on next start), the daemon's claim file clears, and the app exits — with no dialog at any point

### Requirement: The tray surfaces the staged update

The tray icon SHALL show its update-ready variant only while an update is staged, driven by the same main-process readiness state as the in-app badge; the menu's update line SHALL apply the update through the existing restart path. When no update is staged the icon is the plain mark and no update line exists.

#### Scenario: one readiness, two surfaces

- **WHEN** the updater stages a new version while the window is closed
- **THEN** the tray icon switches to its update-ready variant, and choosing "Restart Rennet to update" restarts into the new version — the same action the in-app badge offers
