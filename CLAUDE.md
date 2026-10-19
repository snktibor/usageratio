@AGENTS.md

## Git workflow

- Work on a feature branch (`feat/…`, `fix/…`, `docs/…`); never commit directly on `main`.
- Bring work into `main` only through a pull request merged with **Squash and merge** (`gh pr merge --squash`). The squash commit's title must be a Conventional Commit, because release-please reads it. Locally, use `git merge --squash <branch>` with one Conventional Commit for the whole branch.
- Never fast-forward `main` or create a merge commit that carries the branch's individual commits.
- Never rewrite `main`'s pushed history to fix commit counts.

Why: GitHub's contribution graph counts every commit reachable from `main`. Unsquashed merges pushed a single day to 91 commits and flattened the colour scale. A rewrite does not fix this, because GitHub keeps counting the orphaned commits (2026-10-18).
