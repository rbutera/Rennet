## MODIFIED Requirements

### Requirement: Quit completely stops exactly what the app owns

The tray quit SHALL stop the owned daemon claimed by `daemon.json` in the app data directory, regardless of whether the app or CLI spawned it, and SHALL stop the owned T3 Code sidecar claimed beside it when one is running. It SHALL use the same graceful path as `rennet stop`: send SIGTERM, persist in-flight turns as interrupted, and clear the verified claims. It SHALL never signal an attached remote daemon or a sidecar it did not spawn, and SHALL never show a confirmation prompt. It SHALL exit the app after the bounded wait even if the daemon or the sidecar does not confirm death, and SHALL log the timeout.

#### Scenario: quit during a streaming turn

- **WHEN** the user picks the quit item while a review turn is streaming on the owned daemon
- **THEN** the turn is aborted and persists as interrupted, the daemon claim clears, and the app exits without a dialog

#### Scenario: quit with the sidecar running

- **WHEN** the user picks the quit item while an owned sidecar is running
- **THEN** the sidecar receives SIGTERM after the daemon, its claim clears, and the app exits without a dialog
