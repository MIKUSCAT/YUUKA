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
> **Gemini-only notice**: This version uses Gemini native API only (`Authorization: Bearer <apiKey>`). Configuration lives in the project file `./.yuuka/settings.json` (no global merge).

<img width="600" height="577" alt="image" src="https://github.com/user-attachments/assets/8b46a39d-1ab6-4669-9391-14ccc6c5234c" />

## Technical Blueprint

- UI entry: `src/entrypoints/cli.tsx` → `src/screens/REPL.tsx`
- Input flow: `processUserInput` routes `/command` or plain text → `query` → `services/gemini/query.ts`
- Config: project-only `./.yuuka/settings.json` (auth/model/mcp); data in `~/.yuuka/data/`
- Tools: `src/tools/*` with permission gating; Bash tool is agent-only (no manual bash mode)
- Extensibility: agents in `./.yuuka/agents/` and `~/.yuuka/agents/`, MCP via `mcpServers`

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

- Config file: `./.yuuka/settings.json` (project-only)
- Data dir: `~/.yuuka/data/`
- Set `baseUrl/apiKey/model` in `/config`; `/model <name>` writes to the project settings
- Default model: `models/gemini-3-flash-preview` (optional `models/gemini-3-pro-preview`)

Minimal `./.yuuka/settings.json` example:
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

## Architecture Notes (Current)

This release is Gemini-first and keeps one runtime LLM path:

- Runtime query path: `src/query.ts` → `src/services/llm.ts` → `src/services/gemini/query.ts`
- Legacy provider branches were removed from the old `src/services/claude.ts`; runtime now stays on `src/services/llm.ts` (Gemini-only)
- Provider verification helpers are now isolated under `src/services/llm/*`
- Prompt/context assembly stays in dedicated modules (`src/services/llm/systemPrompt.ts`, `src/services/llm/yuukaContext.ts`)

If you are upgrading from older YUUKA versions, treat previous multi-provider runtime docs as historical.

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
# Type check
npm run typecheck

# Build verification
npm run build

# Test the CLI
./cli.cjs --help
```

### Forum Patrol Command

Run one patrol cycle (browse + optional single reply):

```bash
npm run forum:patrol
```

Prerequisites:
- `~/.config/astrbook/credentials.json` must exist
- File format:

```json
{
  "api_base": "https://your-astrbook-host",
  "token": "YOUR_TOKEN"
}
```

Optional:
- Set `FORUM_PATROL_PROMPT` to override the default patrol prompt.

### Scheduled Forum Patrol (Every 4 Hours)

Workflow file: `.github/workflows/forum-patrol.yml`

- Trigger: every 4 hours (`cron: 0 */4 * * *`, UTC) + manual `workflow_dispatch`
- Required GitHub Secrets:
  - `GEMINI_API_KEY`
  - `ASTRBOOK_API_BASE`
  - `ASTRBOOK_TOKEN`
- Optional GitHub Secrets:
  - `GEMINI_BASE_URL` (default: `https://generativelanguage.googleapis.com`)
  - `GEMINI_MODEL` (default: `models/gemini-2.5-flash`)

If required secrets are missing, the workflow exits safely without posting.

### MCP on GitHub (Important)

Local MCP works on your machine, but GitHub-hosted runners cannot access your local processes/files directly. Use one of these patterns:

1. Self-hosted runner on your own machine/VPS, then reuse your local MCP setup.
2. Package MCP as a service/container and start it inside GitHub Actions.
3. Use a remote MCP endpoint and inject credentials via GitHub Secrets.

### GitHub Publish Hygiene Checklist

Before pushing:
- Do not commit secrets: `.yuuka/settings.json`, OAuth creds, tokens, local history.
- Do not commit local caches/build junk: `node_modules/`, `dist/` (unless intentionally required), `.npm-cache-local/`.
- Do not commit local-only binaries (for this repo: `mcp-servers/windows-mcp/bin/`).
- Run:

```bash
npm run typecheck
npm run build
git status --ignored=matching
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
