# command-registry Delta

## MODIFIED Requirements

### Requirement: One registry feeds palette, dispatch, settings, and menu
The stable command definitions (id, title, group, default keybinding) SHALL live in a single catalogue that `buildCommands` assembles from, and the palette, the keyboard dispatch, and the settings Keyboard section SHALL all derive from that catalogue — there SHALL be no second command list and no duplicated chord table. Context-dependent entries (recent surfaces, lens jumps) MAY keep being generated per context; the palette-toggle chord itself SHALL be a registry command.

#### Scenario: Palette and settings render from one source
- **WHEN** the palette and the settings Keyboard section both display a registry command
- **THEN** both show the same title and the same effective chord, both derived from the one catalogue entry

#### Scenario: The palette toggle is itself a command
- **WHEN** the registry catalogue is enumerated
- **THEN** it contains the palette-toggle command with its default `mod+k` chord, remappable like any other

### Requirement: User keybinding overrides persist and take effect at dispatch
A user SHALL be able to set a different chord for any catalogued command, unbind a command's chord entirely, and reset a command back to its default. Overrides SHALL persist in the global config file as an additive-optional field, so an untouched install stores nothing, an old config parses unchanged, and an override survives restart. The effective binding (default overlaid by override) SHALL be what key dispatch matches, what the palette displays, and what conflict detection inspects: after a remap, the new chord runs the command, the replaced chord does not, and an unbound command fires from no chord. A malformed global config SHALL refuse the write rather than overwrite unparseable bytes, exactly as the shipped appearance write does.

#### Scenario: A remap survives restart
- **WHEN** the user remaps a command's chord and the app restarts
- **THEN** the persisted override is read back, the palette shows the new chord, and pressing it runs the command

#### Scenario: The old chord stops dispatching
- **WHEN** a command has been remapped away from its default chord
- **THEN** pressing the default chord does not run that command

#### Scenario: Reset returns to the default
- **WHEN** the user resets an overridden command
- **THEN** the override entry is removed from the stored map and the default chord is effective again

#### Scenario: A settings write updates the running app
- **WHEN** Set, Unbind, or Reset succeeds in Settings
- **THEN** dispatch and palette conflict disclosure re-derive from the returned map without a restart

#### Scenario: A command without a default receives its first binding
- **WHEN** the user assigns a chord to any catalogue command whose default is absent
- **THEN** the Keyboard row accepts it and the app-wide dispatcher runs that command from the new chord

#### Scenario: An invalid stored chord falls back honestly
- **WHEN** a stored override does not match the v1 chord grammar, such as `mod+`
- **THEN** the command uses its default, the invalid token is not projected to dispatch, and Settings displays the raw stored token as invalid

#### Scenario: Unsupported modifiers are not captured lossily
- **WHEN** the recorder receives Shift or Alt with another key
- **THEN** it writes nothing and shows a plain inline unsupported-combination note

#### Scenario: Modified chords use the platform-primary modifier
- **WHEN** a `mod+` chord is matched
- **THEN** Meta is required on macOS and Control is required on Windows/Linux, while the other modifier does not match

## REMOVED Requirements

### Requirement: The application menu is built from the registry
**Reason**: The registry-projected application menu duplicated the palette with a worse taxonomy (palette groups as top-level menus, catalogue order as menu order) and required a renderer→main IPC projection plus a display-only accelerator workaround solely to avoid double dispatch. The palette and the settings Keyboard section are the command surfaces.
**Migration**: No user migration. The desktop app installs a static platform-role menu on macOS and no application menu on Windows/Linux (see ADDED requirement). All previously menu-reachable commands remain in the palette with the same chords.

## ADDED Requirements

### Requirement: The application menu is static platform plumbing
The desktop app SHALL NOT project registry commands into an application menu. On macOS, MAIN SHALL install a static roles-only menu (the app menu, Edit-role text editing, and Window controls) exactly once at startup, with no renderer involvement, no IPC menu channel, and no accelerator that dispatches a registry command — the renderer SHALL remain the sole chord dispatcher. On Windows and Linux, MAIN SHALL set the application menu to null so no menu strip is shown.

#### Scenario: macOS gets a roles-only menu
- **WHEN** the app starts on macOS
- **THEN** the installed application menu consists of the app, Edit, and Window role menus, contains no registry command items, and is never replaced by a renderer update

#### Scenario: Windows and Linux get no menu
- **WHEN** the app starts on Windows or Linux
- **THEN** the application menu is null and the window shows no menu strip

#### Scenario: Native text editing still works on macOS
- **WHEN** the user presses the platform copy, cut, or paste chord in an editable control on macOS
- **THEN** the Edit-role menu items perform the edit natively
