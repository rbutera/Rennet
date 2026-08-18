# client-runtime Specification (delta)

## MODIFIED Requirements

### Requirement: Presence is reported through a runtime seam

The runtime SHALL accept focus/visibility/device-class presence signals from its shell and SHALL transmit them to a connected daemon that advertises attention/presence support in its handshake capabilities. Against a daemon that does not advertise the capability, the seam SHALL remain a well-defined no-op that alters no protocol traffic — M0-era daemons are unaffected.

#### Scenario: presence transmits when advertised

- **WHEN** the shell reports presence and the connected daemon advertised the attention capability
- **THEN** the runtime sends the presence frame and re-sends current presence after every reconnect

#### Scenario: presence stays silent otherwise

- **WHEN** the connected daemon did not advertise the capability
- **THEN** the runtime records presence locally and sends nothing
