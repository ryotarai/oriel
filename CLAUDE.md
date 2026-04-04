# Project Instructions

## Execution Style

When executing implementation plans, always use subagent-driven development (superpowers:subagent-driven-development).

## Running the Server

```
make build
./bin/oriel
```

## Git Workflow

After completing work, automatically commit the changes with proper logical units. Group related changes into separate commits rather than making one large commit.

## Temporary Files

Use `./tmp/` for files that should NOT be committed to the repository:
- Screenshots and test result images
- Build artifacts and binaries
- Profiling scripts and analysis outputs
- Any other throwaway or debugging files

The `tmp/` directory is already in `.gitignore`.
