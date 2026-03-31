---
name: add-task
description: Use when the user wants to add a task, todo item, or action item to the project task list. Triggers on phrases like "add task", "add todo", "new task", "track this".
---

# Add Task

Append a task to the Markdown task list at `./tmp/tasks.md`.

## How It Works

1. Read `./tmp/tasks.md` (create it with a `# Tasks` heading if it doesn't exist)
2. Append `- [ ] <task description>` to the end of the file
3. Confirm the task was added

## Rules

- Each task is a single Markdown checkbox line: `- [ ] description`
- Preserve all existing content in the file — only append
- If the user provides multiple tasks at once, add each on its own line
- Do not modify or reorder existing tasks
