---
name: code-review
description: Review a diff or a set of files for bugs, risky changes and missing tests, and report findings ranked by severity. Use when asked to review code or before committing a non-trivial change.
---
# Code review

## Steps
1. Find what changed: `git diff` (or `git diff --staged`) for local changes; read the files if there is no git.
2. Read each changed file fully, not only the hunk, so you understand the surrounding code.
3. Check, in this order:
   - **Correctness**: wrong conditions, off-by-one, null/undefined, unhandled errors or rejected promises, wrong async ordering.
   - **Behavior changes**: renamed or removed exports, changed defaults, changed file formats that other code depends on.
   - **Security**: if the change touches input handling, shell commands, file paths, auth or secrets, read `references/security.md` (load it with `load_skill` and `file`).
   - **Tests**: is the new behavior covered? Run the existing tests if there is a test command.
4. Do not report style nits that a formatter or linter would catch.

## Report format
List findings most severe first. For each one:
- `file:line` and a one-sentence statement of the problem
- a concrete scenario that triggers it (inputs or state → wrong result)
- a suggested fix

End with one line: either "No blocking issues found" or the number of blocking issues.
