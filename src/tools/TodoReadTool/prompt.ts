export const DESCRIPTION =
  '读取当前会话/Agent 的 TODO 列表（只读），用于查看任务进度与校对更新前状态。'

export const PROMPT = `使用 TodoRead 工具读取当前 TODO 列表（只读）。

适用场景：
- 老师要看 TODO 列表或当前进度
- 调用 TodoWrite 前，需要先确认当前 TODO 状态
- 你担心直接写入会覆盖掉已有项目时

说明：
- 这个工具是只读的，不会修改任何状态。
- 创建/更新 TODO 请使用 \`TodoWrite\`。
`
