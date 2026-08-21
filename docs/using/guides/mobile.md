---
title: Rennet on your phone
description: The planned native client for reading reviews, answering asks, and posting from a paired phone.
status: planned
tracking: https://github.com/rbutera/rennet/issues/383
---

Rennet's native phone client is planned, not released. It is tracked in
[GitHub issue #383](https://github.com/rbutera/rennet/issues/383) and gated behind
the mobile design pass in [#382](https://github.com/rbutera/rennet/issues/382).
This page describes what that work promises so you can tell whether it fits how
you review. It is not yet a guide to an app you can install.

The phone is a client for a daemon running on the machine that holds the
repositories. The promise of #383 is a full peer within its private network: pair
once, then read a review, watch a running turn live, answer an ask, and sign and
post from the phone, with a push when a turn needs you.

## Data paths

Review traffic goes directly between the phone and the paired daemon over the
private network. Rennet does not operate a hosted relay or backend for that
traffic. [Tailscale](https://tailscale.com/) is the documented route, the same one
[Remote access](./remote-access.md) covers.

Push notifications use third-party infrastructure. The daemon sends the Expo push
token, notification title and body, deep link, and any notification actions to
Expo, which forwards the notification through Apple or Google. Rennet does not put
host paths or the paired-device token in that payload. With push disabled, the
in-app event stream still works while the phone can reach the daemon.

## Current status

A source-built app lives in `apps/mobile` (Expo and React Native) and can already
read and act on daemon state. It is not publicly distributed, and the desktop does
not yet generate the QR code or pairing link the phone needs, so there is no
complete end-to-end pairing flow yet. The app pairs by exchanging a
`rennet://pair?url=...&code=...` link for a device token stored in the platform's
secure storage, the same pairing model [Remote access](./remote-access.md)
describes.

The phone will not edit repository files, browse the host filesystem, or open a
host editor. Those actions stay on the machine that runs the daemon and coding
harnesses.
