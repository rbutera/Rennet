---
title: Rennet on your phone
description: Pair the native Rennet app with your daemon over Tailscale, read a whole review at phone width, and get pushed when a review needs you.
---

The native Rennet app is a triage-and-read client for when you are away from the
desk. Your reviews still run on your machine — the phone is a remote control, not a
second place work happens. It pairs with any number of daemons, aggregates their
reviews into one list, reads the whole review at phone width, and pushes you when
something needs you. There is no Rennet backend: the phone reaches your daemon
directly over your tailnet, and the only egress is the harness/provider egress your
desktop already discloses.

This is the phase 6 **M1** cut: pair, read, and be notified. Answering an ask,
posting a review, and starting one from a shared PR link land in M2.

## Pair a phone

Pairing is connection bootstrap, not a consent ceremony: you do it once and the
daemon just works on every later open.

1. On your desktop, open **Settings → Devices → Pair**. It mints a one-time code and
   shows a QR (and a copyable pairing link).
2. Join your tailnet on the phone, open the app, and tap **Scan pairing QR** — point
   it at the desktop QR. If the camera cannot scan, paste the pairing link instead.
3. The app exchanges the code for a **device token**, stores it in the platform
   keychain (iOS Keychain / Android Keystore), and the daemon appears in **Connections**
   as reachable.

The **Connections** screen lists every paired daemon with its live reachability, the
harnesses it disclosed, and this phone's revocable device token. An unreachable daemon
stays listed with its last replica readable — never blank — and you can **revoke** the
token from the phone, which stops any further pushes to it.

## Read a review

The **Reviews** list aggregates across every paired daemon. Running and needs-you
reviews pin to the top; the rest group by recency, with freshness shown as a row fact.
It paints from the last replica instantly when you open it — even offline — and
reconciles once it reaches the daemon.

Open a review and the **delta digest** leads: what changed since the last patchset,
then the canvas entries. From there:

- **Full sequence canvas** renders the whole review — every finding and hunk in reading
  order, virtualized so it stays smooth to the last line. The digest is the entry point,
  never a boundary: nothing sends you to a desktop to finish reading.
- **Findings** open one at a time — read the claim and hunk, and set a disposition
  (agree / disagree / discuss) with one tap. A disposition you set on the phone persists
  on the daemon and shows up on your desktop.

## Notifications

The app registers for push with each paired daemon and asks for notification permission
at the point you turn push on (Settings → Notifications), not on first launch. The
taxonomy is a closed set of six events, shown as switches:

- **A turn needs you**, **Review finished**, and **Something went wrong** are the
  high-priority events.
- **Agent finished your asks** and **Ready to post** are normal-priority.
- **Project processed** is quiet — it updates in the app only, never a buzz.

Delivery is decided on the daemon by your presence: a device focused on the affected
review gets the live in-app event and no push, while a backgrounded phone gets the push.
Every push carries its substance and deep-links to the decision surface — a "review
finished" push opens straight on that review's digest — and opening the linked surface
clears the attention everywhere, so a handled item stops demanding attention on your
other devices too. You only hear about a review you are not already looking at.

## What the phone deliberately does not do

Not because it is forbidden — because the locus makes it desk work: editing code,
browsing the host filesystem, or replacing the desk for dense multi-file reading. The
phone is a full peer within its locus (triage and read), and those capabilities are
absent by *place*, never by permission.
