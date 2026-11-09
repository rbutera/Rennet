# Spec Delta

## MODIFIED Requirements

### Requirement: The welcome reports real environment tools

The tools stage SHALL render the local source's detected coding harnesses and source-control tools, including `git` and `git-lfs`, from the same probes used by Settings. It SHALL distinguish available, unauthenticated, absent, and unaskable states without inventing a version, account, or installed tool. A missing source-control tool SHALL offer Install for me. The stage SHALL explain that each added source is detected separately.

#### Scenario: Detected tools appear with their proven versions
- **WHEN** the local host probes return installed tools
- **THEN** the tools stage names those tools and shows only the versions and authentication states the probes returned

#### Scenario: Missing tool stays honest
- **WHEN** a known tool is absent or its probe did not complete
- **THEN** the stage does not present that tool as available or fabricate a version

#### Scenario: Missing git-lfs offers install
- **WHEN** the local probe reports `git-lfs` absent
- **THEN** the tools stage shows Git LFS as not installed with an Install for me action
