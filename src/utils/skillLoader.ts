/**
 * Skill configuration loader
 * Loads skill configurations from SKILL.md files with YAML frontmatter.
 * Uses `.yuuka/skills` directory structure.
 *
 * Skills are directory-based: each skill is a folder containing SKILL.md
 * Example: ~/.yuuka/skills/pdf/SKILL.md
 */

import { existsSync, readFileSync, readdirSync, statSync, watch, FSWatcher } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import matter from 'gray-matter'
import { memoize } from 'lodash-es'
import { emitReloadStatus } from './reloadStatus'
import { getSessionEnabledSkillNames } from './skillSession'

export interface SkillConfig {
  name: string              // Skill identifier (from frontmatter or directory name)
  description: string       // When to use this skill (for model discovery)
  instructions: string      // Skill instructions (markdown body)
  allowedTools?: string[]   // Optional: restrict available tools
  chain?: string[]          // Optional: compose multiple skills
  location: 'user' | 'project'
  dirPath: string          // Full path to skill directory
}

function isValidSkillName(name: string): boolean {
  // Open Standard: 1-64 chars, lower-case letters/numbers/hyphens,
  // no leading/trailing hyphen, no consecutive hyphens.
  if (!name) return false
  if (name.length < 1 || name.length > 64) return false
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

/**
 * Parse allowed-tools field from frontmatter
 */
function parseAllowedTools(tools: any): string[] | undefined {
  if (!tools) return undefined
  if (Array.isArray(tools)) {
    const filtered = tools.filter((t): t is string => typeof t === 'string')
    return filtered.length > 0 ? filtered : undefined
  }
  if (typeof tools === 'string') {
    // Support comma-separated string: "Read, Grep, Glob"
    return tools.split(',').map(t => t.trim()).filter(Boolean)
  }
  return undefined
}

function parseSkillChain(chain: any): string[] | undefined {
  if (!chain) return undefined
  if (Array.isArray(chain)) {
    const filtered = chain
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
    return filtered.length > 0 ? filtered : undefined
  }
  if (typeof chain === 'string') {
    const normalized = chain
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
    return normalized.length > 0 ? normalized : undefined
  }
  return undefined
}

function findSkillDirectories(basePath: string): string[] {
  if (!existsSync(basePath)) return []

  const result: string[] = []
  const queue: string[] = [basePath]

  while (queue.length > 0) {
    const dirPath = queue.shift()!

    let entries: string[]
    try {
      entries = readdirSync(dirPath)
    } catch {
      continue
    }

    const hasSkillFile = entries.includes('SKILL.md')
    if (hasSkillFile) {
      result.push(dirPath)
      // A skill directory is a leaf in the standard; don't recurse into it.
      continue
    }

    for (const entry of entries) {
      const childPath = join(dirPath, entry)
      let stat
      try {
        stat = statSync(childPath)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      queue.push(childPath)
    }
  }

  // Ensure stable ordering (filesystem order can vary)
  return result.sort()
}

/**
 * Scan a directory for skill configurations
 * Skills are directories containing SKILL.md
 */
async function scanSkillDirectory(basePath: string, location: 'user' | 'project'): Promise<SkillConfig[]> {
  if (!existsSync(basePath)) {
    return []
  }

  const skills: SkillConfig[] = []

  try {
    const skillDirs = findSkillDirectories(basePath)

    for (const skillDirPath of skillDirs) {
      const dirName = basename(skillDirPath)
      const skillFilePath = join(skillDirPath, 'SKILL.md')
      try {
        const content = readFileSync(skillFilePath, 'utf-8')
        const { data: frontmatter, content: body } = matter(content)

        const rawFrontmatterName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
        const skillName = rawFrontmatterName || dirName

        // Open Standard validation (with minimal legacy fallback):
        // - If frontmatter.name is present, it must match the directory name
        // - If frontmatter.name is missing, fall back to directory name (but require it to be valid)
        if (!rawFrontmatterName) {
          if (!isValidSkillName(dirName)) {
            console.warn(
              `Skipping skill ${skillFilePath}: missing 'name' and directory name "${dirName}" is not a valid skill name`
            )
            continue
          }
          console.warn(
            `Skill ${skillFilePath}: missing 'name' field; using directory name "${dirName}" (please add frontmatter.name to be Open Standard compliant)`
          )
        } else {
          if (rawFrontmatterName !== dirName) {
            console.warn(
              `Skipping skill ${skillFilePath}: 'name' (${rawFrontmatterName}) must match directory name (${dirName})`
            )
            continue
          }
          if (!isValidSkillName(rawFrontmatterName)) {
            console.warn(
              `Skipping skill ${skillFilePath}: invalid skill name "${rawFrontmatterName}" (must be kebab-case, 1-64 chars)`
            )
            continue
          }
        }

        // Validate required description field
        if (!frontmatter.description || typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
          console.warn(`Skipping skill ${skillFilePath}: missing required 'description' field`)
          continue
        }

        const skill: SkillConfig = {
          name: skillName,
          description: frontmatter.description,
          instructions: body.trim(),
          allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
          chain: parseSkillChain(frontmatter['chain']),
          location,
          dirPath: skillDirPath,
        }

        skills.push(skill)
      } catch (error) {
        console.warn(`Failed to parse skill file ${skillFilePath}:`, error)
      }
    }
  } catch (error) {
    console.warn(`Failed to scan skills directory ${basePath}:`, error)
  }

  return skills
}

/**
 * Load all skill configurations from all directories
 */
async function loadAllSkills(): Promise<{
  activeSkills: SkillConfig[]
  allSkills: SkillConfig[]
}> {
  try {
    // 全局模式：只读取 ~/.yuuka/skills
    const userGeminiDir = join(homedir(), '.yuuka', 'skills')

    const userGeminiSkills = await scanSkillDirectory(userGeminiDir, 'user')
    const activeSkills = [...userGeminiSkills]
    const allSkills = [...userGeminiSkills]

    return { activeSkills, allSkills }
  } catch (error) {
    console.error('Failed to load skills:', error)
    return {
      activeSkills: [],
      allSkills: []
    }
  }
}

// Memoized version for performance
export const getActiveSkills = memoize(
  async (): Promise<SkillConfig[]> => {
    const { activeSkills } = await loadAllSkills()
    return activeSkills
  }
)

// Get all skills (both active and overridden)
export const getAllSkills = memoize(
  async (): Promise<SkillConfig[]> => {
    const { allSkills } = await loadAllSkills()
    return allSkills
  }
)

function filterSkillsBySessionSelection(skills: SkillConfig[]): SkillConfig[] {
  const selectedNames = getSessionEnabledSkillNames()
  if (!selectedNames) {
    return skills
  }
  if (selectedNames.length === 0) {
    return []
  }
  const selectedSet = new Set(selectedNames)
  return skills.filter(skill => selectedSet.has(skill.name))
}

export async function getRuntimeActiveSkills(): Promise<SkillConfig[]> {
  const skills = await getActiveSkills()
  return filterSkillsBySessionSelection(skills)
}

export async function getRuntimeAvailableSkillNames(): Promise<string[]> {
  const skills = await getRuntimeActiveSkills()
  return skills.map(skill => skill.name)
}

export async function getRuntimeSkillByName(
  skillName: string,
): Promise<SkillConfig | undefined> {
  const normalized = String(skillName ?? '').trim()
  if (!normalized) return undefined
  const skills = await getRuntimeActiveSkills()
  return skills.find(skill => skill.name === normalized)
}

// Clear cache when needed
export function clearSkillCache() {
  getActiveSkills.cache?.clear?.()
  getAllSkills.cache?.clear?.()
  getSkillByName.cache?.clear?.()
  getAvailableSkillNames.cache?.clear?.()
}

// Get a specific skill by name
export const getSkillByName = memoize(
  async (skillName: string): Promise<SkillConfig | undefined> => {
    const skills = await getActiveSkills()
    return skills.find(skill => skill.name === skillName)
  }
)

// Get all available skill names for validation
export const getAvailableSkillNames = memoize(
  async (): Promise<string[]> => {
    const skills = await getActiveSkills()
    return skills.map(skill => skill.name)
  }
)

// Read a supporting file from a skill directory
export async function readSkillFile(skillName: string, filename: string): Promise<string | null> {
  const skill = await getSkillByName(skillName)
  if (!skill) return null

  const filePath = join(skill.dirPath, filename)
  if (!existsSync(filePath)) return null

  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

// List files in a skill directory
export async function listSkillFiles(skillName: string): Promise<string[]> {
  const skill = await getSkillByName(skillName)
  if (!skill) return []

  try {
    return readdirSync(skill.dirPath).filter(f => f !== 'SKILL.md')
  } catch {
    return []
  }
}

// File watcher for hot reload
let watchers: FSWatcher[] = []

/**
 * Start watching skill directories for changes
 */
export async function startSkillWatcher(onChange?: () => void): Promise<void> {
  await stopSkillWatcher() // Clean up any existing watchers

  const userGeminiDir = join(homedir(), '.yuuka', 'skills')

  const watchDirectory = (dirPath: string) => {
    if (existsSync(dirPath)) {
      // Watch with recursive to catch SKILL.md changes in subdirectories
      const watcher = watch(dirPath, { recursive: true }, async (eventType, filename) => {
        if (filename && (filename.endsWith('SKILL.md') || filename === 'SKILL.md')) {
          emitReloadStatus({ domain: 'skills', state: 'loading' })
          clearSkillCache()
          onChange?.()
          emitReloadStatus({ domain: 'skills', state: 'ok' })
        }
      })
      watchers.push(watcher)
    }
  }

  watchDirectory(userGeminiDir)
}

/**
 * Stop watching skill directories
 */
export async function stopSkillWatcher(): Promise<void> {
  try {
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch (err) {
        console.error('Failed to close skill watcher:', err)
      }
    }
  } finally {
    watchers = []
  }
}
