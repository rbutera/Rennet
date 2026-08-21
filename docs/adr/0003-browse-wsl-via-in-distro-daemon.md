---
title: ADR 0003 - Browse a WSL source via its own in-distro daemon
description: Why the add-project directory browser lists a WSL distro by attaching that distro's own daemon instead of reading it over the UNC bridge.
---

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: source-aware project selection, WSL browsing

## Context

The add-project flow's in-app directory browser (source-aware project
selection) lists a chosen source's filesystem through the daemon RPC
`fs.listDir`. When the chosen source is a WSL distro, Rennet needs a way to
answer that RPC with the distro's directory listing.

A Windows host can already read a WSL distro's filesystem through the
`\\wsl.localhost\<distro>\...` UNC bridge, and the existing execution-locus
mechanism already understands that path form. Reusing it would let the single
Windows-side daemon serve WSL listings without spawning anything extra.

## Decision

Browse a WSL source by attaching that distro's **own** daemon (the
daemon-in-distro runtime, #437/#439) and calling `fs.listDir` on it — the same
RPC, the same handler, the same code path used for the local source and for a
paired remote.

## Alternatives considered

List a WSL distro over `\\wsl.localhost\<distro>\...` UNC through the local
Windows daemon, translating between the UNC view and the distro's native POSIX
paths at the RPC boundary.

## Why

- **One uniform code path.** `fs.listDir` behaves identically regardless of
  which source it runs on. The browser component never special-cases WSL.
- **Native POSIX paths, no UNC↔POSIX translation in the hot path.** The
  listing, the typed path bar, and the persisted `source`/`path` on the
  project are POSIX throughout. A UNC-bridge implementation would need to
  translate on every listing and on every typed path, and get it right for
  spaces, non-ASCII names, and the legacy `\\wsl$\` alias.
- **Correct for genuinely remote sources too.** A paired remote has no UNC
  bridge at all; it can only be browsed by asking its own daemon. Routing WSL
  through its own daemon keeps WSL and remote sources on the same mechanism
  instead of two.

## Cost

Selecting a WSL source pays for a daemon spawn (or reuse of an already-running
one) before a single directory can be listed. Browsing WSL is not free the way
reading the UNC bridge from the host would have been.

## Deferred limitation

`fs.listDir`'s path fields (`path`, `home`, `parent`, each entry's `path`) are
classified for the remote path-projection guard, but not yet wired into the
projection runtime's translation. Browsing a genuinely remote (projected)
source may show untranslated paths until the separate projection-runtime
effort (R19) lands. Local and WSL sources are unaffected: neither is
projected, so nothing there is rewritten today.

## Consequences

- The add-project browser has exactly one behavior to test and reason about
  across local, WSL, and remote sources.
- Browsing a WSL source is only as fast as spawning or reusing its daemon.
- Remote-source browsing carries the deferred-projection caveat above until
  R19 lands.
