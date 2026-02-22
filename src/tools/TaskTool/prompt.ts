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
  return `Launch a new agent to handle complex, multi-step tasks autonomously. 

Available agent types and the tools they have access to:
${agentDescriptions}

When using the Task tool, you must specify the agent type parameter subagent_type.
You may optionally pass team_name and name to route the task through process teammates when process mode is enabled.
Use wait_for_completion=false when you need true parallel orchestration (launch first, coordinate while running, then check with TaskStatus).
When team_name is used, teammates should coordinate via SendMessage and shared task board tools (TaskCreate/TaskList/TaskUpdate).

When to use the Agent tool:
- When you are instructed to execute custom slash commands. Use the Agent tool with the slash command invocation as the entire prompt. The slash command can take arguments. For example: Task(description="Check the file", prompt="/check-file path/to/file.py")

When NOT to use the Agent tool:
- If you want to read a specific file path, use the ${FileReadTool.name} or ${GlobTool.name} tool instead of the Agent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the ${GlobTool.name} tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FileReadTool.name} tool instead of the Agent tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. If you need the lead to keep coordinating while teammates run, use Task(wait_for_completion=false) for true parallel launch, then use TaskStatus / SendMessage / shared task tools during execution
3. If you already know all independent subtasks and just want a deterministic batch result, prefer TaskBatch
4. In one parallel orchestration turn, use exactly one TEAM and create multiple AGENTs inside it
5. After detached launch, keep task_id/team_name/agent_name and use TaskStatus to check or wait later
6. When the teammate is done, summarize key outcomes to the user in plain text.
7. Teammates run in TEAM process mode; they can coordinate during execution via SendMessage and shared Task board tools.
8. The agent's outputs should generally be trusted
9. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
10. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.

Example usage:

<example_agent_descriptions>
"code-reviewer": use this agent after you are done writing a signficant piece of code
"greeting-responder": use this agent when to respond to user greetings with a friendly joke
</example_agent_description>

<example>
user: "Please write a function that checks if a number is prime"
assistant: Sure let me write a function that checks if a number is prime
assistant: First let me use the ${FileWriteTool.name} tool to write a function that checks if a number is prime
assistant: I'm going to use the ${FileWriteTool.name} tool to write the following code:
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
Since a signficant piece of code was written and the task was completed, now use the code-reviewer agent to review the code
</commentary>
assistant: Now let me use the code-reviewer agent to review the code
assistant: Uses the Task tool to launch the with the code-reviewer agent 
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Task tool to launch the with the greeting-responder agent"
</example>`
}
