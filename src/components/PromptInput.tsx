import { Box, Text, useInput } from 'ink'
import * as React from 'react'
import { type Message } from '@query'
import { processUserInput } from '@utils/messages'
import { useArrowKeyHistory } from '@hooks/useArrowKeyHistory'
import { useUnifiedCompletion } from '@hooks/useUnifiedCompletion'
import { addToHistory } from '@history'
import TextInput from './TextInput'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { countTokens } from '@utils/tokens'
import { SentryErrorBoundary } from './SentryErrorBoundary'
import type { Command } from '@commands'
import type { SetToolJSXFn, Tool } from '@tool'
import { TokenWarning } from './TokenWarning'
import { useTerminalSize } from '@hooks/useTerminalSize'
import { getTheme } from '@utils/theme'
import { setTerminalTitle } from '@utils/terminal'
import { launchExternalEditor } from '@utils/externalEditor'
import { usePermissionContext } from '@context/PermissionContext'
import { getGlobalGeminiSettingsPath, readGeminiSettingsFile } from '@utils/geminiSettings'
import { getTotalCost } from '@costTracker'
import { formatNumber } from '@utils/format'
import figures from 'figures'
import { getTodos } from '@utils/todoStorage'
import { TodoPanel } from './TodoPanel'
import { getActiveSkills, type SkillConfig } from '@utils/skillLoader'
import { setSessionEnabledSkillNames } from '@utils/skillSession'

type Props = {
  commands: Command[]
  forkNumber: number
  messageLogName: string
  isDisabled: boolean
  isLoading: boolean
  onQuery: (
    newMessages: Message[],
    abortController?: AbortController,
  ) => Promise<void>
  debug: boolean
  verbose: boolean
  messages: Message[]
  setToolJSX: SetToolJSXFn
  tools: Tool[]
  input: string
  onInputChange: (value: string) => void
  cursorOffset: number
  setCursorOffset: (offset: number) => void
  submitCount: number
  onSubmitCountChange: (updater: (prev: number) => number) => void
  setIsLoading: (isLoading: boolean) => void
  setAbortController: (abortController: AbortController | null) => void
  autoMode: boolean
  onToggleAutoMode: () => void
  onShowMessageSelector: () => void
  setForkConvoWithMessagesOnTheNextRender: (
    forkConvoWithMessages: Message[],
  ) => void
  readFileTimestamps: { [filename: string]: number }
  abortController: AbortController | null
}

