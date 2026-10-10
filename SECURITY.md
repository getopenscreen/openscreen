# Security Policy

## Supported versions

Security fixes land on the latest stable release only. Pre-releases (`-rc.N`) are superseded by the
next stable version and are not patched on their own.

| Version                 | Supported |
| ----------------------- | --------- |
| Latest stable (2.0.x)   | Yes       |
| Older releases          | No        |
| Release candidates      | No        |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub instead:
[Report a vulnerability](https://github.com/getopenscreen/openscreen/security/advisories/new).
This opens a private advisory that only you and the maintainers can see.

A useful report includes:

- the OpenScreen version and how it was installed (Microsoft Store, installer or package
  from the Releases page, Nix…)
- the operating system and version
- the steps to reproduce, or a proof of concept
- the impact you expect: what an attacker gains, and under which conditions

## What happens next

OpenScreen is maintained by volunteers, so these timelines are best-effort:

- an acknowledgement within 7 days
- a first assessment, confirmed or not, within 14 days
- for a confirmed issue, a fix in the next release, then a published advisory crediting you,
  unless you prefer to stay anonymous

Please keep the details private until the fix is released and the advisory is published.

## Scope

In scope: the OpenScreen desktop app and everything this repository builds and ships with it,
including the native capture helpers, the Rust compositor and the auto-update mechanism.

Out of scope: vulnerabilities in third-party dependencies that are already public upstream (a
heads-up is still welcome), and issues that require an attacker who already controls the user's
machine or account.
