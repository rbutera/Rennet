# command-registry Specification

## Purpose
Defines one registry for keyboard-reachable actions, including palette display, key dispatch, user remapping, and conflict disclosure.
## Requirements
### Requirement: One registry feeds palette, dispatch, and settings
The stable command definitions, including id, title, group, and default keybinding, SHALL live in a single catalogue that `buildCommands` assembles. The palette, keyboard dispatch, and the Settings keyboard section SHALL derive from that catalogue. There SHALL be no second command list or duplicated chord table. Context-dependent entries such as recent views and lens jumps MAY be generated per context. The palette-toggle chord SHALL be a registry command.

#### Scenario: Palette and settings render from one source
- **WHEN** the palette and the Settings keyboard section both display a registry command
- **THEN** both show the same title and the same effective chord, both derived from the one catalogue entry

#### Scenario: The palette toggle is itself a command
- **WHEN** the registry catalogue is enumerated
- **THEN** it contains the palette-toggle command with its default `mod+k` chord, remappable like any other

### Requirement: User keybinding overrides persist and take effect at dispatch
A user SHALL be able to set a different chord for any catalogued command, unbind a command's chord, and reset a command to its default. Overrides SHALL persist in the global config file as an optional field. An untouched installation SHALL store nothing, a config without overrides SHALL parse, and an override SHALL survive restart. Key dispatch, palette display, and conflict detection SHALL use the effective binding after applying overrides. After a remap, the new chord SHALL run the command, the replaced chord SHALL not, and an unbound command SHALL fire from no chord. A malformed global config SHALL refuse the write rather than overwrite unparseable bytes.

#### Scenario: A remap survives restart
- **WHEN** the user remaps a command's chord and the app restarts
- **THEN** the persisted override is read back, the palette shows the new chord, and pressing it runs the command

#### Scenario: The replaced chord stops dispatching
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
- **WHEN** a stored override does not match the supported chord grammar, such as `mod+`
- **THEN** the command uses its default, the invalid token is not projected to dispatch, and Settings displays the raw stored token as invalid

#### Scenario: Unsupported modifiers are not captured lossily
- **WHEN** the recorder receives Shift or Alt with another key
- **THEN** it writes nothing and shows a plain inline unsupported-combination note

#### Scenario: Modified chords use the platform-primary modifier
- **WHEN** a `mod+` chord is matched
- **THEN** Meta is required on macOS and Control is required on Windows/Linux, while the other modifier does not match

### Requirement: Chord conflicts are detected and disclosed, never blocked
When two commands' effective bindings claim the same chord, the palette and Settings SHALL identify the collision on both commands. Writing a conflicting override SHALL remain allowed. Both commands SHALL remain visible and editable, with no confirmation, wizard, or rejected write.

#### Scenario: A conflict is detected and reported
- **WHEN** two commands available in the same context have the same effective chord
- **THEN** both are shown with the shared chord and a plain collision disclosure, in the palette and in the settings Keyboard section

#### Scenario: A conflicting write still lands
- **WHEN** the user assigns a chord already held by another command
- **THEN** the override is persisted, both commands display the collision, and the user resolves it (or not) by further plain edits

### Requirement: The application menu is static platform plumbing
The desktop app SHALL NOT project registry commands into an application menu. On macOS, MAIN SHALL install a static roles-only menu once at startup. It SHALL contain the app menu, Edit-role text editing, and Window controls. It SHALL have no renderer involvement, IPC menu channel, or accelerator that dispatches a registry command. The renderer SHALL remain the only chord dispatcher. On Windows and Linux, MAIN SHALL set the application menu to null.

#### Scenario: macOS gets a roles-only menu
- **WHEN** the app starts on macOS
- **THEN** the application menu contains app, Edit, and Window role menus, contains no registry commands, and receives no renderer updates

#### Scenario: Windows and Linux get no menu
- **WHEN** the app starts on Windows or Linux
- **THEN** the application menu is null and the window shows no menu strip

#### Scenario: Native text editing works on macOS
- **WHEN** the user presses the platform copy, cut, or paste chord in an editable control on macOS
- **THEN** the Edit-role menu items perform the edit natively

### Requirement: Registry chords have one dispatcher and aliases yield
The app-wide dispatcher SHALL match all effective registry chords, including bare bindings, while bare chords SHALL remain inert in editable controls. When CanvasWorkspace handles a registry chord it SHALL stop propagation so the app dispatcher does not run it again. Hardcoded canvas aliases SHALL run only when no effective registry binding claims the pressed chord, and an explicit unbind of the aliased zoom command SHALL disable its aliases too.

#### Scenario: A modified zoom chord fires once
- **WHEN** CanvasWorkspace handles an effective modified zoom binding
- **THEN** the zoom altitude advances exactly once

#### Scenario: An alias yields to an effective binding or unbind
- **WHEN** a bracket, arrow, or Escape alias contradicts an effective registry binding or explicit zoom unbind
- **THEN** the alias does not rotate or zoom the canvas
