<p align="center">
  <img src="./YUUKA.jpeg" width="200" alt="YUUKA logo" />
</p>

<h1 align="center">YUUKA</h1>

<p align="center">
  A personal AI agent that lives in your terminal — powered by Gemini.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/yuuka"><img src="https://badge.fury.io/js/yuuka.svg" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/node/v/yuuka" alt="node version" />
</p>

<p align="center">
  <a href="README.zh-CN.md">中文文档</a>
</p>

<p align="center">
  <img width="90%" alt="YUUKA terminal screenshot" src="https://github.com/user-attachments/assets/fdce7017-8095-429d-b74e-07f43a6919e1" />
</p>

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Windows Notes](#windows-notes)
- [Security](#security)
- [Architecture](#architecture)
- [Development](#development)
- [Screenshots](#screenshots)
- [Acknowledgements](#acknowledgements)
- [License](#license)
- [Support](#support)

## Features

### Core

- **Gemini-native** — Uses Gemini API directly (`Authorization: Bearer <apiKey>`)
- **Code editing** — Read, write, and refactor files with intelligent suggestions
- **Codebase understanding** — Analyzes project structure and code relationships
- **Command execution** — Run shell commands and see results in real-time
- **Workflow automation** — Handle complex development tasks with simple prompts
- **Persistent memory** — `MemoryRead` / `MemoryWrite` for cross-session long-term context

### Agent System

- **Subagent delegation** — Use `@run-agent-name` to hand off tasks to specialized agents
- **Custom agents** — Drop agent definitions into `.yuuka/agents/` (project or global)
- **MCP integration** — Connect external tool servers via `mcpServers` in settings

### Smart Completion

- **Fuzzy matching** — Hyphen-aware, abbreviation-friendly (`dao` → `run-agent-dao-qi-harmony-designer`)
- **Context detection** — Auto-prefixes `@` for agents and file references
- **500+ Unix commands** — Curated list intersected with your system PATH

### UX

- **Interactive terminal UI** — Built with React/Ink, syntax highlighting included
- **External editor** — `Ctrl+G` opens your `$EDITOR`; text returns on close
- **Multiline input** — `Shift+Enter` for newlines, `Enter` to submit

## Quick Start

```bash
# 1. Install
npm install -g yuuka

# 2. Configure (on first run)
yuuka          # then use /auth to set your Gemini API key

# 3. Run
yuuka
```

## Usage

### Interactive Mode

```bash
yuuka
```

### Non-Interactive Mode

```bash
yuuka -p "explain this function" path/to/file.js
```

### @ Mention System

Delegate to subagents or reference files directly in your prompt:

```bash
# Agents
@run-agent-simplicity-auditor Review this code for over-engineering
@run-agent-architect Design a microservices architecture

# Files
@src/components/Button.tsx  Explain this component
```

### Persistent Memory

- `/memory` — Manually refresh the user preference memory file
- `MemoryRead` / `MemoryWrite` — Agent-side long-term memory tools

### Commands

| Command    | Description                        |
| ---------- | ---------------------------------- |
| `/config`  | Open configuration panel           |
| `/model`   | Choose / set model (Gemini)        |
| `/auth`    | Set Gemini Base URL / API Key      |
| `/agents`  | Manage agents                      |
| `/mcp`     | Manage MCP servers                 |
| `/clear`   | Clear conversation                 |
| `/compact` | Compact context and continue       |
| `/resume`  | Resume last session                |
| `/memory`  | Update user preference memory file |

## Configuration

Config file: `./.yuuka/settings.json` (project-level only)
Data directory: `~/.yuuka/data/`

Minimal example:

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

Use `/config` interactively, or `/model <name>` to switch models.
Default model: `models/gemini-3-flash-preview` (alternative: `models/gemini-3-pro-preview`).

## Windows Notes

- Install [Git for Windows](https://git-scm.com/download/win) for a Bash environment.
  - YUUKA automatically prefers Git Bash / MSYS or WSL Bash when available.
  - Falls back to default shell otherwise, but Bash provides the best experience.
- Recommended: Use VS Code's integrated terminal (select "Git Bash" as shell).
- Optional: Avoid spaces in the npm global prefix path to prevent shim issues.
  ```bash
  npm config set prefix "C:\npm"
  ```

## Security

YUUKA runs in **YOLO mode** by default — all tool calls are auto-approved for maximum productivity. This is convenient but bypasses permission checks.

For sensitive work, start with:

```bash
yuuka --safe
```

This enables manual approval for every tool invocation (file writes, command execution, etc.).

> **Model advice**: For best results, use models designed for agentic workflows and extended reasoning. Older Q&A-focused models may not perform well in sustained autonomous tasks.

## Architecture

```
src/entrypoints/cli.tsx  →  src/screens/REPL.tsx
                              ↓
                         processUserInput
                         /command  │  plain text
                              ↓         ↓
                          src/query.ts
                              ↓
                    src/services/llm.ts
                              ↓
                src/services/gemini/query.ts
```

- **Config**: `./.yuuka/settings.json` (auth / model / mcp)
- **Data**: `~/.yuuka/data/`
- **Tools**: `src/tools/*` with permission gating
- **Agents**: `./.yuuka/agents/` + `~/.yuuka/agents/`
- **Prompts**: `src/services/llm/systemPrompt.ts`, `src/services/llm/yuukaContext.ts`

## Development

Requires Node.js >= 20.

```bash
# Clone
git clone https://github.com/shareAI-lab/yuuka.git
cd yuuka

# Install dependencies
npm install

# Dev mode
npm run dev

# Build
npm run build

# Type check
npm run typecheck
```

## Screenshots

<details>
<summary>Click to expand</summary>

<img width="90%" alt="screenshot-1" src="https://github.com/user-attachments/assets/fdce7017-8095-429d-b74e-07f43a6919e1" />

<img width="90%" alt="screenshot-2" src="https://github.com/user-attachments/assets/f220cc27-084d-468e-a3f4-d5bc44d84fac" />

<img width="90%" alt="screenshot-3" src="https://github.com/user-attachments/assets/90ec7399-1349-4607-b689-96613b3dc3e2" />

<img width="90%" alt="screenshot-4" src="https://github.com/user-attachments/assets/b30696ce-5ab1-40a0-b741-c7ef3945dba0" />

<img width="600" alt="screenshot-5" src="https://github.com/user-attachments/assets/8b46a39d-1ab6-4669-9391-14ccc6c5234c" />

</details>

## Acknowledgements

- Some code from [@dnakov](https://github.com/dnakov)'s anonkode
- Some code from [Kode](https://github.com/shareAI-lab/kode)
- UI inspiration from [gemini-cli](https://github.com/anthropics/gemini-cli)
- System design learned from [Claude Code](https://github.com/anthropics/claude-code)

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

## Support

- [Report Issues](https://github.com/shareAI-lab/yuuka/issues)
- [Discussions](https://github.com/shareAI-lab/yuuka/discussions)
