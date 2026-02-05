export const TOOL_NAME_FOR_PROMPT = 'TaskOutput'

export const DESCRIPTION =
  '按 task_id 读取后台任务输出（适合配合 BashTool 的 run_in_background）'

export const PROMPT = `Reads output for a background task by task_id.

Use this when:
- A Bash command was started with run_in_background=true
- You need to check current output or final result

Input:
- task_id: required
- block: optional (default false). If true, wait until task finishes or timeout.
- timeout: optional (ms). Used only when block=true.
`

