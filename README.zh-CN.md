<p align="center">
  <img src="./YUUKA.jpeg" width="200" alt="YUUKA logo" />
</p>

<h1 align="center">YUUKA</h1>

<p align="center">
  运行在终端中的个人 AI Agent —— 基于 Gemini 驱动
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/yuuka"><img src="https://badge.fury.io/js/yuuka.svg" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/node/v/yuuka" alt="node version" />
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

<p align="center">
  <img width="90%" alt="YUUKA 终端截图" src="https://github.com/user-attachments/assets/fdce7017-8095-429d-b74e-07f43a6919e1" />
</p>

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [使用方法](#使用方法)
- [配置](#配置)
- [Windows 说明](#windows-说明)
- [安全](#安全)
- [架构](#架构)
- [开发](#开发)
- [截图](#截图)
- [致谢](#致谢)
- [许可证](#许可证)
- [支持](#支持)

## 功能特性

### 核心能力

- **Gemini 原生** — 直接使用 Gemini API（`Authorization: Bearer <apiKey>`）
- **代码编辑** — 读写和重构文件，提供智能建议
- **代码库理解** — 分析项目结构和代码关系
- **命令执行** — 实时运行 shell 命令并查看结果
- **工作流自动化** — 用简单的提示处理复杂开发任务
- **持久记忆** — `MemoryRead` / `MemoryWrite` 实现跨会话长期上下文

### Agent 系统

- **子 Agent 委托** — 使用 `@run-agent-name` 将任务交给专门的子 Agent
- **自定义 Agent** — 将 Agent 定义文件放入 `.yuuka/agents/`（项目级或全局）
- **MCP 集成** — 通过 settings 中的 `mcpServers` 连接外部工具服务器

### 智能补全

- **模糊匹配** — 支持连字符识别和缩写（`dao` → `run-agent-dao-qi-harmony-designer`）
- **上下文检测** — 自动为 Agent 和文件引用添加 `@` 前缀
- **500+ Unix 命令** — 精选命令列表与系统 PATH 取交集

### 用户体验

- **交互式终端 UI** — 基于 React/Ink 构建，内置语法高亮
- **外部编辑器** — `Ctrl+G` 打开 `$EDITOR`；关闭后内容自动回填
- **多行输入** — `Shift+Enter` 换行，`Enter` 提交

## 快速开始

```bash
# 1. 安装
npm install -g yuuka

# 2. 配置（首次运行时）
yuuka          # 然后使用 /auth 设置 Gemini API Key

# 3. 启动
yuuka
```

## 使用方法

### 交互模式

```bash
yuuka
```

### 非交互模式

```bash
yuuka -p "解释这个函数" path/to/file.js
```

### @ 提及系统

在提示中直接委托给子 Agent 或引用文件：

```bash
# Agent
@run-agent-simplicity-auditor 审查这段代码是否过度工程化
@run-agent-architect 为这个系统设计微服务架构

# 文件
@src/components/Button.tsx  解释这个组件
```

### 持久记忆

- `/memory` — 手动刷新用户偏好记忆文件
- `MemoryRead` / `MemoryWrite` — Agent 侧长期记忆工具

### 命令列表

| 命令       | 说明                     |
| ---------- | ------------------------ |
| `/config`  | 打开配置面板             |
| `/model`   | 选择 / 设置模型（Gemini）|
| `/auth`    | 设置 Gemini Base URL / API Key |
| `/agents`  | 管理 Agent               |
| `/mcp`     | 管理 MCP 服务器          |
| `/clear`   | 清空对话                 |
| `/compact` | 压缩上下文并继续         |
| `/resume`  | 恢复上次会话             |
| `/memory`  | 更新用户偏好记忆文件     |

## 配置

配置文件：`./.yuuka/settings.json`（仅项目级）
数据目录：`~/.yuuka/data/`

最小示例：

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

使用 `/config` 交互式配置，或 `/model <name>` 切换模型。
默认模型：`models/gemini-3-flash-preview`（可选 `models/gemini-3-pro-preview`）。

## Windows 说明

- 安装 [Git for Windows](https://git-scm.com/download/win) 获取 Bash 环境。
  - YUUKA 会自动优先使用 Git Bash / MSYS 或 WSL Bash。
  - 没有时回退到默认终端，但 Bash 下体验最佳。
- 推荐：使用 VS Code 集成终端（选择 "Git Bash" 作为 Shell）。
- 可选：避免将 npm 全局 prefix 设在含空格的路径，以免 shim 出现路径问题。
  ```bash
  npm config set prefix "C:\npm"
  ```

## 安全

YUUKA 默认以 **YOLO 模式** 运行 — 所有工具调用自动批准，追求最大生产力。这很方便，但会跳过权限检查。

处理敏感项目时，建议使用：

```bash
yuuka --safe
```

该模式对每次工具调用（文件写入、命令执行等）都需要手动确认。

> **模型建议**：为获得最佳效果，请使用专为 Agent 工作流和扩展推理设计的模型。较老的问答型模型在持续自主任务中表现可能不佳。

## 架构

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

- **配置**：`./.yuuka/settings.json`（auth / model / mcp）
- **数据**：`~/.yuuka/data/`
- **工具**：`src/tools/*` + 权限系统
- **Agent**：`./.yuuka/agents/` + `~/.yuuka/agents/`
- **提示词**：`src/services/llm/systemPrompt.ts`、`src/services/llm/yuukaContext.ts`

## 开发

需要 Node.js >= 20。

```bash
# 克隆
git clone https://github.com/shareAI-lab/yuuka.git
cd yuuka

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 类型检查
npm run typecheck
```

## 截图

<details>
<summary>点击展开</summary>

<img width="90%" alt="截图-1" src="https://github.com/user-attachments/assets/fdce7017-8095-429d-b74e-07f43a6919e1" />

<img width="90%" alt="截图-2" src="https://github.com/user-attachments/assets/f220cc27-084d-468e-a3f4-d5bc44d84fac" />

<img width="90%" alt="截图-3" src="https://github.com/user-attachments/assets/90ec7399-1349-4607-b689-96613b3dc3e2" />

<img width="90%" alt="截图-4" src="https://github.com/user-attachments/assets/b30696ce-5ab1-40a0-b741-c7ef3945dba0" />

<img width="600" alt="截图-5" src="https://github.com/user-attachments/assets/8b46a39d-1ab6-4669-9391-14ccc6c5234c" />

</details>

## 致谢

- 部分代码来自 [@dnakov](https://github.com/dnakov) 的 anonkode
- 部分代码来自 [Kode](https://github.com/shareAI-lab/kode)
- UI 灵感来自 [gemini-cli](https://github.com/anthropics/gemini-cli)
- 系统设计参考了 [Claude Code](https://github.com/anthropics/claude-code)

## 许可证

Apache 2.0 — 详见 [LICENSE](LICENSE)。

## 支持

- [报告问题](https://github.com/shareAI-lab/yuuka/issues)
- [讨论](https://github.com/shareAI-lab/yuuka/discussions)
