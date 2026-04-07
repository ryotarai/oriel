# Project Instructions

## Session Start

- At the start of a session, if the current working directory is inside a git worktree (e.g. `.claude/worktrees/`), call ExitWorktree to return to the repo root — unless the user's instruction is specifically about that worktree.

## Execution Style

When executing implementation plans, always use subagent-driven development (superpowers:subagent-driven-development).

## Running the Server

```
make build
./bin/oriel
```

## Git Workflow

- Direct pushes to `main` are not allowed. Always create a PR.
- When modifying files, create a git worktree (use the `EnterWorktree` tool) and do all work there.
- After completing work, automatically commit the changes with proper logical units. Group related changes into separate commits rather than making one large commit.

## Temporary Files

Use `./tmp/` for files that should NOT be committed to the repository:
- Screenshots and test result images
- Build artifacts and binaries
- Profiling scripts and analysis outputs
- Any other throwaway or debugging files

The `tmp/` directory is already in `.gitignore`.
