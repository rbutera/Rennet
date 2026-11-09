# Spec Delta

## Purpose

Governs how Rennet's review checkouts treat Git LFS content: the user's per-project choice to download or skip large files, the prompt that asks for it, and a skip mode that works whether or not Git LFS is installed.

## ADDED Requirements

### Requirement: A project that uses Git LFS asks once how to treat large files

When a review checkout is first needed for a project whose repository uses Git LFS and no choice is recorded, Rennet SHALL ask with a modal before checking out: **Download large files** (full fidelity, slower) or **Skip large files** (faster, placeholder pointer files). The modal SHALL say what each means in plain words and SHALL be a product choice, not a warning.

#### Scenario: First review of an LFS repository
- **WHEN** the user opens a pull request in a project whose `.gitattributes` declares an LFS filter and no large-file mode is recorded
- **THEN** the modal appears and the checkout waits for the choice

#### Scenario: Repository without LFS
- **WHEN** the repository declares no LFS filter
- **THEN** no modal appears and the checkout proceeds

### Requirement: The large-file choice is remembered per project

The chosen mode SHALL be stored for the project and reused for every later review checkout of that project without asking again. Settings SHALL show it and let the user change it, and a change SHALL apply to the next checkout.

#### Scenario: Second review
- **WHEN** the user opens another pull request in a project whose mode is recorded as skip
- **THEN** no modal appears and the checkout skips large files

### Requirement: Skipping large files works without Git LFS installed

In skip mode Rennet SHALL disable the LFS filter for the checkout it creates, so the checkout succeeds and leaves pointer files even when `git-lfs` is absent or the user's git config requires the filter. It SHALL NOT change the user's git configuration.

#### Scenario: Skip with git-lfs missing
- **WHEN** the mode is skip, `git-lfs` is not installed, and the user's global git config sets the LFS filter as required
- **THEN** the review checkout succeeds with pointer files and the user's git config is unchanged

### Requirement: Downloading large files requires Git LFS and offers to install it

When the user chooses download and `git-lfs` is not available, the modal SHALL offer Install for me before continuing, and SHALL offer skipping for now instead.

#### Scenario: Download chosen, git-lfs missing
- **WHEN** the user chooses Download large files and `git-lfs` is absent
- **THEN** the modal offers Install for me and Skip for now, and the checkout continues after either

#### Scenario: an answer after a cancel
- **WHEN** the user cancelled the preparation and a large-file answer arrives afterwards
- **THEN** the choice is recorded and the cancelled preparation is not resumed; only Retry starts it again
