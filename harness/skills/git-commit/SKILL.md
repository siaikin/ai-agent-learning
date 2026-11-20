---
name: git-commit
description: Write a git commit for the current changes following the Conventional Commits format. Use when asked to commit.
---
# Git commit

## Steps
1. Run `git status` and `git diff --staged`. If nothing is staged, look at `git diff` and stage only the files that belong to this change (`git add <paths>`); never use `git add -A` blindly.
2. Make sure no secrets or generated files are staged: `.env`, keys, build output, `node_modules`.
3. If the project has tests or a type check, run them before committing and mention the result.
4. Write the message:
   - First line: `type(scope): summary`, at most 72 characters, imperative mood ("add", not "added").
   - `type` is one of: feat, fix, refactor, docs, test, chore, perf, build, ci.
   - Blank line, then a body explaining **why** the change was made, wrapped at 72 characters.
5. Commit with `git commit -m "<first line>" -m "<body>"`.
6. Do not push unless the user asked for it.

## Example
```
fix(permission): match sudo as a whole word

"echo pseudo" was blocked because the deny rule used substring
matching. Use a word boundary so only the sudo command matches.
```
