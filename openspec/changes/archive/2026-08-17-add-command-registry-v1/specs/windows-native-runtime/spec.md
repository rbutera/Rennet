## MODIFIED Requirements

### Requirement: Shortcut labels are platform-aware
Displayed keybinding labels SHALL show `Ctrl`-based labels on Windows and `⌘`-based labels on macOS. A `mod+` chord SHALL require the platform-primary modifier: `ctrlKey` on Windows/Linux and `metaKey` on macOS.

#### Scenario: Command palette label on Windows
- **WHEN** the command palette is shown on Windows
- **THEN** its keybinding renders as `Ctrl+K`, and pressing Ctrl+K opens it

#### Scenario: Control is not Command on macOS
- **WHEN** the command palette binding is `mod+k` on macOS
- **THEN** Command+K opens it and Control+K does not match it
