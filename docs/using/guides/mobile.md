---
title: Rennet on your phone
description: The planned native client for reading reviews, answering asks, and posting from a paired phone.
status: planned
tracking: https://github.com/rbutera/Rennet/issues/383
---

Rennet's native phone client is under development. The source-built app can read
and act on daemon state, but public distribution and the complete desktop pairing
path are not finished. Progress is tracked in
[GitHub issue #383](https://github.com/rbutera/Rennet/issues/383).

The phone is a client for a daemon running on a machine that holds the
repositories. It can aggregate reviews from paired daemons, retain local replicas
for reading, follow live turns, answer questions, and use daemon-composed outbound
artifacts.

## Data paths

Review traffic goes directly between the phone and the paired daemon over the
private network. Rennet does not operate a hosted relay or backend for that
traffic.

Push notifications use third-party infrastructure. The daemon sends the Expo
push token, notification title and body, deep link, and any notification actions
to Expo. Expo forwards the notification through Apple or Google. Rennet does not
put host paths or the paired-device bearer token in that payload.

Disabling push delivery leaves the in-app event stream available while the phone
can reach the daemon.

## Run a development build

Install workspace dependencies, then run Expo from `apps/mobile`:

```sh
pnpm exec expo run:ios
pnpm exec expo run:android
```

Push registration also requires an Expo project ID in the native build. A build
without one can still receive in-app attention events.

## Pairing status

The phone accepts a pairing link shaped like
`rennet://pair?url=...&code=...`. It exchanges the code for a device token and
stores that token with the platform's secure storage.

The desktop currently exposes **Settings > Pairing > Create pairing code**, but
does not yet generate the QR code or complete pairing link required by the phone.
Until that desktop path is implemented, the pairing instructions below are not a
complete user flow:

1. Connect the phone and daemon machine to the same private network.
2. Open the desktop pairing settings and create a single-use code.
3. Open the generated pairing link on the phone or scan its QR code.
4. Confirm that the daemon appears in **Connections**.

The Connections screen retains the last replica for an unreachable daemon. A
paired device can be revoked from the daemon, which closes its current connection
and stops future connections and pushes.

## Read a review

The Reviews list combines replicas from paired daemons. Running reviews and
reviews that need attention appear first. When a daemon is unavailable, the app
opens its last stored replica and reconciles after reconnecting.

The review screen starts with the delta digest, followed by the sequence canvas.
Findings open individually with their code and disposition actions. A disposition
written on the phone is sent to the daemon and becomes visible to other clients.

## Follow a live turn

**Live turn & ask** first renders the persisted turn, then appends live events.
After reconnecting, it requests missed events and removes duplicates. **Return to
tail** moves the view back to the newest event.

**Stop** interrupts a running turn. The stored outcome is `interrupted`.

## Answer a question

An ask can contain answer chips and a free-text field. A chip, text, or both are
sent as one reply. **Send** interrupts the active turn before replying. Holding
the send control replies without interrupting it. The unsent draft is stored per
review.

On Android, a notification action can run the reply task in the background. On
iOS, the action opens the app with the answer prepared and sends it from there.
When delivery fails, the notification opens the ask so the user can retry.

## Post an outbound artifact

The mobile Publish screen uses a direct post action. The daemon composes the
outbound bytes and the phone displays the verdict and destination before sending
them.

For a team pull request, the daemon composes the review comments and verdict. For
an own branch, it composes the pull request title, body, base, and head. Posting is
idempotent, so a retry resolves to the same GitHub review or pull request.

**Ask for changes** starts a refinement turn instead of editing the outbound text
on the phone.

## Start a review

The kickoff screen accepts a GitHub pull request URL or one of the paired
project's branches. It streams capture progress and opens the resulting review.
If no paired daemon owns the repository, the screen reports that no matching
project is available.

Paste and `rennet://kickoff` links work on both platforms. Android also accepts a
GitHub URL through the system share sheet. The iOS share extension is part of the
planned work tracked by issue #383.

## Notifications

The app asks for notification permission when push is enabled in **Settings >
Notifications**. Attention events have three priorities:

- **A turn needs you**, **Review finished**, and **Something went wrong** are high
  priority and remain push-eligible when the device is away.
- **Agent finished your asks** and **Ready to post** are normal priority and can be
  muted by family.
- **Project processed** is silent and appears only in the app.

A client focused on the affected review receives the live event instead of a
push. A backgrounded device remains push-eligible. Opening the linked review or
answering the ask clears the matching attention item across connected clients.

## Desktop-only work

The phone does not edit repository files, browse the host filesystem, or open a
host editor. Those actions stay on the machine that runs the daemon and coding
harnesses.
