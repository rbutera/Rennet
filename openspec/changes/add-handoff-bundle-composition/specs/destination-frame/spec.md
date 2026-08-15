## MODIFIED Requirements

### Requirement: The publish sheet previews exactly what will leave the machine and gates on hold-to-confirm
The publish sheet SHALL list the staged items as exactly the outbound artifact, with the previewed bytes equal to the staged payload bytes. Signing SHALL be gated by a hold-to-confirm affordance (`holdToSignMs`, accessibility floor 0) and SHALL never default to APPROVE. For v1 the signing act SHALL be all-or-nothing over the whole staged set; publishing a subset requires withdrawing first, then signing. This slice SHALL perform no Git or GitHub mutation.

In the own-branch handoff framing, when a composed handoff bundle exists for the current staged set, the preview SHALL render the composed work order — the grouped tasks in execution order with the reviewers' bodies verbatim — as the exact prompt contract the handoff run will execute, and the previewed prompt SHALL be the one the run executes (verified, refusing on mismatch rather than diverging from the preview). When only the mechanical pass-through exists, the preview SHALL show that pass-through and SHALL NOT present it as a model-composed narrative.

#### Scenario: Preview bytes equal the staged payload bytes
- **WHEN** the publish sheet previews a staged set and the staged payload is serialised
- **THEN** the two byte sequences are equal

#### Scenario: Hold-to-confirm gates the publish act
- **WHEN** the elapsed hold is below `holdToSignMs`
- **THEN** signing is not permitted; and **WHEN** the elapsed hold meets `holdToSignMs` (floor 0 permitting an immediate sign) the publish act is allowed

#### Scenario: The handoff preview is the executed prompt
- **WHEN** the own-branch handoff preview renders a composed bundle and the handoff run is then invoked with that bundle
- **THEN** the prompt the coding harness receives is the previewed composed prompt

#### Scenario: The mechanical floor previews honestly
- **WHEN** composition degraded to the mechanical pass-through
- **THEN** the handoff preview shows the pass-through list marked as not model-composed
