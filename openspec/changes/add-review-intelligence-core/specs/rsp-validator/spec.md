## ADDED Requirements

### Requirement: The `review.hypothesis` document type is validated atomically
The validator SHALL recognise a new `review.hypothesis` document type, admitted atomically (any body error rejects the whole document), and SHALL validate its body: a non-empty domain, a scope with in and out lists, a design expectation, and a risks array bounded to between five and ten items, where each risk carries a non-empty statement, a severity in the closed high|medium|low vocabulary, and a non-empty disconfirmer. The envelope, anchor, quote, vocabulary, and identity guarantees SHALL be unchanged, and the document's `docId` and `inputDigest` SHALL be stamped by the pass, not the agent.

#### Scenario: A well-formed hypothesis is admitted
- **WHEN** a `review.hypothesis` document with a domain, an in/out scope, a design expectation, and seven valid risks is validated
- **THEN** it is admitted with no errors

#### Scenario: A risk count outside the bound rejects the document
- **WHEN** a `review.hypothesis` body carries fewer than five or more than ten risks
- **THEN** the document is rejected atomically with an error naming the bound

#### Scenario: A risk with an out-of-vocabulary severity rejects the document
- **WHEN** a risk declares a severity outside high|medium|low
- **THEN** the document is rejected atomically

### Requirement: The `finding` body admits an additive optional verification field
The validator SHALL accept an optional verification field on a `finding` element — a verdict of reproduced, refuted, or inconclusive with an evidence string — while keeping the finding body's existing itemwise admission, anchor grounding, severity vocabulary, and identity rules unchanged. A finding without the field SHALL remain admissible exactly as before.

#### Scenario: A finding with a verification field is admitted
- **WHEN** a `finding` element carries a verification verdict and evidence
- **THEN** the item is admitted and the field is preserved

#### Scenario: A finding without a verification field is unchanged
- **WHEN** a `finding` element omits the verification field
- **THEN** it is admitted exactly as it is today

#### Scenario: A malformed verification verdict is rejected without sinking grounded findings
- **WHEN** a `finding` element carries a verification verdict outside the closed set
- **THEN** that item is dropped by the itemwise gate with a visible rejected count, and the grounded findings in the same document are still admitted
