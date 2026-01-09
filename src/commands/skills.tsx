import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import InkTextInput from 'ink-text-input'
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { getCwd } from '@utils/state'
import { getTheme } from '@utils/theme'
import {
  getActiveSkills,
  getAllSkills,
  clearSkillCache,
  SkillConfig,
} from '@utils/skillLoader'
import { getMessagesGetter } from '@messages'
import { queryQuick, queryModel } from '@services/claude'
import type { Message } from '@query'
import { extractTag } from '@utils/messages'
import { randomUUID } from 'crypto'

// UI Constants
const UI_ICONS = {
  pointer: '❯',
  checkboxOn: '☑',
  checkboxOff: '☐',
  warning: '⚠',
  separator: '─',
  loading: '◐◑◒◓',
} as const

type SkillLocation = 'user' | 'project'

// Mode state for navigation
type ModeState = {
  mode:
    | 'list-skills'
    | 'create-location'
    | 'create-name'
    | 'create-description'
    | 'create-instructions'
    | 'create-confirm'
    | 'skill-menu'
    | 'view-skill'
    | 'edit-skill'
    | 'delete-confirm'
    | 'learn-name'
    | 'learn-confirm'
  location?: SkillLocation
  selectedSkill?: SkillConfig
  learnedContent?: LearnedContent
}

// State for skill creation
type CreateState = {
  location: SkillLocation | null
  skillName: string
  description: string
  instructions: string
  error: string | null
}

// Learned content from conversation
type LearnedContent = {
  name: string
  description: string
  instructions: string
}

// Header component
interface HeaderProps {
  title: string
  subtitle?: string
  step?: number
  totalSteps?: number
  children?: React.ReactNode
}

function Header({ title, subtitle, step, totalSteps, children }: HeaderProps) {
  const theme = getTheme()
  return (
    <Box flexDirection="column">
      <Text bold color={theme.primary}>
        {title}
      </Text>
      {subtitle && (
        <Text color={theme.secondary}>
          {step && totalSteps ? `Step ${step}/${totalSteps}: ` : ''}
          {subtitle}
        </Text>
      )}
      {children}
    </Box>
  )
}

// Instruction bar component
interface InstructionBarProps {
  instructions?: string
}

function InstructionBar({
  instructions = 'Press ↑↓ to navigate · Enter to select · Esc to go back',
}: InstructionBarProps) {
  const theme = getTheme()
  return (
    <Box marginTop={2}>
      <Box borderStyle="round" borderColor={theme.secondary} paddingX={1}>
        <Text color={theme.secondary}>{instructions}</Text>
      </Box>
    </Box>
  )
}

// Loading spinner
function LoadingSpinner({ text }: { text?: string }) {
  const theme = getTheme()
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame(prev => (prev + 1) % UI_ICONS.loading.length)
    }, 100)
    return () => clearInterval(interval)
  }, [])

  return (
    <Box>
      <Text color={theme.primary}>{UI_ICONS.loading[frame]}</Text>
      {text && <Text color={theme.secondary}> {text}</Text>}
    </Box>
  )
}

// File system helpers
function normalizeSkillName(input: string): string {
  let name = input.trim().toLowerCase()
  name = name.replace(/[\s_]+/g, '-')
  name = name.replace(/[^a-z0-9-]/g, '-')
  name = name.replace(/-+/g, '-')
  name = name.replace(/^-+/, '').replace(/-+$/, '')
  if (name.length > 64) {
    name = name.slice(0, 64).replace(/-+$/, '')
  }
  return name
}

