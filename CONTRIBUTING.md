# Contributing to Rennet

Thanks for your interest. Rennet is Rai Butera's product; this repository is
open for reading, running, and contributions under the terms below.

## Licence

Rennet is licensed under [FSL-1.1-MIT](./LICENSE) (Functional Source License,
MIT Future License). It is **source-available**, not OSI "open source": free to
read, run, modify, and redistribute for any purpose except building a product
that competes with Rennet, and each release converts to the MIT licence two
years after publication.

By contributing, you agree that your contribution is licensed under FSL-1.1-MIT
on the same terms as the rest of the project.

## Developer Certificate of Origin

Every commit must be signed off. Rennet uses the
[Developer Certificate of Origin](https://developercertificate.org/) (DCO) 1.1:
by signing off you certify that you wrote the contribution, or have the right to
submit it under the project's licence.

Add the sign-off automatically:

```sh
git commit -s
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer using your
configured `git` identity. A pull request whose commits are not signed off
cannot be merged.

The sign-off keeps Rennet's licensing coherent: because every contribution is
certified as submittable under the project licence, the copyright stays clean
enough to offer a separate commercial licence to a customer who needs one, or to
relicense the project in future, without hunting down past contributors.

Do not add AI attribution or `Co-authored-by` trailers. The sign-off names the
human submitting the work.

## Before you open a pull request

- Run the full gate: `pnpm check` (format, architecture, licences, lint,
  typecheck, test, build). It must pass, including its positive controls.
- Update the affected documentation **in the same change**. If a reader would be
  wrong after your change, the change is not done. See
  [`docs/developing/contributing/docs-style-guide.md`](./docs/developing/contributing/docs-style-guide.md).
- A new dependency must clear the [dependency standard](./docs/developing/reference/dependency-standard.md);
  its licence must pass `scripts/check-licenses.mjs`. If you change the
  production graph, regenerate attribution with `pnpm notices`.

## Reporting issues

Use the GitHub issue tracker. For security vulnerabilities, do not open a public
issue — contact the maintainer directly.
