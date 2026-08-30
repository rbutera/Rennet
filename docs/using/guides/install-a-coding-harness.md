---
title: Install a coding harness
description: Install and sign in to Claude Code or Codex so Rennet can run reviews through your existing account.
---

Rennet needs Claude Code or Codex in each environment where it reviews code.
Install either one; install both to use Dual Harness and see two independent
reads of the same evidence.

## Claude Code

Follow Anthropic's [Claude Code setup guide](https://docs.anthropic.com/en/docs/claude-code/getting-started),
or install the current npm package:

```sh
npm install --global @anthropic-ai/claude-code
```

Launch `claude` once and finish its sign-in flow. Then verify the executable is
available to Rennet:

```sh
claude --version
```

## Codex

Follow OpenAI's [Codex CLI guide](https://help.openai.com/en/articles/11096431),
or install the current npm package:

```sh
npm install --global @openai/codex
```

Launch `codex` once and sign in with your existing OpenAI or ChatGPT account.
Then verify the executable:

```sh
codex --version
```

On macOS, Rennet can also use the Codex executable shipped with the ChatGPT
desktop app. A separately installed Codex CLI takes precedence. On Windows,
install Codex CLI because another application cannot execute the binary inside
the Microsoft Store ChatGPT package.

## Let Rennet detect it

Return to the first-run welcome and choose **Check again**, or open **Settings →
Environments** after setup. Detection runs separately on this machine, each WSL
distro, and every paired environment. A harness installed on the host does not
stand in for one missing inside WSL or on a remote machine.

Rennet launches the harness you installed and uses that harness's existing
authentication. It does not ask for a model API key or copy the harness's
credentials.

Work-order rounds use the harnesses enabled for that machine or WSL distro in
**Settings → Environments**. A session's first round selects an available enabled
harness (Claude Code when both are enabled) and keeps that provider for later
rounds. To start a Codex-backed session on a machine with both installed, disable
Claude Code before dispatching its first round. Each round's history row names the
exact harness and version that ran it.

If `claude --version` or `codex --version` works in a terminal but Rennet still
cannot detect it, fully quit and reopen Rennet so the desktop process receives
your current executable paths.
