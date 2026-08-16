## Purpose

Every keyboard-reachable action is one named command in one registry, and everything that shows or fires an action — the palette, key dispatch, the settings remap surface, the application menu — reads that registry, so a remap or a collision is visible and effective everywhere at once.

## ADDED Requirements

### Requirement: One registry feeds palette, dispatch, settings, and menu
The stable command definitions (id, title, group, default keybinding) SHALL live in a single catalogue that `buildCommands` assembles from, and the palette, the keyboard dispatch, the settings Keyboard section, and the application menu SHALL all derive from that catalogue — there SHALL be no second command list, no duplicated chord table, and no menu item whose label or chord is authored separately from the registry. Context-dependent entries (recent surfaces, lens jumps) MAY keep being generated per context; the palette-toggle chord itself SHALL be a registry command.

#### Scenario: Palette and menu render from one source
- **WHEN** the palette and the application menu both display a registry command
- **THEN** both show the same title and the same effective chord, both derived from the one catalogue entry

#### Scenario: The palette toggle is itself a command
- **WHEN** the registry catalogue is enumerated
- **THEN** it contains the palette-toggle command with its default `mod+k` chord, remappable like any other

### Requirement: User keybinding overrides persist and take effect at dispatch
A user SHALL be able to set a different chord for any catalogued command, unbind a command's chord entirely, and reset a command back to its default. Overrides SHALL persist in the global config file as an additive-optional field, so an untouched install stores nothing, an old config parses unchanged, and an override survives restart. The effective binding (default overlaid by override) SHALL be what key dispatch matches, what the palette and menu display, and what conflict detection inspects: after a remap, the new chord runs the command, the replaced chord does not, and an unbound command fires from no chord. A malformed global config SHALL refuse the write rather than overwrite unparseable bytes, exactly as the shipped appearance write does.

#### Scenario: A remap survives restart
- **WHEN** the user remaps a command's chord and the app restarts
- **THEN** the persisted override is read back, the palette and menu show the new chord, and pressing it runs the command

#### Scenario: The old chord stops dispatching
- **WHEN** a command has been remapped away from its default chord
- **THEN** pressing the default chord does not run that command

#### Scenario: Reset returns to the default
- **WHEN** the user resets an overridden command
- **THEN** the override entry is removed from the stored map and the default chord is effective again

### Requirement: Chord conflicts are detected and disclosed, never blocked
When two commands' effective bindings claim the same chord, the collision SHALL be detected and disclosed wherever the chord is shown — both palette rows and both settings rows name it — and the disclosure SHALL be the whole intervention: writing a conflicting override SHALL be accepted and persisted, both commands SHALL remain visible and individually editable, and there SHALL be no confirmation step, blocking wizard, or refused write on account of a conflict.

#### Scenario: A conflict is detected and reported
- **WHEN** two commands available in the same context have the same effective chord
- **THEN** both are shown with the shared chord and a plain collision disclosure, in the palette and in the settings Keyboard section

#### Scenario: A conflicting write still lands
- **WHEN** the user assigns a chord already held by another command
- **THEN** the override is persisted, both commands display the collision, and the user resolves it (or not) by further plain edits

### Requirement: The application menu is built from the registry
The desktop app SHALL set a real application menu whose command items are projected from the registry: label from the command title, accelerator from the same effective `mod+`-token binding (rendered per-platform), and enabled state from whether the command is currently offered by the live context — a command absent from the current context appears disabled, not missing. Activating a menu item SHALL run the same command handler the palette runs, exactly once per activation, and the menu SHALL update when the live context or an override changes. Standard platform items (the macOS app menu, Edit-role text editing, window controls) MAY be Electron roles rather than registry commands.

#### Scenario: A menu click runs the registry handler
- **WHEN** the user activates a registry-derived menu item
- **THEN** the same `run` handler the palette would invoke executes exactly once

#### Scenario: Context disables rather than hides
- **WHEN** a registry command is not offered by the current screen
- **THEN** its menu item renders disabled instead of disappearing

#### Scenario: A remap reaches the menu
- **WHEN** the user overrides a command's chord
- **THEN** the menu item's displayed accelerator updates to the new chord without an app restart
