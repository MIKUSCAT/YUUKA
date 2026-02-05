# YUUKA - Personal Agent CLI
<img width="991" height="479" alt="image" src="https://github.com/user-attachments/assets/c1751e92-94dc-4e4a-9558-8cd2d058c1a1" />  <br> 
[![npm version](https://badge.fury.io/js/yuuka.svg)](https://www.npmjs.com/package/yuuka)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![AGENTS.md](https://img.shields.io/badge/AGENTS.md-Compatible-brightgreen)](https://agents.md)

[中文文档](README.zh-CN.md)

<img width="90%" alt="image" src="https://github.com/user-attachments/assets/fdce7017-8095-429d-b74e-07f43a6919e1" />

<img width="90%" alt="2c0ad8540f2872d197c7b17ae23d74f5" src="https://github.com/user-attachments/assets/f220cc27-084d-468e-a3f4-d5bc44d84fac" />

<img width="90%" alt="f266d316d90ddd0db5a3d640c1126930" src="https://github.com/user-attachments/assets/90ec7399-1349-4607-b689-96613b3dc3e2" />


<img width="90%" alt="image" src="https://github.com/user-attachments/assets/b30696ce-5ab1-40a0-b741-c7ef3945dba0" />


## Update Log

**2025-08-29**: We've added Windows support! All Windows users can now run YUUKA using Git Bash, Unix subsystems, or WSL (Windows Subsystem for Linux) on their computers.


## AGENTS.md Standard Support

**YUUKA proudly supports the [AGENTS.md standard protocol](https://agents.md) initiated by OpenAI** - a simple, open format for guiding programming agents that's used by 20k+ open source projects.

### Full Compatibility with Multiple Standards

- **AGENTS.md** - Native support for the OpenAI-initiated standard format
- **CLAUDE.md** - Full backward compatibility with Claude Code `.claude` configurations  
- **Subagent System** - Advanced agent delegation and task orchestration
- **Gemini-only** - Uses Gemini native API (Bearer + configurable baseUrl)

Use `# Your documentation request` to generate and maintain your AGENTS.md file automatically, while preserving compatibility with existing `.claude` workflows.

## Overview

YUUKA is a personal computer agent that lives in your terminal. It can understand your codebase, edit files, run commands, and handle entire workflows for you.

> **Security Notice**: YUUKA runs in YOLO mode by default (equivalent to Claude Code's `--dangerously-skip-permissions` flag), bypassing all permission checks for maximum productivity. YOLO mode is recommended only for trusted, secure environments when working on non-critical projects. If you're working with important files or using models of questionable capability, we strongly recommend using `yuuka --safe` to enable permission checks and manual approval for all operations.
> 
> **Model Performance**: For optimal performance, we recommend using newer, more capable models designed for autonomous task completion. Avoid older Q&A-focused models like GPT-4o or Gemini 2.5 Pro, which are optimized for answering questions rather than sustained independent task execution. Choose models specifically trained for agentic workflows and extended reasoning capabilities.
>
> **Gemini-only notice**: This version uses Gemini native API only (`Authorization: Bearer <apiKey>`). Configuration lives in the project file `./.gemini/settings.json` (no global merge).

<img width="600" height="577" alt="image" src="https://github.com/user-attachments/assets/8b46a39d-1ab6-4669-9391-14ccc6c5234c" />

## Technical Blueprint

- UI entry: `src/entrypoints/cli.tsx` → `src/screens/REPL.tsx`
- Input flow: `processUserInput` routes `/command` or plain text → `query` → `services/gemini/query.ts`
- Config: project-only `./.gemini/settings.json` (auth/model/mcp); data in `~/.gemini/yuuka/`
- Tools: `src/tools/*` with permission gating; Bash tool is agent-only (no manual bash mode)
- Extensibility: agents in `./.gemini/agents/` and `~/.gemini/agents/`, MCP via `mcpServers`

## Features

### Core Capabilities
- **AI-Powered Assistance** - Uses advanced AI models to understand and respond to your requests
- **Gemini-only** - This version uses Gemini native API only
- **Intelligent Agent System** - Use `@run-agent-name` to delegate tasks to specialized subagents
- **Code Editing** - Directly edit files with intelligent suggestions and improvements
- **Codebase Understanding** - Analyzes your project structure and code relationships
- **Command Execution** - Run shell commands and see results in real-time
- **Workflow Automation** - Handle complex development tasks with simple prompts

### Authoring Comfort
- `Ctrl+G` opens your message in your preferred editor (respects `$EDITOR`/`$VISUAL`; falls back to code/nano/vim/notepad) and returns the text to the prompt when you close it.
- `Shift+Enter` inserts a newline inside the prompt without sending; plain Enter submits.

### Advanced Intelligent Completion System
Our state-of-the-art completion system provides unparalleled coding assistance:

#### Smart Fuzzy Matching
- **Hyphen-Aware Matching** - Type `dao` to match `run-agent-dao-qi-harmony-designer`
- **Abbreviation Support** - `dq` matches `dao-qi`, `nde` matches `node`
- **Numeric Suffix Handling** - `py3` intelligently matches `python3`
- **Multi-Algorithm Fusion** - Combines 7+ matching algorithms for best results

#### Intelligent Context Detection
- **Auto-Prefix Addition** - Tab/Enter automatically adds `@` for agents and file references
- **Mixed Completion** - Seamlessly switch between commands, files, and agents
- **Smart Prioritization** - Results ranked by relevance and usage frequency

#### Unix Command Optimization
- **500+ Common Commands** - Curated database of frequently used Unix/Linux commands
- **System Intersection** - Only shows commands that actually exist on your system
- **Priority Scoring** - Common commands appear first (git, npm, docker, etc.)
- **Real-time Loading** - Dynamic command discovery from system PATH

### User Experience
- **Interactive UI** - Beautiful terminal interface with syntax highlighting
- **Tool System** - Extensible architecture with specialized tools for different tasks
- **Context Management** - Smart context handling to maintain conversation continuity
- **AGENTS.md Integration** - Use `# documentation requests` to auto-generate and maintain project documentation

## Installation

```bash
npm install -g yuuka
```

After installation, run:
- `yuuka`

### Windows Notes

- Install Git for Windows to provide a Bash (Unix‑like) environment: https://git-scm.com/download/win
  - YUUKA automatically prefers Git Bash/MSYS or WSL Bash when available.
  - If neither is available, it will fall back to your default shell, but many features work best with Bash.
- Use VS Code’s integrated terminal rather than legacy Command Prompt (cmd):
  - Better font rendering and icon support.
  - Fewer path and encoding quirks compared to cmd.
  - Select “Git Bash” as the VS Code terminal shell when possible.
- Optional: If you install globally via npm, avoid spaces in the global prefix path to prevent shim issues.
  - Example: `npm config set prefix "C:\\npm"` and reinstall global packages.

## Usage

### Interactive Mode
Start an interactive session:
```bash
yuuka
```

### Non-Interactive Mode
Get a quick response:
```bash
yuuka -p "explain this function" path/to/file.js
```

### Using the @ Mention System

YUUKA supports a powerful @ mention system for intelligent completions:

#### Specialized Agent Delegation
```bash
# Delegate tasks to specialized subagents
@run-agent-simplicity-auditor Review this code for over-engineering
@run-agent-architect Design a microservices architecture for this system
@run-agent-test-writer Create comprehensive tests for these modules
```

#### Smart File References
```bash
# Reference files and directories with auto-completion
@src/components/Button.tsx
@README.md
@.env.example
```

The @ mention system provides intelligent completions as you type, showing available agents and files.

### AGENTS.md Memory

Use `/memory` to append today's summary + your preferences into `AGENTS.md`.

### Configuration

- Config file: `./.gemini/settings.json` (project-only)
- Data dir: `~/.gemini/yuuka/`
- Set `baseUrl/apiKey/model` in `/config`; `/model <name>` writes to the project settings
- Default model: `models/gemini-3-flash-preview` (optional `models/gemini-3-pro-preview`)

Minimal `./.gemini/settings.json` example:
```json
{
  "security": {
    "auth": {
      "geminiApi": {
        "baseUrl": "https://generativelanguage.googleapis.com",
        "apiKey": "YOUR_KEY",
        "apiKeyAuthMode": "bearer"
      },
      "selectedType": "gemini-api-key"
    }
  },
  "model": { "name": "models/gemini-3-flash-preview" }
}
```

### Commands

- `/config` - Open configuration panel
- `/model` - Choose/set model (Gemini)
- `/auth` - Set Gemini Base URL / API Key
- `/agents` - Manage agents
- `/mcp` - Manage MCP
- `/clear` - Clear conversation
- `/compact` - Compact and continue
- `/resume` - Resume last session
- `/memory` - Append today's summary into AGENTS.md

## Multi-Model Intelligent Collaboration

> Note: The chapter below is legacy documentation. This version is Gemini-only; content will be updated.

Unlike official Claude which supports only a single model, YUUKA implements **true multi-model collaboration**, allowing you to fully leverage the unique strengths of different AI models.

### Core Technical Architecture

#### 1. **ModelManager Multi-Model Manager**
We designed a unified `ModelManager` system that supports:
- **Model Profiles**: Each model has an independent configuration file containing API endpoints, authentication, context window size, cost parameters, etc.
- **Model Pointers**: Users can configure default models for different purposes in the `/model` command:
  - `main`: Default model for main Agent
  - `task`: Default model for SubAgent
  - `reasoning`: Reserved for future ThinkTool usage
  - `quick`: Fast model for simple NLP tasks (security identification, title generation, etc.)

#### 2. **TaskTool Intelligent Task Distribution**
Our specially designed `TaskTool` implements:
- **Subagent Mechanism**: Can launch multiple sub-agents to process tasks in parallel
- **Model Parameter Passing**: Users can specify which model SubAgents should use in their requests
- **Default Model Configuration**: SubAgents use the model configured by the `task` pointer by default

#### Intelligent Work Allocation Strategy

**Architecture Design Phase**
- Use **o3 model** or **GPT-5 model** to explore system architecture and formulate sharp and clear technical solutions
- These models excel in abstract thinking and system design

**Solution Refinement Phase**
- Use **gemini model** to deeply explore production environment design details
- Leverage its deep accumulation in practical engineering and balanced reasoning capabilities

**Code Implementation Phase**
- Use **Qwen Coder model**, **Kimi k2 model**, **GLM-4.5 model**, or **Claude Sonnet 4 model** for specific code writing
- These models have strong performance in code generation, file editing, and engineering implementation
- Support parallel processing of multiple coding tasks through subagents

#### Practical Application Scenarios

```bash
# Example 1: Architecture Design
"Use o3 model to help me design a high-concurrency message queue system architecture"

# Example 2: Multi-Model Collaboration
"First use GPT-5 model to analyze the root cause of this performance issue, then use Claude Sonnet 4 model to write optimization code"

# Example 3: Parallel Task Processing
"Use Qwen Coder model as subagent to refactor these three modules simultaneously"

# Example 5: Code Review
"Have Kimi k2 model review the code quality of this PR"

# Example 6: Complex Reasoning
"Use Grok 4 model to help me derive the time complexity of this algorithm"

# Example 7: Solution Design
"Have GLM-4.5 model design a microservice decomposition plan"
```

### Key Implementation Mechanisms

#### **Configuration System**
```typescript
// Example of multi-model configuration support
{
  "modelProfiles": {
    "o3": { "provider": "openai", "model": "o3", "apiKey": "..." },
    "claude4": { "provider": "anthropic", "model": "claude-sonnet-4", "apiKey": "..." },
    "qwen": { "provider": "alibaba", "model": "qwen-coder", "apiKey": "..." }
  },
  "modelPointers": {
    "main": "claude4",      // Main conversation model
    "task": "qwen",         // Task execution model
    "reasoning": "o3",      // Reasoning model
    "quick": "glm-4.5"      // Quick response model
  }
}
```

#### **Cost Tracking System**
- **Usage Statistics**: Use `/cost` command to view token usage and costs for each model
- **Multi-Model Cost Comparison**: Track usage costs of different models in real-time
- **History Records**: Save cost data for each session

#### **Context Manager**
- **Context Window Adaptation**: Automatically adjust based on different models' context window sizes
- **Session State Preservation**: Ensure information consistency during multi-model collaboration

### Advantages of Multi-Model Collaboration

1. **Maximized Efficiency**: Each task is handled by the most suitable model
2. **Cost Optimization**: Use lightweight models for simple tasks, powerful models for complex tasks
3. **Parallel Processing**: Multiple models can work on different subtasks simultaneously
4. **Leveraging Strengths**: Combine advantages of different models for optimal overall results

### Comparison with Official Implementation

| Feature | YUUKA | Official Claude |
|---------|------|-----------------|
| Number of Supported Models | Unlimited, configurable for any model | Only supports single Claude model |
| Parallel Processing | Multiple SubAgents work in parallel | Single-threaded processing |
| Cost Tracking | Separate statistics for multiple models | Single model cost |
| Task Model Configuration | Different default models for different purposes | Same model for all tasks |

This multi-model collaboration capability makes YUUKA a true **AI Development Workbench**, not just a single AI assistant.

## Development

YUUKA is built with modern tools and requires Node.js (>=20) for development.

### Setup Development Environment

```bash
# Clone the repository
git clone https://github.com/shareAI-lab/yuuka.git
cd yuuka

# Install dependencies
npm install

# Run in development mode
npm run dev
```

### Build

```bash
npm run build
```

### Testing

```bash
# Run tests
npm run test

# Test the CLI
./cli.cjs --help
```

## License

Apache 2.0 License - see [LICENSE](LICENSE) for details.

## Thanks

- Some code from @dnakov's anonkode
- Some UI learned from gemini-cli  
- Some system design learned from claude code

## Support

- [Report Issues](https://github.com/shareAI-lab/yuuka/issues)
- [Discussions](https://github.com/shareAI-lab/yuuka/discussions)
