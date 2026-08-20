# Rennet ubiquitous language

This file defines the terms shared by the product, documentation, and code. It contains no implementation guidance or architecture decisions.

## Documentation

- **Documentation library**: the canonical current and planned Rennet documentation, readable on GitHub and rendered by the docs app.
  _Avoid_: Docsite, docs source
- **Docs app**: the application that renders the documentation library at `docs.rennet.dev`.
  _Avoid_: Documentation, docs library
- **Project authority**: a current document with final say over one named part of the product or engineering model.
  _Avoid_: Source of truth
- **Decision record**: a narrow architectural choice and the reason it applies.
  _Avoid_: Ruling, spec
- **Promoted spec**: an accepted behavioral contract for one Rennet capability.
  _Avoid_: Plan, change
- **Planned page**: documentation for accepted behavior that is not live on `main` and cites its active tracking source.
  _Avoid_: Historical page, roadmap

## GitHub account

- **Device sign-in**: the GitHub OAuth flow in which Rennet shows a short code and the user enters it on GitHub.
- **Side door**: the Settings action that accepts a personal access token instead of device sign-in.
- **Token store**: Rennet's local record of the connected GitHub credential.
- **Connect card**: the optional first-run control for starting device sign-in.
- **Not connected**: no GitHub credential is available.
- **Token invalid**: GitHub rejected the available credential.
- **Insufficient scope**: the credential is valid but lacks a permission required by the requested GitHub action.

## Reviewing pull requests

- **Retrospective review**: a review of a closed or merged pull request. It can inspect the captured change but cannot post.
- **Managed clone**: a repository clone that Rennet owns because it could not use a matching local clone.
- **PR worktree**: a checkout of the exact pull-request commit under review.
- **Setup file**: `.rennet/setup`, a list of shell commands Rennet runs when preparing a PR worktree.

## Desktop presence

- **Logo menu**: the menu opened from the top-left Rennet mark. It contains application destinations, version information, and the restart action when an update is ready.
- **Owned daemon**: the local daemon whose lifecycle belongs to this desktop application.
- **Attached daemon**: a daemon that the application uses but does not own.
- **Tray-resident**: the desktop application has no open window but remains available from the system tray with its daemon and streams intact.
- **Update-ready**: an update has downloaded and will apply when the user chooses the restart action.
