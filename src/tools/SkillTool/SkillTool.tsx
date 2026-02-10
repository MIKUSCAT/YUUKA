import { z } from 'zod'
import React from 'react'
import { Box, Text } from 'ink'
import { readdirSync } from 'fs'
import { Tool } from '@tool'
import { TOOL_NAME } from './constants'
import { getPrompt, DESCRIPTION } from './prompt'
import {
  getRuntimeSkillByName,
  getRuntimeAvailableSkillNames,
} from '@utils/skillLoader'
import type { SkillConfig } from '@utils/skillLoader'
import { getTheme } from '@utils/theme'
import { MessageResponse } from '@components/MessageResponse'

const inputSchema = z.object({
  skill: z.string().describe('The skill name. E.g., "pdf" or "xlsx"'),
  args: z
    .record(z.string())
    .optional()
    .describe('Optional skill template arguments'),
})

type SkillInput = z.infer<typeof inputSchema>

interface SkillResult {
  toolName: 'Skill'
  skillName: string
  instructions: string
  allowedTools?: string[]
  resolvedSkills?: string[]
  supportingFiles?: string[]
  error?: string
}

function applyTemplateArgs(
  text: string,
  args?: Record<string, string>,
): string {
  if (!args || Object.keys(args).length === 0) {
    return text
  }
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    const value = args[key]
    return typeof value === 'string' ? value : _match
  })
}

async function resolveSkillChain(root: SkillConfig): Promise<SkillConfig[]> {
  const ordered: SkillConfig[] = []
  const visited = new Set<string>()

  const visit = async (skill: SkillConfig): Promise<void> => {
    if (visited.has(skill.name)) return
    visited.add(skill.name)
    ordered.push(skill)
    if (!skill.chain || skill.chain.length === 0) {
      return
    }
    for (const chainedSkillName of skill.chain) {
      const chainedSkill = await getRuntimeSkillByName(chainedSkillName)
      if (!chainedSkill) continue
      await visit(chainedSkill)
    }
  }

  await visit(root)
  return ordered
}

function mergeAllowedTools(skills: SkillConfig[]): string[] | undefined {
  const toolNames = new Set<string>()
  let hasAnyRestriction = false
  for (const skill of skills) {
    if (!skill.allowedTools || skill.allowedTools.length === 0) {
      continue
    }
    hasAnyRestriction = true
    if (skill.allowedTools.includes('*')) {
      return ['*']
    }
    for (const toolName of skill.allowedTools) {
      const normalized = String(toolName).trim()
      if (normalized) {
        toolNames.add(normalized)
      }
    }
  }

  if (!hasAnyRestriction) return undefined
  return Array.from(toolNames)
}

export const SkillTool = {
  name: TOOL_NAME,
  userFacingName: () => 'Skill',
  description: async () => DESCRIPTION,
  inputSchema,

  isEnabled: async () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  needsPermissions: () => false,

  prompt: async () => getPrompt(),

  async *call(
    input: SkillInput,
    context
  ): AsyncGenerator<
    | { type: 'result'; data: SkillResult; resultForAssistant?: string }
    | { type: 'progress'; content: any },
    void,
    unknown
  > {
    const { skill: skillName, args } = input

    // Load the skill configuration
    const skill = await getRuntimeSkillByName(skillName)

    if (!skill) {
      const availableSkills = await getRuntimeAvailableSkillNames()
      const errorMessage = availableSkills.length > 0
        ? `Skill "${skillName}" not found.\n\nAvailable skills:\n${availableSkills.map(s => `  - ${s}`).join('\n')}`
        : `Skill "${skillName}" not found. No skills are currently configured.\n\nTo add skills, create directories with SKILL.md files under:\n  - ~/.yuuka/skills/\n\nAny subdirectory containing SKILL.md will be discovered (e.g., ~/.yuuka/skills/category/skill-name/SKILL.md).`

      yield {
        type: 'result',
        data: {
          toolName: 'Skill',
          skillName,
          instructions: '',
          error: errorMessage,
        },
        resultForAssistant: errorMessage,
      }
      return
    }

    // Get list of supporting files in the skill directory
    let supportingFiles: string[] = []
    try {
      supportingFiles = readdirSync(skill.dirPath).filter(
        file => file !== 'SKILL.md',
      )
    } catch {
      supportingFiles = []
    }

    const chainedSkills = await resolveSkillChain(skill)
    const mergedAllowedTools = mergeAllowedTools(chainedSkills)
    const renderedInstructions = chainedSkills
      .map((loadedSkill, index) => {
        const title =
          chainedSkills.length > 1
            ? `## Step ${index + 1}: ${loadedSkill.name}\n\n`
            : ''
        const content = applyTemplateArgs(loadedSkill.instructions, args)
        return `${title}${content}`.trim()
      })
      .join('\n\n')

    // Build the result with skill instructions
    const result: SkillResult = {
      toolName: 'Skill',
      skillName: skill.name,
      instructions: renderedInstructions,
      allowedTools: mergedAllowedTools,
      resolvedSkills: chainedSkills.map(loadedSkill => loadedSkill.name),
      supportingFiles: supportingFiles.length > 0 ? supportingFiles : undefined,
    }

    // Format the output for the assistant
    let resultForAssistant = `# Skill: ${skill.name}\n\n${renderedInstructions}`

    if (supportingFiles.length > 0) {
      resultForAssistant += `\n\n## Supporting Files\nThe following files are available in this skill's directory:\n${supportingFiles.map(f => `- ${f}`).join('\n')}`
    }

    if (mergedAllowedTools && mergedAllowedTools.length > 0) {
      resultForAssistant += `\n\n## Allowed Tools\nThis skill restricts tool usage to: ${mergedAllowedTools.join(', ')}`
    }

    yield {
      type: 'result',
      data: result,
      resultForAssistant,
    }
  },

  renderToolUseMessage(input: SkillInput, options: { verbose: boolean }): string {
    return `Invoking skill: ${input.skill}`
  },

  renderToolUseRejectedMessage() {
    return (
      <MessageResponse children={<Text color={getTheme().error}>Skill invocation cancelled</Text>} />
    )
  },

  renderToolResultMessage(output: SkillResult) {
    const theme = getTheme()

    if (output.error) {
      return (
        <MessageResponse children={
          <Box flexDirection="column">
            <Text color={theme.error}>Skill Error</Text>
            <Text>{output.error}</Text>
          </Box>
        } />
      )
    }

    return (
      <MessageResponse children={
        <Box flexDirection="column">
          <Text color={theme.success}>Skill loaded: {output.skillName}</Text>
          {output.supportingFiles && output.supportingFiles.length > 0 && (
            <Text dimColor>
              Supporting files: {output.supportingFiles.join(', ')}
            </Text>
          )}
        </Box>
      } />
    )
  },

  renderResultForAssistant(output: SkillResult): string {
    if (output.error) {
      return output.error
    }
    return `Skill "${output.skillName}" loaded successfully. Instructions have been provided.`
  },
} satisfies Tool<typeof inputSchema, SkillResult>
