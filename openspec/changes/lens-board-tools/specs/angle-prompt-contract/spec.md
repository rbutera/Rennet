## MODIFIED Requirements

### Requirement: An instruction never restates the JSON schema it must emit against
A base instruction SHALL name what it produces and how, but SHALL NOT embed the shape of it. When the produced thing travels as a structured return, the instruction names the document type and version and never the JSON schema, because the schema travels separately as the structured-output constraint. When the produced thing is WRITTEN THROUGH TOOLS, the instruction names the tools by the job each does and never restates their input schemas, because those travel separately as the turn's tool list. Two sources of truth for one shape drift, whichever form the shape takes.

#### Scenario: The emit slot names the type without the schema
- **WHEN** the `decomposition.skeleton` base instruction is rendered
- **THEN** it names the docType `decomposition.skeleton` and its version and does not contain a JSON Schema object

#### Scenario: The emit slot of a tool-writing seat names the verbs without their schemas
- **WHEN** a lens seat's base instruction is rendered
- **THEN** it names the tools that seat writes its board with and contains no field list, no type declaration and no JSON Schema object for any of them
