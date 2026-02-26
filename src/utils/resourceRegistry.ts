import {
  existsSync,
  readFileSync,
  statSync,
} from 'fs'
import { basename, join, resolve } from 'path'
import { getOriginalCwd } from './state'
import { getActiveSkills } from './skillLoader'

export type RuntimeResourceKind = 'instruction' | 'skill'

export interface RuntimeResource {
  id: string
  kind: RuntimeResourceKind
  name: string
  location: 'project' | 'user'
  path?: string
  content?: string
  metadata?: Record<string, unknown>
}

type InstructionResourceCache = {
  key: string
  items: RuntimeResource[]
}

let instructionCache: InstructionResourceCache | null = null

const INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules']
const MAX_INSTRUCTION_FILE_BYTES = 16 * 1024
const MAX_TOTAL_INSTRUCTION_BYTES = 32 * 1024

function safeReadTextFile(path: string, maxBytes: number): string | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    if (raw.length <= maxBytes) return raw
    return `${raw.slice(0, maxBytes)}\n\n[...内容已截断，原文更长...]`
  } catch {
    return null
  }
}

function buildInstructionCacheKey(paths: string[]): string {
  const parts: string[] = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const stat = statSync(path)
      parts.push(`${path}:${stat.mtimeMs}:${stat.size}`)
    } catch {
      parts.push(`${path}:err`)
    }
  }
  return parts.join('|')
}

export function getProjectInstructionResources(): RuntimeResource[] {
  const cwd = resolve(getOriginalCwd())
  const candidates = INSTRUCTION_FILENAMES.map(name => join(cwd, name))
  const cacheKey = buildInstructionCacheKey(candidates)
  if (instructionCache && instructionCache.key === cacheKey) {
    return instructionCache.items
  }

  const items: RuntimeResource[] = []
  let totalBytes = 0

  for (const path of candidates) {
    if (!existsSync(path)) continue
    const remaining = MAX_TOTAL_INSTRUCTION_BYTES - totalBytes
    if (remaining <= 0) break
    const content = safeReadTextFile(path, Math.min(MAX_INSTRUCTION_FILE_BYTES, remaining))
    if (!content) continue
    totalBytes += content.length
    items.push({
      id: `instruction:${basename(path)}`,
      kind: 'instruction',
      name: basename(path),
      location: 'project',
      path,
      content,
      metadata: {
        source: 'workspace-root',
      },
    })
  }

  instructionCache = { key: cacheKey, items }
  return items
}

export function buildInstructionResourcesPromptHeader(): string | null {
  const resources = getProjectInstructionResources()
  if (resources.length === 0) return null

  const lines: string[] = []
  lines.push('# Workspace Rules (Auto-loaded Resources)')
  lines.push(
    '遵循以下工作区说明文件（如果存在）。这些内容来自当前工作目录根目录的资源文件。',
  )

  for (const resource of resources) {
    if (!resource.content) continue
    lines.push(`\n## ${resource.name}`)
    if (resource.path) {
      lines.push(`Path: ${resource.path}`)
    }
    lines.push('```md')
    lines.push(resource.content.trim())
    lines.push('```')
  }

  return lines.join('\n')
}

export async function listRuntimeResources(): Promise<RuntimeResource[]> {
  const resources: RuntimeResource[] = [...getProjectInstructionResources()]

  try {
    const skills = await getActiveSkills()
    for (const skill of skills) {
      resources.push({
        id: `skill:${skill.name}`,
        kind: 'skill',
        name: skill.name,
        location: skill.location,
        path: skill.dirPath,
        metadata: {
          description: skill.description,
          allowedTools: skill.allowedTools ?? null,
          chain: skill.chain ?? null,
        },
      })
    }
  } catch {
    // Ignore resource catalog failures; runtime should continue.
  }

  return resources
}

export function clearResourceRegistryCache(): void {
  instructionCache = null
}
