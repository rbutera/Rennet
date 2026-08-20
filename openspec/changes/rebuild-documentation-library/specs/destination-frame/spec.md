## REMOVED Requirements

### Requirement: The publish sheet previews exactly what will leave the machine and gates on hold-to-confirm

**Reason**: The timed hold and signing model are consent gates. Rennet now uses draft, preview, and post language.

**Migration**: Use the direct preview and post requirement below.

## ADDED Requirements

### Requirement: The preview posts exactly what it shows

The preview SHALL list the staged items as the exact outbound artifact. Posting SHALL be one action over the whole staged set, with no timed hold or separate confirmation. To post a subset, the user withdraws the other items before opening the preview.

#### Scenario: Preview bytes equal outbound bytes

- **WHEN** the preview renders a staged set and the outbound payload is serialized
- **THEN** the two byte sequences are equal

#### Scenario: One action posts the staged set

- **WHEN** the user activates post on a GitHub-backed preview
- **THEN** Rennet sends the whole previewed set without another confirmation or acknowledgement