function isValidSkillName(name: string): boolean {
  // Open Standard: 1-64 chars, lower-case letters/numbers/hyphens,
  // no leading/trailing hyphen, no consecutive hyphens.
  if (!name) return false
  if (name.length < 1 || name.length > 64) return false
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

function normalizeSkillDescription(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function validateSkillName(name: string): string | null {
  if (!name) return 'Skill name is required'
  if (!isValidSkillName(name)) {
    return 'Name must be kebab-case (lowercase letters/numbers, hyphens), 1-64 chars, no leading/trailing hyphen'
  }
  return null
}

function validateSkillDescription(description: string): string | null {
  if (!description) return 'Description is required'
  if (description.length > 1024) return 'Description is too long (max 1024 chars)'
  return null
}

function getSkillDirectory(location: SkillLocation): string {
  if (location === 'user') {
    return join(homedir(), '.gemini', 'skills')
  } else {
    return join(getCwd(), '.gemini', 'skills')
  }
}

function ensureSkillDirectoryExists(
  location: SkillLocation,
  skillName: string,
  options?: { allowExisting?: boolean }
): string {
  const baseDir = getSkillDirectory(location)
  const skillDir = join(baseDir, skillName)
  const allowExisting = options?.allowExisting ?? true

  if (existsSync(skillDir)) {
    if (!allowExisting) {
      throw new Error(`Skill "${skillName}" already exists`)
    }
    return skillDir
  }
  mkdirSync(skillDir, { recursive: true })
  return skillDir
}

function generateSkillFileContent(
  skillName: string,
  description: string,
  instructions: string
): string {
  return `---
name: ${skillName}
description: "${description.replace(/"/g, '\\"')}"
---

${instructions}
`
}

async function saveSkill(
  location: SkillLocation,
  skillName: string,
  description: string,
  instructions: string
): Promise<void> {
  const normalizedName = normalizeSkillName(skillName)
  const nameError = validateSkillName(normalizedName)
  if (nameError) throw new Error(nameError)

  const normalizedDescription = normalizeSkillDescription(description)
  const descError = validateSkillDescription(normalizedDescription)
  if (descError) throw new Error(descError)

  const normalizedInstructions = instructions.trim()
  if (!normalizedInstructions) {
    throw new Error('Instructions are required')
  }

  const skillDir = ensureSkillDirectoryExists(location, normalizedName, { allowExisting: false })
  const filePath = join(skillDir, 'SKILL.md')
  const content = generateSkillFileContent(normalizedName, normalizedDescription, normalizedInstructions)
  writeFileSync(filePath, content, 'utf-8')
  clearSkillCache()
}

async function deleteSkill(skill: SkillConfig): Promise<void> {
  rmSync(skill.dirPath, { recursive: true, force: true })
  clearSkillCache()
}

// Build transcript from messages for learning
function messageToTranscriptLine(msg: Message): string | null {
  if (msg.type === 'progress') return null

  if (msg.type === 'user') {
    const content = msg.message.content
    if (typeof content === 'string') {
      if (content.includes('<command-name>') || content.includes('<command-message>')) {
        const cmd = extractTag(content, 'command-message') || extractTag(content, 'command-name')
        const args = extractTag(content, 'command-args') || ''
        return cmd ? `用户：执行命令 /${cmd}${args ? ` ${args}` : ''}` : null
      }
      if (content.includes('<bash-input>')) {
        const bash = extractTag(content, 'bash-input')
        return bash ? `用户（bash）：${bash}` : null
      }
      const text = content.trim()
      return text ? `用户：${text}` : null
    }
    if (Array.isArray(content)) {
      const textParts = content
        .filter(p => (p as any)?.type === 'text')
        .map(p => String((p as any).text ?? '').trim())
        .filter(Boolean)
      const text = textParts.join('\n')
      return text ? `用户：${text}` : null
    }
  }

  if (msg.type === 'assistant') {
    const blocks = msg.message.content
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim()
    return text ? `助手：${text}` : null
  }

  return null
}

function buildTranscript(messages: Message[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const line = messageToTranscriptLine(m)
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

// Learn from conversation using AI
async function learnFromConversation(
  messages: Message[],
  suggestedName: string | null,
  signal: AbortSignal
): Promise<LearnedContent> {
  const transcript = buildTranscript(messages.slice(-80))

  if (!transcript.trim()) {
    throw new Error('没有可学习的对话内容')
  }

  const systemPrompt = `你是一个"技能提取助手"。你要从对话中提取出可复用的工作模式，并生成一个技能配置。

技能是AI助手可以在未来类似场景中复用的工作方法/流程/规则。

返回JSON格式：
{
  "name": "技能标识符（kebab-case，如 api-calling, code-review）",
  "description": "什么时候使用这个技能（1句话）",
  "instructions": "详细的技能指令（Markdown格式，包含具体步骤、注意事项、示例等）"
}

要求：
1. 提取对话中用户教导的工作方法、偏好、规则
2. 指令要具体可执行，不要太泛化
3. 如果对话中没有明显的可复用模式，返回一个通用的总结
4. 只输出JSON，不要解释`

  const userPrompt = suggestedName
    ? `请从以下对话中提取名为"${suggestedName}"的技能配置：\n\n${transcript}`
    : `请从以下对话中提取可复用的技能配置：\n\n${transcript}`

  const result = await queryModel(
    'main',
    [
      {
        type: 'user',
        uuid: randomUUID(),
        message: { role: 'user', content: userPrompt },
      },
    ] as any,
    [systemPrompt]
  )

  let responseText = ''
  if (typeof result.message?.content === 'string') {
    responseText = result.message.content
  } else if (Array.isArray(result.message?.content)) {
    const textContent = result.message.content.find((c: any) => c.type === 'text')
    responseText = textContent?.text || ''
  }

  if (!responseText) {
    throw new Error('AI未返回有效内容')
  }

  // Parse JSON from response
  let parsed: any
  try {
    const startIdx = responseText.indexOf('{')
    const endIdx = responseText.lastIndexOf('}')
    if (startIdx === -1 || endIdx === -1) {
      throw new Error('No JSON found')
    }
    parsed = JSON.parse(responseText.substring(startIdx, endIdx + 1))
  } catch {
    throw new Error('无法解析AI返回的JSON')
  }

  return {
    name: (() => {
      const raw = String(parsed.name || suggestedName || 'learned-skill')
      const normalized = normalizeSkillName(raw)
      if (isValidSkillName(normalized)) return normalized
      return `learned-skill-${randomUUID().slice(0, 8)}`
    })(),
    description: (() => {
      const raw = String(parsed.description || '从对话中学习的技能')
      const normalized = normalizeSkillDescription(raw)
      return normalized.slice(0, 1024)
    })(),
    instructions: String(parsed.instructions || transcript).slice(0, 10000),
  }
}

// Main Skills UI
interface SkillsUIProps {
  onExit: (message?: string) => void
  initialArgs?: string
  context: any
}

function SkillsUI({ onExit, initialArgs, context }: SkillsUIProps) {
  const theme = getTheme()

  const [modeState, setModeState] = useState<ModeState>(() => {
    // Parse initial args to determine starting mode
    if (initialArgs) {
      const parts = initialArgs.trim().split(/\s+/)
      const subcommand = parts[0]?.toLowerCase()
      const arg = parts.slice(1).join(' ')

      if (subcommand === 'learn') {
        return { mode: 'learn-name', location: undefined }
      }
      if (subcommand === 'create') {
        return { mode: 'create-location' }
      }
    }
    return { mode: 'list-skills' }
  })

  const [skills, setSkills] = useState<SkillConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [changes, setChanges] = useState<string[]>([])

  const [createState, setCreateState] = useState<CreateState>({
    location: null,
    skillName: '',
    description: '',
    instructions: '',
    error: null,
  })

  const [learnName, setLearnName] = useState('')
  const [isLearning, setIsLearning] = useState(false)

  // Load skills
  const loadSkills = useCallback(async () => {
    setLoading(true)
    clearSkillCache()
    try {
      const allSkills = await getAllSkills()
      setSkills(allSkills)
    } catch (error) {
      console.error('Failed to load skills:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  // Global ESC handling
  useInput((input, key) => {
    if (!key.escape) return

    const current = modeState.mode
    if (current === 'list-skills') {
      // 只有在确实有变更时才显示摘要，否则静默退出
      const summary = changes.length > 0 ? `Skills changes:\n${changes.join('\n')}` : undefined
      onExit(summary)
      return
    }

    // Navigate back
    switch (current) {
      case 'create-location':
      case 'learn-name':
        setModeState({ mode: 'list-skills' })
        break
      case 'create-name':
        setModeState({ mode: 'create-location' })
        break
      case 'create-description':
        setModeState({ mode: 'create-name', location: modeState.location })
        break
      case 'create-instructions':
        setModeState({ mode: 'create-description', location: modeState.location })
        break
      case 'create-confirm':
        setModeState({ mode: 'create-instructions', location: modeState.location })
        break
      case 'skill-menu':
      case 'learn-confirm':
        setModeState({ mode: 'list-skills' })
        break
      case 'view-skill':
      case 'edit-skill':
      case 'delete-confirm':
        setModeState({ mode: 'skill-menu', selectedSkill: modeState.selectedSkill })
        break
      default:
        setModeState({ mode: 'list-skills' })
    }
  })

  const handleSkillCreated = useCallback((message: string) => {
    setChanges(prev => [...prev, message])
    loadSkills()
    setModeState({ mode: 'list-skills' })
  }, [loadSkills])

  const handleSkillDeleted = useCallback((message: string) => {
    setChanges(prev => [...prev, message])
    loadSkills()
    setModeState({ mode: 'list-skills' })
  }, [loadSkills])

  if (loading) {
    return (
      <Box flexDirection="column">
        <Header title="📚 Skills">
          <Box marginTop={1}>
            <LoadingSpinner text="Loading skills..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }

  // Render based on mode
  switch (modeState.mode) {
    case 'list-skills':
      return (
        <SkillListView
          skills={skills}
          onBack={() => onExit()}
          onSelect={skill => setModeState({ mode: 'skill-menu', selectedSkill: skill })}
          onCreateNew={() => setModeState({ mode: 'create-location' })}
          onLearn={() => setModeState({ mode: 'learn-name' })}
          changes={changes}
        />
      )

    case 'create-location':
      return (
        <LocationSelect
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
        />
      )

    case 'create-name':
      return (
        <NameStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
          existingSkills={skills}
        />
      )

    case 'create-description':
      return (
        <DescriptionStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
        />
      )

    case 'create-instructions':
      return (
        <InstructionsStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
        />
      )

    case 'create-confirm':
      return (
        <ConfirmStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
          onSkillCreated={handleSkillCreated}
        />
      )

    case 'skill-menu':
      return (
        <SkillMenu
          skill={modeState.selectedSkill!}
          setModeState={setModeState}
        />
      )

    case 'view-skill':
      return (
        <ViewSkill
          skill={modeState.selectedSkill!}
          setModeState={setModeState}
        />
      )

    case 'delete-confirm':
      return (
        <DeleteConfirm
          skill={modeState.selectedSkill!}
          setModeState={setModeState}
          onSkillDeleted={handleSkillDeleted}
        />
      )

    case 'learn-name':
      return (
        <LearnNameStep
          learnName={learnName}
          setLearnName={setLearnName}
          isLearning={isLearning}
          setIsLearning={setIsLearning}
          setModeState={setModeState}
          context={context}
        />
      )

    case 'learn-confirm':
      return (
        <LearnConfirmStep
          learnedContent={modeState.learnedContent!}
          setModeState={setModeState}
          onSkillCreated={handleSkillCreated}
        />
      )

    default:
      return (
        <Box flexDirection="column">
          <Header title="📚 Skills">
            <Text>Mode: {modeState.mode} (Not implemented)</Text>
          </Header>
          <InstructionBar />
        </Box>
      )
  }
}

// Skill List View
interface SkillListViewProps {
  skills: SkillConfig[]
  onBack: () => void
  onSelect: (skill: SkillConfig) => void
  onCreateNew: () => void
  onLearn: () => void
  changes: string[]
}

function SkillListView({ skills, onBack, onSelect, onCreateNew, onLearn, changes }: SkillListViewProps) {
  const theme = getTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)

  const userSkills = skills.filter(s => s.location === 'user')
  const projectSkills = skills.filter(s => s.location === 'project')

  // Options: Learn, Create, then skills
  const options = [
    { type: 'learn' as const, label: '🧠 Learn from conversation', skill: null },
    { type: 'create' as const, label: '✨ Create new skill', skill: null },
    ...skills.map(s => ({ type: 'skill' as const, label: s.name, skill: s })),
  ]

  useInput((input, key) => {
    if (key.escape) {
      onBack()
    } else if (key.return) {
      const option = options[selectedIndex]
      if (option.type === 'learn') {
        onLearn()
      } else if (option.type === 'create') {
        onCreateNew()
      } else if (option.skill) {
        onSelect(option.skill)
      }
    } else if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : options.length - 1))
    } else if (key.downArrow) {
      setSelectedIndex(prev => (prev < options.length - 1 ? prev + 1 : 0))
    }
  })

  return (
    <Box flexDirection="column">
      <Header title="📚 Skills" subtitle="Reusable work patterns learned from conversations">
        {changes.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>{changes[changes.length - 1]}</Text>
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          {options.map((option, idx) => {
            const isSelected = idx === selectedIndex
            const isAction = option.type === 'learn' || option.type === 'create'

            return (
              <Box key={option.label} flexDirection="row">
                <Text color={isSelected ? theme.primary : undefined}>
                  {isSelected ? `${UI_ICONS.pointer} ` : '  '}
                </Text>
                <Text bold={isAction} color={isSelected ? theme.primary : undefined}>
                  {option.label}
                </Text>
                {option.skill && (
                  <Text dimColor> · {option.skill.location}</Text>
                )}
              </Box>
            )
          })}

          {skills.length === 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>No skills configured yet.</Text>
              <Text dimColor>Use "Learn from conversation" to create skills automatically,</Text>
              <Text dimColor>or "Create new skill" to add manually.</Text>
            </Box>
          )}
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

// Location Select
interface LocationSelectProps {
  createState: CreateState
  setCreateState: React.Dispatch<React.SetStateAction<CreateState>>
  setModeState: (state: ModeState) => void
}

function LocationSelect({ createState, setCreateState, setModeState }: LocationSelectProps) {
  const theme = getTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)

  const options = [
    { label: '📁 Project', value: 'project' as SkillLocation, desc: '.gemini/skills/' },
    { label: '🏠 Personal', value: 'user' as SkillLocation, desc: '~/.gemini/skills/' },
  ]

  useInput((input, key) => {
    if (key.return) {
      setCreateState(prev => ({ ...prev, location: options[selectedIndex].value }))
      setModeState({ mode: 'create-name', location: options[selectedIndex].value })
    } else if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : options.length - 1))
    } else if (key.downArrow) {
      setSelectedIndex(prev => (prev < options.length - 1 ? prev + 1 : 0))
    }
  })

  return (
    <Box flexDirection="column">
      <Header title="📦 Save Location" step={1} totalSteps={4}>
        <Box marginTop={1} flexDirection="column">
          {options.map((opt, idx) => (
            <Box key={opt.value} flexDirection="column" marginBottom={1}>
              <Text color={idx === selectedIndex ? theme.primary : undefined}>
                {idx === selectedIndex ? '❯ ' : '  '}
                {opt.label}
              </Text>
              <Box marginLeft={3}>
                <Text dimColor>{opt.desc}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      </Header>
      <InstructionBar instructions="↑↓ Navigate · Enter Select · Esc Back" />
    </Box>
  )
}

// Name Step
interface NameStepProps {
  createState: CreateState
  setCreateState: React.Dispatch<React.SetStateAction<CreateState>>
  setModeState: (state: ModeState) => void
  existingSkills: SkillConfig[]
}

function NameStep({ createState, setCreateState, setModeState, existingSkills }: NameStepProps) {
  const handleSubmit = () => {
    const raw = createState.skillName.trim()
    const normalized = normalizeSkillName(raw)

    const error = validateSkillName(normalized)
    if (error) {
      setCreateState(prev => ({ ...prev, skillName: normalized, error }))
      return
    }

    if (
      createState.location &&
      existingSkills.some(s => s.name === normalized && s.location === createState.location)
    ) {
      setCreateState(prev => ({ ...prev, skillName: normalized, error: 'Skill with this name already exists in this location' }))
      return
    }

    setCreateState(prev => ({ ...prev, skillName: normalized, error: null }))
    setModeState({ mode: 'create-description', location: createState.location! })
  }

  return (
    <Box flexDirection="column">
      <Header title="📝 Skill Name" step={2} totalSteps={4}>
        <Box marginTop={1} flexDirection="column">
          <InkTextInput
            value={createState.skillName}
            onChange={value => setCreateState(prev => ({ ...prev, skillName: value, error: null }))}
            placeholder="e.g. code-review, api-calling"
            onSubmit={handleSubmit}
          />
          {createState.error && (
            <Box marginTop={1}>
              <Text color="red">⚠ {createState.error}</Text>
            </Box>
          )}
        </Box>
      </Header>
      <InstructionBar instructions="Enter to continue · Esc to go back" />
    </Box>
  )
}

// Description Step
interface DescriptionStepProps {
  createState: CreateState
  setCreateState: React.Dispatch<React.SetStateAction<CreateState>>
  setModeState: (state: ModeState) => void
}

function DescriptionStep({ createState, setCreateState, setModeState }: DescriptionStepProps) {
  const handleSubmit = () => {
    const normalized = normalizeSkillDescription(createState.description)
    const error = validateSkillDescription(normalized)
    if (error) {
      setCreateState(prev => ({ ...prev, description: normalized, error }))
      return
    }
    setCreateState(prev => ({ ...prev, description: normalized, error: null }))
    setModeState({ mode: 'create-instructions', location: createState.location! })
  }

  return (
    <Box flexDirection="column">
      <Header title="📋 When to Use" subtitle="Describe when this skill should be used" step={3} totalSteps={4}>
        <Box marginTop={1} flexDirection="column">
          <InkTextInput
            value={createState.description}
            onChange={value => setCreateState(prev => ({ ...prev, description: value, error: null }))}
            placeholder="Use this skill when reviewing code for best practices..."
            onSubmit={handleSubmit}
          />
          {createState.error && (
            <Box marginTop={1}>
              <Text color="red">⚠ {createState.error}</Text>
            </Box>
          )}
        </Box>
      </Header>
      <InstructionBar instructions="Enter to continue · Esc to go back" />
    </Box>
  )
}

// Instructions Step
interface InstructionsStepProps {
  createState: CreateState
  setCreateState: React.Dispatch<React.SetStateAction<CreateState>>
  setModeState: (state: ModeState) => void
}

function InstructionsStep({ createState, setCreateState, setModeState }: InstructionsStepProps) {
  const handleSubmit = () => {
    if (!createState.instructions.trim()) {
      setCreateState(prev => ({ ...prev, error: 'Instructions are required' }))
      return
    }
    setCreateState(prev => ({ ...prev, error: null }))
    setModeState({ mode: 'create-confirm', location: createState.location! })
  }

  return (
    <Box flexDirection="column">
      <Header title="📖 Instructions" subtitle="Detailed instructions for the AI" step={4} totalSteps={4}>
        <Box marginTop={1} flexDirection="column">
          <InkTextInput
            value={createState.instructions}
            onChange={value => setCreateState(prev => ({ ...prev, instructions: value, error: null }))}
            placeholder="When performing this task, follow these steps: 1. ..."
            onSubmit={handleSubmit}
          />
          <Box marginTop={1}>
            <Text dimColor>Tip: You can edit the full Markdown file after creation</Text>
          </Box>
          {createState.error && (
            <Box marginTop={1}>
              <Text color="red">⚠ {createState.error}</Text>
            </Box>
          )}
        </Box>
      </Header>
      <InstructionBar instructions="Enter to continue · Esc to go back" />
    </Box>
  )
}

// Confirm Step
interface ConfirmStepProps {
  createState: CreateState
  setCreateState: React.Dispatch<React.SetStateAction<CreateState>>
  setModeState: (state: ModeState) => void
  onSkillCreated: (message: string) => void
}

function ConfirmStep({ createState, setCreateState, setModeState, onSkillCreated }: ConfirmStepProps) {
  const theme = getTheme()
  const [isCreating, setIsCreating] = useState(false)

  const handleConfirm = async () => {
    setIsCreating(true)
    try {
      await saveSkill(
        createState.location!,
        createState.skillName,
        createState.description,
        createState.instructions
      )
      onSkillCreated(`Created skill: ${createState.skillName}`)
    } catch (error) {
      setCreateState(prev => ({ ...prev, error: (error as Error).message }))
      setIsCreating(false)
    }
  }

  useInput((input, key) => {
    if (key.return && !isCreating) {
      handleConfirm()
    }
  })

  return (
    <Box flexDirection="column">
      <Header title="✅ Review & Create">
        <Box flexDirection="column" marginTop={1}>
          <Text>
            • <Text bold>Name:</Text> {createState.skillName}
          </Text>
          <Text>
            • <Text bold>Location:</Text> {createState.location === 'project' ? 'Project' : 'Personal'}
          </Text>
          <Text>
            • <Text bold>Description:</Text> {createState.description.slice(0, 60)}
            {createState.description.length > 60 ? '...' : ''}
          </Text>

          {createState.error && (
            <Box marginTop={1}>
              <Text color={theme.error}>✗ {createState.error}</Text>
            </Box>
          )}

          <Box marginTop={2}>
            {isCreating ? (
              <LoadingSpinner text="Creating skill..." />
            ) : (
              <Text dimColor>Press Enter to create</Text>
            )}
          </Box>
        </Box>
      </Header>
      <InstructionBar instructions="Enter Save · Esc Back" />
    </Box>
  )
}

// Skill Menu
interface SkillMenuProps {
  skill: SkillConfig
  setModeState: (state: ModeState) => void
}

function SkillMenu({ skill, setModeState }: SkillMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const options = [
    { label: 'View details', value: 'view' },
    { label: 'Delete skill', value: 'delete' },
  ]

  useInput((input, key) => {
    if (key.return) {
      const value = options[selectedIndex].value
      if (value === 'view') {
        setModeState({ mode: 'view-skill', selectedSkill: skill })
      } else if (value === 'delete') {
        setModeState({ mode: 'delete-confirm', selectedSkill: skill })
      }
    } else if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : options.length - 1))
    } else if (key.downArrow) {
      setSelectedIndex(prev => (prev < options.length - 1 ? prev + 1 : 0))
    }
  })

  return (
    <Box flexDirection="column">
      <Header title={`Skill: ${skill.name}`} subtitle={skill.location}>
        <Box marginTop={1} flexDirection="column">
          {options.map((opt, idx) => (
            <Box key={opt.value}>
              <Text color={idx === selectedIndex ? 'cyan' : undefined}>
                {idx === selectedIndex ? '❯ ' : '  '}
                {opt.label}
              </Text>
            </Box>
          ))}
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

// View Skill
interface ViewSkillProps {
  skill: SkillConfig
  setModeState: (state: ModeState) => void
}

function ViewSkill({ skill, setModeState }: ViewSkillProps) {
  const theme = getTheme()

  return (
    <Box flexDirection="column">
      <Header title={`Skill: ${skill.name}`}>
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold>Name:</Text> {skill.name}
          </Text>
          <Text>
            <Text bold>Location:</Text> {skill.location} · {skill.dirPath}
          </Text>
          <Text>
            <Text bold>Description:</Text> {skill.description}
          </Text>
          {skill.allowedTools && (
            <Text>
              <Text bold>Allowed Tools:</Text> {skill.allowedTools.join(', ')}
            </Text>
          )}

          <Box marginTop={1}>
            <Text bold>Instructions:</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text>{skill.instructions.slice(0, 500)}{skill.instructions.length > 500 ? '...' : ''}</Text>
          </Box>
        </Box>
      </Header>
      <InstructionBar instructions="Esc to go back" />
    </Box>
  )
}

// Delete Confirm
interface DeleteConfirmProps {
  skill: SkillConfig
  setModeState: (state: ModeState) => void
  onSkillDeleted: (message: string) => void
}

function DeleteConfirm({ skill, setModeState, onSkillDeleted }: DeleteConfirmProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [selected, setSelected] = useState(false)

  const handleConfirm = async () => {
    if (selected) {
      setIsDeleting(true)
      try {
        await deleteSkill(skill)
        onSkillDeleted(`Deleted skill: ${skill.name}`)
      } catch (error) {
        console.error('Failed to delete skill:', error)
        setIsDeleting(false)
      }
    } else {
      setModeState({ mode: 'skill-menu', selectedSkill: skill })
    }
  }

  useInput((input, key) => {
    if (key.return) {
      handleConfirm()
    } else if (key.leftArrow || key.rightArrow || key.tab) {
      setSelected(!selected)
    }
  })

  if (isDeleting) {
    return (
      <Box flexDirection="column">
        <Header title="Delete skill">
          <Box marginTop={1}>
            <LoadingSpinner text="Deleting skill..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Header title="Delete skill" subtitle={`Delete "${skill.name}"?`}>
        <Box marginTop={1} flexDirection="column">
          <Text>This will permanently delete the skill directory.</Text>
          <Box marginTop={2} gap={3}>
            <Text color={!selected ? 'cyan' : undefined}>
              {!selected ? '❯ ' : '  '}No
            </Text>
            <Text color={selected ? 'red' : undefined}>
              {selected ? '❯ ' : '  '}Yes, delete
            </Text>
          </Box>
        </Box>
      </Header>
      <InstructionBar instructions="←→ Select · Enter Confirm" />
    </Box>
  )
}

// Learn Name Step
interface LearnNameStepProps {
  learnName: string
  setLearnName: (name: string) => void
  isLearning: boolean
  setIsLearning: (loading: boolean) => void
  setModeState: (state: ModeState) => void
  context: any
}

function LearnNameStep({
  learnName,
  setLearnName,
  isLearning,
  setIsLearning,
  setModeState,
  context,
}: LearnNameStepProps) {
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setIsLearning(true)
    setError(null)

    try {
      const getMessages = getMessagesGetter()
      const messages = typeof getMessages === 'function' ? getMessages() : []

      if (messages.length < 2) {
        throw new Error('对话内容太少，无法学习')
      }

      const learned = await learnFromConversation(
        messages,
        learnName.trim() || null,
        context.abortController?.signal || new AbortController().signal
      )

      setModeState({
        mode: 'learn-confirm',
        learnedContent: learned,
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsLearning(false)
    }
  }

  if (isLearning) {
    return (
      <Box flexDirection="column">
        <Header title="🧠 Learning from Conversation">
          <Box marginTop={1}>
            <LoadingSpinner text="Analyzing conversation and extracting skill..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Header title="🧠 Learn from Conversation" subtitle="Extract a reusable skill from the current session">
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Optional: Enter a skill name (or leave empty for auto-naming)</Text>
          <Box marginTop={1}>
            <InkTextInput
              value={learnName}
              onChange={setLearnName}
              placeholder="e.g. code-review, api-calling (optional)"
              onSubmit={handleSubmit}
            />
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color="red">⚠ {error}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>Press Enter to analyze conversation</Text>
          </Box>
        </Box>
      </Header>
      <InstructionBar instructions="Enter to learn · Esc to cancel" />
    </Box>
  )
}

// Learn Confirm Step
interface LearnConfirmStepProps {
  learnedContent: LearnedContent
  setModeState: (state: ModeState) => void
  onSkillCreated: (message: string) => void
}

function LearnConfirmStep({ learnedContent, setModeState, onSkillCreated }: LearnConfirmStepProps) {
  const theme = getTheme()
  const [isCreating, setIsCreating] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const options = [
    { label: '📁 Save to Project', location: 'project' as SkillLocation },
    { label: '🏠 Save to Personal', location: 'user' as SkillLocation },
  ]

  const handleSave = async () => {
    setIsCreating(true)
    setError(null)

    try {
      await saveSkill(
        options[selectedIndex].location,
        learnedContent.name,
        learnedContent.description,
        learnedContent.instructions
      )
      onSkillCreated(`Learned skill: ${learnedContent.name}`)
    } catch (err) {
      setError((err as Error).message)
      setIsCreating(false)
    }
  }

  useInput((input, key) => {
    if (key.return && !isCreating) {
      handleSave()
    } else if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : options.length - 1))
    } else if (key.downArrow) {
      setSelectedIndex(prev => (prev < options.length - 1 ? prev + 1 : 0))
    }
  })

  if (isCreating) {
    return (
      <Box flexDirection="column">
        <Header title="💾 Saving Skill">
          <Box marginTop={1}>
            <LoadingSpinner text="Creating skill..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Header title="🧠 Learned Skill Preview">
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold>Name:</Text> {learnedContent.name}
          </Text>
          <Text>
            <Text bold>Description:</Text> {learnedContent.description}
          </Text>

          <Box marginTop={1}>
            <Text bold>Instructions Preview:</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text dimColor>
              {learnedContent.instructions.slice(0, 300)}
              {learnedContent.instructions.length > 300 ? '...' : ''}
            </Text>
          </Box>

          <Box marginTop={2}>
            <Text bold>Save to:</Text>
          </Box>
          {options.map((opt, idx) => (
            <Box key={opt.location}>
              <Text color={idx === selectedIndex ? theme.primary : undefined}>
                {idx === selectedIndex ? '❯ ' : '  '}
                {opt.label}
              </Text>
            </Box>
          ))}

          {error && (
            <Box marginTop={1}>
              <Text color={theme.error}>✗ {error}</Text>
            </Box>
          )}
        </Box>
      </Header>
      <InstructionBar instructions="↑↓ Select location · Enter Save · Esc Cancel" />
    </Box>
  )
}

// Export the command
export default {
  name: 'skills',
  description: '管理 Skills（可复用的工作模式）',
  type: 'local-jsx' as const,
  isEnabled: true,
  isHidden: false,

  async call(
    onExit: (message?: string) => void,
    context: any,
    args?: string
  ) {
    return <SkillsUI onExit={onExit} initialArgs={args} context={context} />
  },

  userFacingName() {
    return 'skills'
  },
}
