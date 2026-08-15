---
name: timeless-comments
description: "Write code comments and tests that stay true over time. Comments describe the code as it stands, for a reader with only the current state in front of them — no issue or PR numbers (#123), no change-relative wording like \"new\", \"recently\", \"previously\", \"as of July 2026\"; historical context only when load-bearing, written out in the comment rather than delegated to an issue. Tests pin dates and use fixed synthetic fixtures — no current-date assertions, live credentials, or real network calls. Use whenever writing or editing comments in source code, deciding whether to cite an issue in a code comment, reviewing a diff that adds issue-number comments to code, or writing tests that touch dates, time, or external services. Also trigger when the user asks about comment style or conventions (\"should I put the issue number in a comment?\", \"is this comment okay?\"). Covers the sanctioned exceptions where issue refs belong: TODO/FIXME refs, commit messages, PR descriptions, and DESIGN.md's bug history. This skill is about comments IN source code only — do NOT use it for prose \"comments\" on PRs or issues."
---

# Timeless comments

A comment is read years after it's written, by someone with only the current code in
front of them. Comments that lean on ticket context or historical state ("what changed")
lose meaning every month after they merge — the reader either chases the reference out
of the codebase or learns to ignore comments entirely.

The same failure mode hits tests: assertions tied to the current date, live services, or
changing vendor data pass today and rot silently.

## Comments describe the current state

Write every comment as a statement about the code as it stands — never about the change
that introduced it.

**No issue or PR numbers.** Don't cite GitHub issues (`#123`), PRs, or review/Slack
conversations to explain code. Provenance already lives in git blame and the PR; an
issue pointer sends the reader out of the code to reconstruct context the comment should
carry itself. If the reasoning matters, write the reasoning. If it doesn't, drop the
reference.

| | |
|---|---|
| BAD | `// #42: reset to the branch's own commit, not parentRef` |
| GOOD | `/** The branch's own first commit -- reset target between fixer attempts, distinct from parentRef so a reset never touches the parent's history. */` |

**No change-relative or time-relative wording.** "new", "now", "previously", "recently",
"as of 2026-07", "the old way", "used to be" describe a diff, not the code, and are
stale as soon as the next change lands. State a rejected alternative in the present
("X, not Y: Y would ..."), not as history ("was Y, which broke ..."). If something is
genuinely temporary, don't just label it — state the exit condition in a tracked `TODO`
(see exceptions below).

**Historical context only when it is load-bearing.** When the current state can't be
understood without history (a deliberately rejected alternative, a quirk left behind by
an old backfill), include it — written out in the comment, self-contained, not delegated
to an issue. Epistemic markers on claims about external tool behavior ("verified
directly against a real repro: gt fails with ...") are current-state facts about the
world, not change narration — they stay.

## Sanctioned exceptions

Issue references belong in artifacts that are themselves point-in-time change records:

- **`TODO`/`FIXME` comments** — these MUST reference a tracked issue
  (`TODO(#123): ...`); they describe future work, so the tracking pointer is the point.
- **Migrations** — dated, issue-stamped filenames and their header comments describe a
  change on purpose.
- **Commit messages, PR descriptions, and changelog entries** — change records where
  issue references are encouraged.
- **DESIGN.md's bug history** — deliberately a running change record ("real bugs
  already found and fixed"). History worth keeping goes there, not into code comments.

## Timeless tests

A test that passes today must pass unchanged years from now:

- No assertions that depend on the current date or time; pin dates explicitly. A
  hardcoded date that is "safely in the future" today is a test that starts failing the
  day it isn't. (Clock reads that only generate unique IDs — e.g. `Date.now()` in a
  workflow ID — are fine; no assertion depends on them.)
- No live credentials, no real network calls, no dependence on changing external
  datasets. Local, pinned dev infra is fine — this repo's tests run against the
  Dockerized Temporal from `just infra-up` and offline `git`/`gt`, which is
  deterministic; the rule targets live external services.
- Prefer small fixed synthetic payloads over broad snapshots of real third-party
  responses — include only the fields the behavior under test needs.

## Scope

These rules apply to comments and tests you add or edit. Don't mass-strip issue refs
from code you aren't otherwise touching; clean up opportunistically when the code they
annotate changes. Comments in existing code should not be removed unless that code is
being removed.

This skill governs comments **in source code** only. Prose on PRs and issues is a
different register — issue references are encouraged there, since those artifacts are
change records themselves.
