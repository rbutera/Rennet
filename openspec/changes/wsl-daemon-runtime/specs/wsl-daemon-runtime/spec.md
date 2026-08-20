## ADDED Requirements

### Requirement: The daemon bundle is delivered into the distro once per version

For a WSL-locus project, the shell SHALL ensure the daemon bundle exists in the distro's native filesystem at a versioned path (`~/.rennet/server/<version>/rennet.cjs`) before spawning, copying it there when absent and skipping the copy when the versioned copy already exists. The daemon SHALL be run from that distro-native path, never from the `\\wsl.localhost\…` view.

#### Scenario: First launch for a version delivers the bundle

- **WHEN** a WSL-locus project is opened and no `~/.rennet/server/<version>/rennet.cjs` exists in the distro
- **THEN** the shell copies the bundle to that path and spawns the daemon from it

#### Scenario: A subsequent launch reuses the delivered bundle

- **WHEN** the versioned bundle already exists in the distro
- **THEN** the shell does not re-copy it and spawns the daemon from the existing path

### Requirement: A WSL daemon is spawned via wsl.exe using the distro's Node

The shell SHALL resolve the distro's Node binary and spawn the daemon with the byte-verbatim `wsl.exe … -e <node> <bundle> serve --data-dir <distro-data-dir>` descriptor, detached, with the daemon owning its own log in a distro-native data dir. When the distro has no usable Node, the shell SHALL surface that plainly (not a silent failure) so the user can install Node or Rennet can ship one.

#### Scenario: Spawn a healthy WSL daemon

- **WHEN** the distro has Node and the bundle is delivered
- **THEN** the daemon starts, binds a loopback port, publishes its `daemon.json`, and answers `/healthz`

#### Scenario: No Node in the distro

- **WHEN** node resolution finds no usable Node
- **THEN** the shell reports the missing-Node condition for that distro and does not hang

### Requirement: WSL daemon health is checked on the port, not across 9P

The shell SHALL determine a WSL daemon's health by reaching its `/healthz` over `localhost` on the published port, not by reading its claim file across the 9P view. A version-skew healthy daemon (its version differs from the shell's) SHALL be restarted; a daemon SHALL be stopped by signalling its pid inside the distro.

#### Scenario: Health via the port

- **WHEN** the shell checks a WSL daemon
- **THEN** it probes `http://localhost:<port>/healthz` and treats an identity-matching 200 as healthy

#### Scenario: Version skew restarts the WSL daemon

- **WHEN** a healthy WSL daemon reports a version different from the shell's
- **THEN** the shell stops it (by pid, inside the distro) and spawns the current bundle

### Requirement: Projects route to the daemon for their execution locus

The shell SHALL run the host daemon plus one daemon per WSL distro in use, and route each project's commands to the daemon for that project's execution locus. Host-locus behavior SHALL be unchanged. Paths crossing the boundary SHALL be translated with the existing `toDistroPath` / `toWindowsView` helpers.

#### Scenario: A WSL project uses its distro's daemon

- **WHEN** a project whose locus is `wsl` (distro D) issues a command
- **THEN** the command is served by distro D's daemon over its loopback port, and repo paths are distro-native

#### Scenario: A host project is unaffected

- **WHEN** a host-locus project issues a command
- **THEN** it is served by the host daemon exactly as before this change

### Requirement: A WSL daemon's credential store is distro-native

A WSL daemon's GitHub credential SHALL live in its own distro-native data dir, so GitHub egress and the stored token both sit inside the distro. The host daemon's credential store SHALL be unaffected.

#### Scenario: WSL token is stored in the distro

- **WHEN** a WSL daemon stores or refreshes a GitHub credential
- **THEN** the credential file is written under the distro-native data dir, not the host data dir or a 9P path
