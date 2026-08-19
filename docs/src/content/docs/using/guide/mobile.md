---
title: Rennet on your phone
description: Pair the native Rennet app with your daemon over Tailscale, read a whole review at phone width, and get pushed when a review needs you.
---

The native Rennet app is a triage-and-read client for when you are away from the
desk. Your reviews still run on your machine — the phone is a remote control, not a
second place work happens. It pairs with any number of daemons, aggregates their
reviews into one list, reads the whole review at phone width, and pushes you when
something needs you. There is no Rennet backend: the phone reaches your daemon
directly over your tailnet, and reading a review adds no egress beyond the
harness/provider egress your desktop already discloses.

One honest exception, if you turn notifications on: a push is not peer-to-peer.
When your daemon has a review to notify you about, it posts the notification's
content — its title and body (a repo name and a short line like "is ready to
read") plus the deep-link — outbound to Expo's push service, which hands it to
Apple's or Google's notification infrastructure to reach your phone. That is real
third-party egress, and it carries the push's substance (never a host path or a
token). Leave notification delivery off and none of that happens — the in-app
event over your own tailnet is the only path.

With the phase 6 **M2** cut the phone also *acts*: watch a live turn and stop it,
answer an ask (from the app or straight from the notification shade), post a review,
and start one from a PR link or the share sheet. Those sections are below, after
reading.

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

## Watch a live turn

Open a review's **Live turn & ask** and the screen paints the turn's persisted state
first, then follows the live stream — a typed timeline of the turn's messages. Switching
from Wi-Fi to cellular mid-turn is the normal case, not a recovery: the timeline catches
up and keeps flowing, and no message renders twice. When you have scrolled up, a **return
to tail** control jumps you back to the live edge.

A running turn shows a **Stop**. One tap interrupts it; the timeline then states the
interrupted outcome truthfully — a stopped turn reads as *interrupted*, never as one that
silently quit.

## Answer an ask

When a turn needs you, the ask renders its question with any **answer chips** and an
optional free-text field. A chip alone, text alone, or both together compose into a
single reply — the chip is the decision, the text is your direction, and they travel as
one message. **Send** interrupts the running turn and sends; **hold** the send button to
send without interrupting. What you are composing persists per review, so leaving and
coming back does not lose a half-typed answer.

You can also answer **without opening the app**. An ask push carries its chips as
notification actions: pick one on the lock screen and it round-trips to the daemon as the
same reply. Where the platform allows a background response the app never opens; where it
does not, the action opens the app with your answer ready to send — still one tap. Either
way the outcome is truthful: on success the attention clears everywhere; if the answer
cannot land (the daemon is unreachable, or the turn was already answered) the notification
says so and deep-links you into the ask, so an answer is never silently dropped or
duplicated.

**Platform coverage (honest):** shipping now on both platforms are the in-app ask card
and the deep-link that lands you on it. Registering the chips as lock-screen actions is
declared and wired; whether a chosen chip answers fully in the background is platform- and
permission-dependent (iOS limits background execution), and the app falls back to
open-and-send when the background path is denied — never a dropped answer.

## Post a review

The **Publish** screen is preview → post, with no ceremony. The preview shows the
composed outbound review — its verdict and destination — and one tap posts it. There is no
sign step, no biometric, no are-you-sure: the post button is the click. The posted screen
states the real URL, and posting is idempotent — a double tap or a retry over a flaky
connection yields exactly one review (or one pull request), never two.

If the preview is not what you want, **Ask for changes** starts a refine turn and lands
you on the live turn screen. The phone never text-edits the outbound review — you steer it
with a turn, the same as everywhere else in Rennet.

Both loops post end to end from the phone. For a **team-PR review**, the daemon composes
the outbound comments and verdict from your dispositions and the phone posts exactly those
bytes as one neutral review event on the pull request. For your **own branch**, the daemon
composes the PR submission (title, body, base, head) and the phone opens one pull request
from exactly those bytes. Either way, what you preview is what posts — byte for byte — and
the daemon is the single source that composes it, so the phone and the desktop post the
same review. If your daemon predates this (it does not yet know how to compose for the
phone), the publish screen says it needs updating rather than showing a dead post button.

## Start a review

Tap **New review** (or share a GitHub PR URL to Rennet from another app) to reach the
kickoff screen. Paste — or land with — a PR link and the app opens it against the matching
paired project; pick one of your **branches** to capture a pre-submit review of your own
work. Progress streams live, and the new review appears in your list. A shared or pasted
PR whose repository no paired daemon owns says so honestly, rather than opening it against
the wrong clone.

**Share-sheet coverage (honest):** paste-a-link and the `rennet://kickoff` deep link work
now on both platforms, and Android declares a share target. The full OS share extension
(receiving a shared URL directly from another app's share sheet on both platforms) is a
recorded follow-up — the Expo share-intent module it needs is deferred to keep this pass
free of an unverifiable native dependency.

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
phone is a full peer within its locus (triage, read, and act — watch, answer, post, kick
off), and those capabilities are absent by *place*, never by permission.
