/**
 * Agent configuration loader
 * Loads agent configurations from markdown files with YAML frontmatter.
 * Uses global `~/.yuuka/agents` directory.
 */

import { existsSync, readFileSync, readdirSync, statSync, watch, FSWatcher } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import matter from 'gray-matter'
import { memoize } from 'lodash-es'
import { emitReloadStatus } from './reloadStatus'

export interface AgentConfig {
  agentType: string          // Agent identifier (matches subagent_type)
  whenToUse: string          // Description of when to use this agent  
  tools: string[] | '*'      // Tool permissions
  systemPrompt: string       // System prompt content
  location: 'built-in' | 'user'
  color?: string            // Optional UI color
  model_name?: string       // Optional model override
}

// Built-in general-purpose agent as fallback
const BUILTIN_GENERAL_PURPOSE: AgentConfig = {
  agentType: 'general-purpose',
  whenToUse: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks',
  tools: '*',
  systemPrompt: `You are a general-purpose agent. Given the user's task, use the tools available to complete it efficiently and thoroughly.

When to use your capabilities:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture  
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: Use Grep or Glob when you need to search broadly. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- Complete tasks directly using your capabilities.`,
  location: 'built-in'
}

/**
 * Parse tools field from frontmatter
 */
function parseTools(tools: any): string[] | '*' {
  if (!tools) return '*'
  if (tools === '*') return '*'
  if (Array.isArray(tools)) {
    // Ensure all items are strings and filter out non-strings
    const filteredTools = tools.filter((t): t is string => typeof t === 'string')
    return filteredTools.length > 0 ? filteredTools : '*'
  }
  if (typeof tools === 'string') {
    return [tools]
  }
  return '*'
}

/**
 * Scan a directory for agent configuration files
 */
async function scanAgentDirectory(dirPath: string, location: 'user'): Promise<AgentConfig[]> {
  if (!existsSync(dirPath)) {
    return []
  }

  const agents: AgentConfig[] = []
  
  try {
    const files = readdirSync(dirPath)
    
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      
      const filePath = join(dirPath, file)
      const stat = statSync(filePath)
      
      if (!stat.isFile()) continue
      
      try {
        const content = readFileSync(filePath, 'utf-8')
        const { data: frontmatter, content: body } = matter(content)
        
        // Validate required fields
        if (!frontmatter.name || !frontmatter.description) {
          console.warn(`Skipping ${filePath}: missing required fields (name, description)`)
          continue
        }
        
        // Silently ignore deprecated 'model' field.
        
        // Build agent config
        const agent: AgentConfig = {
          agentType: frontmatter.name,
          whenToUse: frontmatter.description.replace(/\\n/g, '\n'),
          tools: parseTools(frontmatter.tools),
          systemPrompt: body.trim(),
          location,
          ...(frontmatter.color && { color: frontmatter.color }),
          // Only use model_name field, ignore deprecated 'model' field
          ...(frontmatter.model_name && { model_name: frontmatter.model_name })
        }
        
        agents.push(agent)
      } catch (error) {
        console.warn(`Failed to parse agent file ${filePath}:`, error)
      }
    }
  } catch (error) {
    console.warn(`Failed to scan directory ${dirPath}:`, error)
  }
  
  return agents
}

/**
 * Load all agent configurations
 */
async function loadAllAgents(): Promise<{
  activeAgents: AgentConfig[]
  allAgents: AgentConfig[]
}> {
  try {
    // 全局模式：只读取 ~/.yuuka/agents，并保留内置 agents
    const userGeminiDir = join(homedir(), '.yuuka', 'agents')
    const userGeminiAgents = await scanAgentDirectory(userGeminiDir, 'user')
    
    // Built-in agents (currently just general-purpose)
    const builtinAgents = [BUILTIN_GENERAL_PURPOSE]
    
    // Apply priority override: built-in < .yuuka (user)
    const agentMap = new Map<string, AgentConfig>()
    
    // Add in priority order (later entries override earlier ones)
    for (const agent of builtinAgents) {
      agentMap.set(agent.agentType, agent)
    }
    for (const agent of userGeminiAgents) {
      agentMap.set(agent.agentType, agent)
    }
    
    const activeAgents = Array.from(agentMap.values())
    const allAgents = [
      ...builtinAgents,
      ...userGeminiAgents,
    ]
    
    return { activeAgents, allAgents }
  } catch (error) {
    console.error('Failed to load agents, falling back to built-in:', error)
    return {
      activeAgents: [BUILTIN_GENERAL_PURPOSE],
      allAgents: [BUILTIN_GENERAL_PURPOSE]
    }
  }
}

// Memoized version for performance
export const getActiveAgents = memoize(
  async (): Promise<AgentConfig[]> => {
    const { activeAgents } = await loadAllAgents()
    return activeAgents
  }
)

// Get all agents (both active and overridden)
export const getAllAgents = memoize(
  async (): Promise<AgentConfig[]> => {
    const { allAgents } = await loadAllAgents()
    return allAgents
  }
)

// Clear cache when needed
export function clearAgentCache() {
  getActiveAgents.cache?.clear?.()
  getAllAgents.cache?.clear?.()
  getAgentByType.cache?.clear?.()
  getAvailableAgentTypes.cache?.clear?.()
}

// Get a specific agent by type
export const getAgentByType = memoize(
  async (agentType: string): Promise<AgentConfig | undefined> => {
    const agents = await getActiveAgents()
    return agents.find(agent => agent.agentType === agentType)
  }
)

// Get all available agent types for validation
export const getAvailableAgentTypes = memoize(
  async (): Promise<string[]> => {
    const agents = await getActiveAgents()
    return agents.map(agent => agent.agentType)
  }
)

// File watcher for hot reload
let watchers: FSWatcher[] = []

/**
 * Start watching agent configuration directories for changes
 */
export async function startAgentWatcher(onChange?: () => void): Promise<void> {
  await stopAgentWatcher() // Clean up any existing watchers
  
  // 全局模式：只 watch ~/.yuuka/agents
  const userGeminiDir = join(homedir(), '.yuuka', 'agents')
  
  const watchDirectory = (dirPath: string) => {
    if (existsSync(dirPath)) {
      const watcher = watch(dirPath, { recursive: false }, async (eventType, filename) => {
        if (filename && filename.endsWith('.md')) {
          emitReloadStatus({ domain: 'agents', state: 'loading' })
          clearAgentCache()
          // Also clear any other related caches
          getAllAgents.cache?.clear?.()
          onChange?.()
          emitReloadStatus({ domain: 'agents', state: 'ok' })
        }
      })
      watchers.push(watcher)
    }
  }
  
  watchDirectory(userGeminiDir)
}

/**
 * Stop watching agent configuration directories
 */
export async function stopAgentWatcher(): Promise<void> {
  // FSWatcher.close() is synchronous and does not accept a callback on Node 18/20
  try {
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch (err) {
        console.error('Failed to close file watcher:', err)
      }
    }
  } finally {
    watchers = []
  }
}