function getPastedTextPrompt(text: string): string {
  const newlineCount = (text.match(/\r\n|\r|\n/g) || []).length
  return `[Pasted text +${newlineCount} lines] `
}
function PromptInput({
  commands,
  forkNumber,
  messageLogName,
  isDisabled,
  isLoading,
  onQuery,
  debug,
  verbose,
  messages,
  setToolJSX,
  tools,
  input,
  onInputChange,
  cursorOffset,
  setCursorOffset,
  submitCount,
  onSubmitCountChange,
  setIsLoading,
  abortController,
  setAbortController,
  autoMode,
  onToggleAutoMode,
  onShowMessageSelector,
  setForkConvoWithMessagesOnTheNextRender,
  readFileTimestamps,
}: Props): React.ReactNode {
  const [exitMessage, setExitMessage] = useState<{
    show: boolean
    key?: string
  }>({ show: false })
  const [message, setMessage] = useState<{ show: boolean; text?: string }>({
    show: false,
  })
  const [pastedImage, setPastedImage] = useState<string | null>(null)
  const [placeholder, setPlaceholder] = useState('')
  const [pastedText, setPastedText] = useState<string | null>(null)
  const [isEditingExternally, setIsEditingExternally] = useState(false)
  const [showTodoPanel, setShowTodoPanel] = useState(false)
  const [skillsLoadedNotice, setSkillsLoadedNotice] = useState<string | null>(
    null,
  )
  const skillsNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const hasUserStartedConversation = useMemo(
    () => messages.some(message => message.type === 'user'),
    [messages],
  )

  // Permission context for mode management
  const { cycleMode } = usePermissionContext()

  // useEffect(() => {
  //   getExampleCommands().then(commands => {
  //     setPlaceholder(`Try "${sample(commands)}"`)
  //   })
  // }, [])
  // Unified completion system - one hook to rule them all (now with terminal behavior)
  const {
    suggestions,
    selectedIndex,
    isActive: completionActive,
  } = useUnifiedCompletion({
    input,
    cursorOffset,
    onInputChange,
    setCursorOffset,
    commands,
    onSubmit,
  })

  // Get theme early for memoized rendering
  const theme = getTheme()

  const commandDescByName = useMemo(() => {
    const map = new Map<string, string>()
    for (const cmd of commands) {
      map.set(cmd.userFacingName(), cmd.description)
    }
    return map
  }, [commands])

  useEffect(() => {
    if (hasUserStartedConversation) {
      setSkillsLoadedNotice(null)
      if (skillsNoticeTimerRef.current) {
        clearTimeout(skillsNoticeTimerRef.current)
        skillsNoticeTimerRef.current = null
      }
      return
    }

    let cancelled = false
    ;(async () => {
      let count = 0
      try {
        const skills = await getActiveSkills()
        if (cancelled) {
          return
        }
        const names = skills.map((skill: SkillConfig) => skill.name)
        setSessionEnabledSkillNames(names.length > 0 ? names : null)
        count = names.length
      } catch {
        if (cancelled) {
          return
        }
        setSessionEnabledSkillNames(null)
      }

      setSkillsLoadedNotice(`✓ Skills 已加载（${count}个）`)
      if (skillsNoticeTimerRef.current) {
        clearTimeout(skillsNoticeTimerRef.current)
      }
      skillsNoticeTimerRef.current = setTimeout(() => {
        setSkillsLoadedNotice(null)
        skillsNoticeTimerRef.current = null
      }, 3000)
    })()

    return () => {
      cancelled = true
      if (skillsNoticeTimerRef.current) {
        clearTimeout(skillsNoticeTimerRef.current)
        skillsNoticeTimerRef.current = null
      }
    }
  }, [hasUserStartedConversation])

  // Memoized completion suggestions rendering - after useUnifiedCompletion
  const renderedSuggestions = useMemo(() => {
    if (suggestions.length === 0) return null
    const isCommandMenu = suggestions[0]?.type === 'command'

    if (isCommandMenu) {
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.secondaryBorder}
          paddingX={2}
          paddingY={1}
          gap={1}
        >
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color={theme.suggestion}>
              命令
            </Text>
          </Box>

          <Box flexDirection="column">
            {suggestions.map((suggestion, index) => {
              const isSelected = index === selectedIndex
              const name = suggestion.value
              const desc = commandDescByName.get(name) || suggestion.metadata?.description || ''
              return (
                <Box key={`cmd-${name}-${index}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text color={isSelected ? theme.suggestion : theme.secondaryText}>
                      {isSelected ? figures.pointer : ' '}
                    </Text>
                    <Text bold={isSelected} color={isSelected ? theme.text : theme.text}>
                      /{name}
                    </Text>
                  </Box>
                  {desc ? (
                    <Box marginLeft={2}>
                      <Text color={theme.secondaryText} wrap="truncate-end">
                        {desc}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              )
            })}
          </Box>

        </Box>
      )
    }

    return suggestions.map((suggestion, index) => {
      const isSelected = index === selectedIndex
      const isAgent = suggestion.type === 'agent'
      
      // Simple color logic without complex lookups
      const displayColor = isSelected 
        ? theme.suggestion 
        : (isAgent && suggestion.metadata?.color)
          ? suggestion.metadata.color
          : undefined
      
      return (
        <Box key={`${suggestion.type}-${suggestion.value}-${index}`} flexDirection="row">
          <Text
            color={displayColor}
            dimColor={!isSelected && !displayColor}
          >
            {isSelected ? '◆ ' : '  '}
            {suggestion.displayValue}
          </Text>
        </Box>
      )
    })
  }, [suggestions, selectedIndex, theme, commandDescByName])

  const onChange = useCallback(
    (value: string) => {
      onInputChange(value)
    },
    [onInputChange],
  )

  const { resetHistory, onHistoryUp, onHistoryDown } = useArrowKeyHistory(
    (value: string) => {
      onChange(value)
    },
    input,
  )

  // Only use history navigation when there are no suggestions
  const handleHistoryUp = () => {
    if (!completionActive) {
      onHistoryUp()
    }
  }

  const handleHistoryDown = () => {
    if (!completionActive) {
      onHistoryDown()
    }
  }

  async function onSubmit(input: string, isSubmittingSlashCommand = false) {
    if (input === '') {
      return
    }
    if (isDisabled) {
      return
    }
    if (isLoading) {
      return
    }
    
    // 补全菜单打开时：默认 Enter 用来选中补全，而不是发送消息
    // 但如果是“命令面板”主动触发的提交（isSubmittingSlashCommand=true），允许继续走提交流程
    if (suggestions.length > 0 && completionActive && !isSubmittingSlashCommand) {
      return
    }

    // Handle exit commands
    if (['exit', 'quit', ':q', ':q!', ':wq', ':wq!'].includes(input.trim())) {
      exit()
    }

    let finalInput = input
    if (pastedText) {
      // Create the prompt pattern that would have been used for this pasted text
      const pastedPrompt = getPastedTextPrompt(pastedText)
      if (finalInput.includes(pastedPrompt)) {
        finalInput = finalInput.replace(pastedPrompt, pastedText)
      } // otherwise, ignore the pastedText if the user has modified the prompt
    }
    onInputChange('')
    setCursorOffset(0)
    // Suggestions are now handled by unified completion
    setPastedImage(null)
    setPastedText(null)
    onSubmitCountChange(_ => _ + 1)

    setIsLoading(true)
    
    const newAbortController = new AbortController()
    setAbortController(newAbortController)

    const messages = await processUserInput(
      finalInput,
      setToolJSX,
      {
        options: {
          commands,
          forkNumber,
          messageLogName,
          tools,
          verbose,
          maxThinkingTokens: 0,
        },
        messageId: undefined,
        abortController: newAbortController,
        readFileTimestamps,
        setForkConvoWithMessagesOnTheNextRender,
      },
      pastedImage ?? null,
    )

    if (messages.length) {
      onQuery(messages, newAbortController)
    } else {
      // Local JSX commands
      addToHistory(input)
      resetHistory()
      return
    }

    for (const message of messages) {
      if (message.type === 'user') {
        addToHistory(input)
        resetHistory()
      }
    }
  }

  function onImagePaste(image: string) {
    setPastedImage(image)
  }

  function onTextPaste(rawText: string) {
    // Replace any \r with \n first to match useTextInput's conversion behavior
    const text = rawText.replace(/\r/g, '\n')

    // Get prompt with newline count
    const pastedPrompt = getPastedTextPrompt(text)

    // Update the input with a visual indicator that text has been pasted
    const newInput =
      input.slice(0, cursorOffset) + pastedPrompt + input.slice(cursorOffset)
    onInputChange(newInput)

    // Update cursor position to be after the inserted indicator
    setCursorOffset(cursorOffset + pastedPrompt.length)

    // Still set the pastedText state for actual submission
    setPastedText(text)
  }

  useInput((_inputChar, key) => {
    if (key.escape && messages.length > 0 && !input && !isLoading) {
      onShowMessageSelector()
    }

    // Alt+M: toggle auto mode for this session
    if (key.meta && (_inputChar === 'm' || _inputChar === 'M')) {
      onToggleAutoMode()
      return true
    }

    // Alt+T: toggle todo panel
    if (key.meta && (_inputChar === 't' || _inputChar === 'T')) {
      setShowTodoPanel(prev => !prev)
      return true
    }

    // Alt+P: cycle permission modes
    if (key.meta && (_inputChar === 'p' || _inputChar === 'P')) {
      cycleMode()
      return true // Explicitly handled
    }

    return false // Not handled, allow other hooks
  }, { isActive: !isEditingExternally })

  const handleExternalEdit = useCallback(async () => {
    if (isEditingExternally || isLoading || isDisabled) return
    setIsEditingExternally(true)
    setMessage({ show: true, text: 'Opening external editor...' })

    const result = await launchExternalEditor(input)
    if (result.text !== null) {
      onInputChange(result.text)
      setCursorOffset(result.text.length)
      setMessage({
        show: true,
        text: `Loaded from ${result.editorLabel ?? 'editor'}`,
      })
      setTimeout(() => setMessage({ show: false }), 3000)
    } else {
      const errorMessage =
        'error' in result && result.error
          ? result.error.message
          : 'External editor unavailable. Set $EDITOR or install code/nano/vim/notepad.'
      setMessage({
        show: true,
        text: errorMessage,
      })
      setTimeout(() => setMessage({ show: false }), 4000)
    }

    setIsEditingExternally(false)
  }, [
    input,
    isEditingExternally,
    isLoading,
    isDisabled,
    onInputChange,
    setCursorOffset,
    setMessage,
  ])

  const insertNewlineAtCursor = useCallback(() => {
    const next = input.slice(0, cursorOffset) + '\n' + input.slice(cursorOffset)
    onInputChange(next)
    setCursorOffset(cursorOffset + 1)
  }, [cursorOffset, input, onInputChange])

  // Handle special key combinations before character input
  const handleSpecialKey = useCallback((inputChar: string, key: any): boolean => {
    if (isEditingExternally) return true

    // Shift/Meta/Option + Enter => insert newline, do not submit
    if (key.return && (key.shift || key.meta || key.option)) {
      insertNewlineAtCursor()
      return true
    }

    // Alt+G -> open external editor
    if (key.meta && (inputChar === 'g' || inputChar === 'G')) {
      void handleExternalEdit()
      return true
    }

    return false // Not handled, allow normal processing
  }, [handleExternalEdit, isEditingExternally])

  const textInputColumns = useTerminalSize().columns - 4
  const tokenUsage = useMemo(() => countTokens(messages), [messages])
  const modelDisplayName = useMemo(() => {
    try {
      const settingsPath = getGlobalGeminiSettingsPath()
      const settings = readGeminiSettingsFile(settingsPath)
      const modelName = settings.model?.name
      if (modelName) {
        return modelName.replace(/^models\//, '')
      }
    } catch {
      // ignore
    }
    return '未设置模型'
  }, [messages, isLoading])
  const totalCostLabel = useMemo(() => {
    const totalCost = getTotalCost()
    return `$${totalCost > 0.5 ? totalCost.toFixed(2) : totalCost.toFixed(4)}`
  }, [messages, isLoading])
  const tokenUsageLabel = useMemo(() => `${formatNumber(tokenUsage)} tokens`, [
    tokenUsage,
  ])
  const showTokenWarning = tokenUsage >= 600000
  const todos = getTodos()
  const todoStats = useMemo(() => {
    const total = todos.length
    const completed = todos.filter(t => t.status === 'completed').length
    return { total, completed }
  }, [todos])
  const todoShortcutLabel =
    todoStats.total > 0
      ? `Todo(${todoStats.completed}/${todoStats.total})`
      : 'Todo'
  const topNoticeText = exitMessage.show
    ? `Press ${exitMessage.key} again to exit`
    : message.show
      ? message.text ?? ''
      : skillsLoadedNotice
  const showTopNotice =
    !completionActive &&
    suggestions.length === 0 &&
    (Boolean(topNoticeText) || showTokenWarning)

  return (
    <Box flexDirection="column">
      {showTopNotice && (
        <Box
          flexDirection="row"
          justifyContent="space-between"
          paddingX={2}
          paddingY={0}
          marginBottom={1}
        >
          <Box justifyContent="flex-start" gap={1}>
            {topNoticeText ? <Text dimColor>{topNoticeText}</Text> : null}
          </Box>
          <SentryErrorBoundary children={
            <Box justifyContent="flex-end" gap={1}>
              <TokenWarning tokenUsage={tokenUsage} />
            </Box>
          } />
        </Box>
      )}
      <Box
        alignItems="flex-start"
        justifyContent="flex-start"
        marginTop={showTopNotice ? 0 : 1}
        borderColor={theme.secondaryBorder}
        borderDimColor
        borderStyle="round"
        width="100%"
      >
        <Box
          alignItems="flex-start"
          alignSelf="flex-start"
          flexWrap="nowrap"
          justifyContent="flex-start"
          width={3}
        >
          <Text color={isLoading ? theme.secondaryText : undefined}>
            &nbsp;&gt;&nbsp;
          </Text>
        </Box>
        <Box paddingRight={1}>
          <TextInput
            multiline
            focus={!isEditingExternally}
            onSubmit={onSubmit}
            onChange={onChange}
            value={input}
            onHistoryUp={handleHistoryUp}
            onHistoryDown={handleHistoryDown}
            onHistoryReset={() => resetHistory()}
            placeholder={submitCount > 0 ? undefined : placeholder}
            onExit={() => process.exit(0)}
            onExitMessage={(show, key) => setExitMessage({ show, key })}
            onMessage={(show, text) => setMessage({ show, text })}
            onImagePaste={onImagePaste}
            columns={textInputColumns}
            isDimmed={isDisabled || isLoading || isEditingExternally}
            disableCursorMovementForUpDownKeys={completionActive}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onPaste={onTextPaste}
            onSpecialKey={handleSpecialKey}
          />
        </Box>
      </Box>
      {showTodoPanel && <TodoPanel todos={todos} />}
      {/* Unified completion suggestions - optimized rendering */}
      {suggestions.length > 0 && (
        <Box
          flexDirection="row"
          justifyContent="space-between"
          paddingX={2}
          paddingY={0}
        >
          <Box flexDirection="column">
            {renderedSuggestions}

          </Box>
          <SentryErrorBoundary children={
            <Box justifyContent="flex-end" gap={1}>
              <TokenWarning tokenUsage={countTokens(messages)} />
            </Box>
          } />
        </Box>
      )}
      {/* 底部状态栏 - 简约设计 */}
      <Box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={2}
        marginTop={1}
      >
        <Text dimColor>
          / 命令  Alt+P 模式  Alt+G 编辑器  Alt+T {todoShortcutLabel}  Alt+M 自动模式：
          {autoMode ? '开' : '关'}
          {isLoading ? '  Esc 取消' : messages.length > 0 ? '  Esc 历史' : ''}
        </Text>
        <Text dimColor>
          {modelDisplayName} · {totalCostLabel} · {tokenUsageLabel}
        </Text>
      </Box>
    </Box>
  )
}

export default memo(PromptInput)

function exit(): never {
  setTerminalTitle('')
  process.exit(0)
}
