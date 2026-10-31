# Security policy

## Supported versions

Security fixes target the latest published release and the current `main` branch.
Older releases are not maintained separately; please update before checking
whether a problem still occurs.

## Development dependency alerts

All packages below are transitive development dependencies of `web-ext` and are
excluded from the browser store ZIPs. Checked on 2026-10-08:

- [shell-quote command injection](https://github.com/advisories/GHSA-pqg4-j6r4-53mv):
  upgraded from 1.10.0 to 1.12.0 (fixed in 1.11.0). An npm override is needed
  because `fx-runner@1.6.0` pins 1.10.0. Remove the override once its dependency
  accepts a fixed version.
- [source-map-js denial of service](https://github.com/advisories/GHSA-68fv-2mgg-jv7q):
  upgraded from 1.2.1 to the patched 1.2.2 within `css-tree`'s existing range.

`tests/dependency-security.test.mjs` checks rejection of the shell-quote attack
inputs and excessive indexed source-map offsets, alongside valid input behavior.

`node-forge` (a transitive `web-ext`/`@devicefarmer/adbkit` dependency, also
excluded from the ZIPs) has no fixed npm release yet; it is only used for
Android debugging and does not affect the extension's browser behaviour.

## Report a vulnerability privately

Use GitHub's **[Report a vulnerability](https://github.com/aciokie/Chess-Review/security/advisories/new)**
form to send a private report to this fork's maintainer.

If you cannot use GitHub's reporting form, open a public issue titled
**Security contact request** with no vulnerability details in it, and the
maintainer will arrange a private channel. Please do not open a public issue or
pull request containing vulnerability details.

Include, where available:

- The affected extension version or commit, browser version, and operating system.
- A description of the vulnerability and its potential impact.
- Reproduction steps or a minimal proof of concept.
- Relevant logs or screenshots, with personal information and credentials removed.

Please test only with accounts and data you control. Keep details private while
we investigate and coordinate a fix and disclosure with you. Reports are reviewed
as maintainer time allows; there is no guaranteed response or resolution time.

For ordinary bugs, analysis disagreements, and feature requests, use
[GitHub issues](https://github.com/aciokie/Chess-Review/issues).
For information about data handling, see [PRIVACY.md](PRIVACY.md).
