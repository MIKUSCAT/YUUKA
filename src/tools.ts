import { Tool } from './Tool'
import { TaskTool } from './tools/TaskTool/TaskTool'
import { BashTool } from './tools/BashTool/BashTool'
import { TaskOutputTool } from './tools/TaskOutputTool/TaskOutputTool'
import { FileEditTool } from './tools/FileEditTool/FileEditTool'
import { FileReadTool } from './tools/FileReadTool/FileReadTool'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool'
import { GlobTool } from './tools/GlobTool/GlobTool'
import { GrepTool } from './tools/GrepTool/GrepTool'
import { LSTool } from './tools/lsTool/lsTool'
import { MemoryReadTool } from './tools/MemoryReadTool/MemoryReadTool'
import { MemoryWriteTool } from './tools/MemoryWriteTool/MemoryWriteTool'
import { MultiEditTool } from './tools/MultiEditTool/MultiEditTool'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool'
import { NotebookReadTool } from './tools/NotebookReadTool/NotebookReadTool'
import { ThinkTool } from './tools/ThinkTool/ThinkTool'
import { TodoReadTool } from './tools/TodoReadTool/TodoReadTool'
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool'
import { URLFetcherTool } from './tools/URLFetcherTool/URLFetcherTool'
import { SkillTool } from './tools/SkillTool/SkillTool'
import { DocWriteTool } from './tools/DocTool/DocWriteTool'
import { getMCPTools } from './services/mcpClient'
import { memoize } from 'lodash-es'

const ANT_ONLY_TOOLS = [MemoryReadTool as unknown as Tool, MemoryWriteTool as unknown as Tool]

// Function to avoid circular dependencies in the CLI loader
export const getAllTools = (): Tool[] => {
  return [
    TaskTool as unknown as Tool,
    BashTool as unknown as Tool,
    TaskOutputTool as unknown as Tool,
    GlobTool as unknown as Tool,
    GrepTool as unknown as Tool,
    LSTool as unknown as Tool,
    FileReadTool as unknown as Tool,
    FileEditTool as unknown as Tool,
    MultiEditTool as unknown as Tool,
    FileWriteTool as unknown as Tool,
    NotebookReadTool as unknown as Tool,
    NotebookEditTool as unknown as Tool,
    DocWriteTool as unknown as Tool,
    ThinkTool as unknown as Tool,
    TodoReadTool as unknown as Tool,
    TodoWriteTool as unknown as Tool,
    WebSearchTool as unknown as Tool,
    URLFetcherTool as unknown as Tool,
    SkillTool as unknown as Tool,
    ...ANT_ONLY_TOOLS,
  ]
}

async function primeToolDescriptions(tools: Tool[]): Promise<void> {
  // 预先缓存工具描述：适配器/权限弹窗等地方需要同步描述字符串
  await Promise.all(
    tools.map(async tool => {
      if (tool.cachedDescription) return
      try {
        if (typeof tool.description === 'function') {
          tool.cachedDescription = await tool.description()
          return
        }
        if (typeof tool.description === 'string') {
          tool.cachedDescription = tool.description
          return
        }
      } catch {
        // ignore and fall back
      }
      tool.cachedDescription = `Tool: ${tool.name}`
    }),
  )
}

export const getCoreTools = memoize(
  async (): Promise<Tool[]> => {
    const tools = getAllTools()

    const isEnabled = await Promise.all(tools.map(tool => tool.isEnabled()))
    const enabledTools = tools.filter((_, i) => isEnabled[i])

    await primeToolDescriptions(enabledTools)

    return enabledTools
  },
)

export const getTools = memoize(
  async (): Promise<Tool[]> => {
    const tools = [...(await getCoreTools()), ...(await getMCPTools())]
    await primeToolDescriptions(tools)
    return tools
  },
)

export const getReadOnlyTools = memoize(async (): Promise<Tool[]> => {
  const tools = getAllTools().filter(tool => tool.isReadOnly())
  const isEnabled = await Promise.all(tools.map(tool => tool.isEnabled()))
  const enabledTools = tools.filter((_, index) => isEnabled[index])
  await primeToolDescriptions(enabledTools)

  return enabledTools
})
