export const DESCRIPTION =
  'Reads the current todo list for task tracking in the current session/agent.'

export const PROMPT = `Use this tool to read the current todo list.

When to use:
- The user asks to see the todo list or progress
- You want to verify the current todo state before updating it

Notes:
- This tool is read-only and does not modify any state.
- To create/update todos, use TodoWrite.
`

