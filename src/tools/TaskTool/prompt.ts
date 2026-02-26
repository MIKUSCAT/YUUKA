import { type Tool } from '@tool'
import { getTools } from '@tools'
import { TaskTool } from './TaskTool'
import { BashTool } from '@tools/BashTool/BashTool'
import { FileWriteTool } from '@tools/FileWriteTool/FileWriteTool'
import { FileEditTool } from '@tools/FileEditTool/FileEditTool'
import { NotebookEditTool } from '@tools/NotebookEditTool/NotebookEditTool'
import { GlobTool } from '@tools/GlobTool/GlobTool'
import { FileReadTool } from '@tools/FileReadTool/FileReadTool'
import { getModelManager } from '@utils/model'
import { getActiveAgents } from '@utils/agentLoader'

export async function getTaskTools(_safeMode: boolean): Promise<Tool[]> {
  // Task teammates 需要完整工具集；是否允许执行由 safeMode + 权限系统控制
  return (await getTools()).filter(
    _ => _.name !== TaskTool.name && _.name !== 'TaskBatch',
  )
}

export async function getPrompt(safeMode: boolean): Promise<string> {
  // Read agent descriptions from `.yuuka/agents`
  const agents = await getActiveAgents()
  
  // Format exactly as in original: (Tools: tool1, tool2)
  const agentDescriptions = agents.map(agent => {
    const toolsStr = Array.isArray(agent.tools) 
      ? agent.tools.join(', ')
      : '*'
    return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsStr})`
  }).join('\n')
  
  // Keep wording stable so agent behavior is predictable across sessions
  return `## 并行执行规则（CRITICAL）

当有 2 个以上独立子任务时：
- 优先使用 TaskBatch 一次性启动，保证进程级真并行
- 禁止逐个调用 Task 来执行可并行的工作
- TaskBatch 保证每个任务运行在独立的 OS 进程中

决策框架：
1. 任务之间无数据依赖？→ TaskBatch
2. 需要边协调边执行？→ 多个 Task(wait_for_completion=false) + TaskStatus
3. 只有一个任务？→ Task

---

使用 Task 工具启动一个 Agent，让它自主处理复杂、多步骤任务。

可用 Agent 类型（以及它们可使用的工具）：
${agentDescriptions}

使用 Task 工具时，必须填写 Agent 类型参数 \`subagent_type\`。
如果启用了进程模式，可以额外传 \`team_name\` 和 \`name\`，把任务路由到 TEAM/AGENT 进程。
如果需要真正的并行编排（先启动、边跑边协调、再查状态），请使用 \`wait_for_completion=false\`。
使用 \`team_name\` 时，队友应通过 \`SendMessage\` 和共享任务板工具（\`TaskCreate/TaskList/TaskUpdate\`）协作。

## 何时使用 Task 工具
- 当任务明显适合某个 Agent（研究、审查、专项处理）时，直接调用
- 当需要执行自定义斜杠命令时，把斜杠命令作为完整 prompt 交给 Task 工具（可带参数）
- 例如：\`Task(description="检查文件", prompt="/check-file path/to/file.py")\`

## 何时不要使用 Task 工具
- 如果只是读取一个明确文件路径，优先用 ${FileReadTool.name} / ${GlobTool.name}，更快
- 如果只是搜索某个类定义（如 \`class Foo\`），优先用 ${GlobTool.name}
- 如果只在 2-3 个文件里找代码，优先用 ${FileReadTool.name}
- 与上述 Agent 描述无关的简单任务，不要硬用 Task 工具

## 使用注意事项
1. 能并行就并行：在同一条消息里发起多个工具调用，可以同时启动多个 Agent
2. 如果需要 lead 一边协调一边等队友跑，使用 \`Task(wait_for_completion=false)\`，然后用 \`TaskStatus / SendMessage / 共享任务工具\` 协调
3. 如果已经明确所有独立子任务且只想要稳定汇总结果，优先用 \`TaskBatch\`
4. 一轮并行编排里只使用一个 TEAM，并在该 TEAM 内创建多个 AGENT
5. 分离启动后要保存 \`task_id/team_name/agent_name\`，后续用 \`TaskStatus\` 查询/等待
6. 队友完成后，要用自然语言向老师总结关键结果
7. 队友运行在 TEAM 进程模式中，可通过 \`SendMessage\` 和共享任务板协作
8. 一般情况下可以信任 Agent 输出，但关键结论要做必要验算
9. 调用前要明确告诉 Agent 预期是“写代码”还是“做研究/搜索/读文件/抓网页”等
10. 如果某个 Agent 描述写了“应主动使用”，在合适场景下就主动调用，不必等老师点名

## 示例

<example_agent_descriptions>
"code-reviewer": 在完成一段较重要代码后使用
"greeting-responder": 在回复老师问候时使用（带一点友好玩笑）
</example_agent_description>

<example>
user: "请写一个判断质数的函数"
assistant: 好的，我来写一个判断质数的函数。
assistant: 我先用 ${FileWriteTool.name} 工具写代码。
assistant: 我将用 ${FileWriteTool.name} 写入以下代码：
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
已经完成一段较重要代码，可以再调用 code-reviewer 做一次审查
</commentary>
assistant: 现在我用 Task 工具调用 code-reviewer 来审查这段代码。
</example>

<example>
user: "你好"
<commentary>
老师是在打招呼，可以调用 greeting-responder 用轻松一点的方式回复
</commentary>
assistant: "我将用 Task 工具调用 greeting-responder 来回复。"
</example>`
}
