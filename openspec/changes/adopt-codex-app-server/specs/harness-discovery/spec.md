# harness-discovery — ChatGPT desktop as a Codex candidate

## ADDED Requirements

### Requirement: The ChatGPT desktop bundled codex binary is a discovery candidate

Codex discovery SHALL include the ChatGPT-desktop-bundled codex binary as a candidate on macOS (`/Applications/ChatGPT.app/Contents/Resources/codex`, and the same relative layout under a user-local ChatGPT.app), probed with the same version/executability evidence as every other candidate, and SHALL prefer a user-installed codex CLI over the bundled binary when both are present and healthy. On Windows the Store package's bundled `codex.exe` is ACL-locked against out-of-package execution, so it SHALL NOT be offered as a candidate; Windows discovery continues through the installed codex CLI, and the health detail for an absent Windows codex SHALL name the CLI install as the remedy rather than pointing at the un-spawnable Store binary.

#### Scenario: ChatGPT desktop only, macOS

- **WHEN** discovery runs on macOS with no codex CLI on the PATH but ChatGPT.app installed with its bundled codex
- **THEN** the bundled binary is discovered, its version probed, and the Codex harness is available through it

#### Scenario: CLI outranks the bundle

- **WHEN** both a healthy codex CLI and the ChatGPT bundled binary are present on macOS
- **THEN** the CLI is chosen and the bundled binary remains listed as a candidate with its evidence

#### Scenario: Windows Store bundle is not offered

- **WHEN** discovery runs on Windows where ChatGPT desktop (the `OpenAI.Codex` Store package) is installed but no codex CLI is on the PATH
- **THEN** codex is unavailable with a detail naming the codex CLI install as the remedy, and the ACL-locked Store binary is not listed as a spawnable candidate

### Requirement: Codex candidates carry app-server capability evidence

A chosen codex candidate SHALL be probed for app-server capability (the `app-server` subcommand answering an `initialize` request), and the recorded health SHALL reflect the probe: a binary whose `app-server` cannot complete the handshake is `unavailable` with the probe detail — never silently driven through a different invocation mode.

#### Scenario: An old binary without app-server

- **WHEN** the only discovered codex binary cannot answer the app-server handshake
- **THEN** codex health is `unavailable` with a detail naming the app-server probe failure and the version found
