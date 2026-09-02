# T3 Code patch ledger

Every vendored file Rennet has changed from the pristine snapshot on the `t3-vendor` branch, with why. `pnpm t3:check-ledger` fails on any vendored file that differs from the snapshot and is not listed here. Paths are relative to `vendor/t3code/`. Rennet-owned files inside the tree (`UPSTREAM.json`, this file, `digests/`, any `project.json`, any `tsconfig.rennet.json`) never need a row.

Prefer extension over edit: put Rennet code outside `vendor/` and import their modules. When upstream merges a change listed here, the fold that brings it in removes the row.

| File | Reason | Upstreamable | Upstream PR |
| --- | --- | --- | --- |
