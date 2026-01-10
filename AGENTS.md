# AGENTS.md

This file provides guidance to YUUKA automation agents (including those compatible with Claude Code's `.claude` ecosystem) when working with code in this repository.

## Development Commands

### Essential Development Workflow
```bash
# Install dependencies
npm install

# Run in development mode (hot reload with verbose output)
npm run dev

# Build the CLI wrapper for distribution
npm run build

# Clean build artifacts
npm run clean

# Run tests
npm run test

# Check types
npm run typecheck

# Format code
npm run format
npm run format:check
```

### Build System Details
- **Primary Build Tool**: Node.js (npm scripts)
- **Distribution**: Smart CLI wrapper (`cli.cjs`) that runs with Node.js
- **Entry Point**: `src/entrypoints/cli.tsx`
- **Build Output**: `cli.cjs` (executable wrapper) and `.npmrc` (npm configuration)

### Publishing
```bash
# Publish to npm (requires build first)
npm publish
# Or with bundled dependency check skip:
SKIP_BUNDLED_CHECK=true npm publish
```

## High-Level Architecture

### Core System Design
YUUKA implements a **three-layer parallel architecture** refined for fast iteration across terminal workflows while remaining compatible with the Claude Code agent ecosystem:

1. **User Interaction Layer** (`src/screens/REPL.tsx`)
   - Interactive terminal interface using Ink (React for CLI)
   - Command parsing and user input handling
   - Real-time UI updates and syntax highlighting

2. **Orchestration Layer** (`src/tools/TaskTool/`)
   - Dynamic agent system for task delegation
   - Multi-model collaboration and switching
   - Context management and conversation continuity

3. **Tool Execution Layer** (`src/tools/`)
   - Specialized tools for different capabilities (File I/O, Bash, Grep, etc.)
   - Permission system for secure tool access
   - MCP (Model Context Protocol) integration

### Multi-Model Architecture
**Key Innovation**: Unlike single-model systems, YUUKA supports unlimited AI models with intelligent collaboration:

- **ModelManager** (`src/utils/model.ts`): Unified model configuration and switching
- **Model Profiles**: Each model has independent API endpoints, authentication, and capabilities
- **Model Pointers**: Default models for different purposes (main, task, reasoning, quick)
- **Dynamic Switching**: Runtime model changes without session restart

### Agent System (`src/utils/agentLoader.ts`)
**Dynamic Agent Configuration Loading** with priority system:
1. Built-in (code-embedded)
2. `~/.gemini/agents/` (user scope)
3. `./.gemini/agents/` (project scope)

Agents are defined as markdown files with YAML frontmatter:
```markdown
---
name: agent-name
description: "When to use this agent"
tools: ["FileRead", "Bash"] # or "*" for all tools
model: model-name # optional
---

System prompt content here...
```

### Tool Architecture
Each tool follows a consistent pattern in `src/tools/[ToolName]/`:
- `[ToolName].tsx`: Main tool implementation with React UI
- `prompt.ts`: Tool-specific system prompts
- Tool schema using Zod for validation
- Permission-aware execution

### Service Layer
- **Anthropic Service** (`src/services/claude.ts`): Claude API integration
- **OpenAI Service** (`src/services/openai.ts`): OpenAI-compatible models
- **Model Adapter Factory** (`src/services/modelAdapterFactory.ts`): Unified model interface
- **MCP Client** (`src/services/mcpClient.ts`): Model Context Protocol for tool extensions

### Configuration System (`src/utils/config.ts`)
**Hierarchical Configuration** supporting:
- Global config (`~/.gemini/settings.json`)
- Project config (`./.gemini/settings.json`)
- Environment variables
- CLI parameter overrides
- Multi-model profile management

### Context Management
- **Message Context Manager** (`src/utils/messageContextManager.ts`): Intelligent context window handling
- **Memory Tools** (`src/tools/MemoryReadTool/`, `src/tools/MemoryWriteTool/`): Persistent memory across sessions
- **Project Context** (`src/context.ts`): Codebase understanding and file relationships

### Permission System (`src/permissions.ts`)
**Security-First Tool Access**:
- Granular permission requests for each tool use
- User approval required for file modifications and command execution
- Tool capability filtering based on agent configuration
- Secure file path validation and sandboxing

## Important Implementation Details

### Async Tool Descriptions
**Critical**: Tool descriptions are async functions that must be awaited:
```typescript
// INCORRECT
const description = tool.description

// CORRECT
const description = typeof tool.description === 'function' 
  ? await tool.description() 
  : tool.description
```

### Agent Loading Performance
- **Memoization**: LRU cache to avoid repeated file I/O
- **Hot Reload**: File system watchers for real-time agent updates
- **Parallel Loading**: All agent directories scanned concurrently

### UI Framework Integration
- **Ink**: React-based terminal UI framework
- **Component Structure**: Follows React patterns with hooks and context
- **Terminal Handling**: Custom input handling for complex interactions

### Error Handling Strategy
- **Graceful Degradation**: System continues with built-in agents if loading fails
- **User-Friendly Errors**: Clear error messages with suggested fixes
- **Debug Logging**: Comprehensive logging system (`src/utils/debugLogger.ts`)

### TypeScript Integration
- **Strict Types**: Full TypeScript coverage with strict mode
- **Zod Schemas**: Runtime validation for all external data
- **Tool Typing**: Consistent `Tool` interface for all tools

## Key Files for Understanding the System

### Core Entry Points
- `src/entrypoints/cli.tsx`: Main CLI application entry
- `src/screens/REPL.tsx`: Interactive terminal interface

### Tool System
- `src/tools.ts`: Tool registry and exports
- `src/Tool.ts`: Base tool interface definition
- `src/tools/TaskTool/TaskTool.tsx`: Agent orchestration tool

### Configuration & Model Management
- `src/utils/config.ts`: Configuration management
- `src/utils/model.ts`: Model manager and switching logic
- `src/utils/agentLoader.ts`: Dynamic agent configuration loading

### Services & Integrations
- `src/services/claude.ts`: Main AI service integration
- `src/services/mcpClient.ts`: MCP tool integration
- `src/utils/messageContextManager.ts`: Context window management

## Development Patterns

### Adding New Tools
1. Create directory in `src/tools/[ToolName]/`
2. Implement `[ToolName].tsx` following existing patterns
3. Add `prompt.ts` for tool-specific prompts
4. Register in `src/tools.ts`
5. Update tool permissions in agent configurations

### Adding New Commands
1. Create command file in `src/commands/[command].tsx`
2. Implement command logic with Ink UI components
3. Register in `src/commands.ts`
4. Add command to help system

### Model Integration
1. Add model profile to `src/constants/models.ts`
2. Implement adapter if needed in `src/services/adapters/`
3. Update model capabilities in `src/constants/modelCapabilities.ts`
4. Test with existing tool suite

### Agent Development
1. Create `.md` file with proper YAML frontmatter
2. Place in appropriate directory based on scope
3. Test with `/agents` command
4. Verify tool permissions work correctly

## User Preferences

### Interaction Style
- **Direct Reporting**: 用户偏好直接在对话中获取结果（“讲给我听”），而不是生成文件。除非用户明确要求生成文件或内容极长，否则应直接在回复中展示摘要或全文。
