# YUUKA - 终端个人电脑 Agent

[![npm version](https://badge.fury.io/js/yuuka.svg)](https://www.npmjs.com/package/yuuka)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[English](README.md)

## 重磅消息：我们已切换至 Apache 2.0 开源协议！

**开发者社区的福音来了！** 为了推动 AI 智能体技术的民主化进程，构建充满活力的创新生态，我们激动地宣布：YUUKA 已正式从 AGPLv3 协议升级为 **Apache 2.0 开源协议**。

### 这对您意味着什么：
- **完全自由**：在任何项目中使用 YUUKA - 无论是个人项目、商业产品还是企业方案
- **无障碍创新**：构建专有解决方案，无需开源您的代码
- **极简要求**：仅需保留版权声明和许可信息
- **共创未来**：与全球开发者一起，加速世界向 AI 驱动生产的转型

让我们携手共建未来！

## 更新日志

**2025-08-29**：我们添加了 Windows 电脑的运行支持！所有的 Windows 用户现在可以使用你电脑上的 Git Bash、Unix 子系统或 WSL（Windows Subsystem for Linux）来运行 YUUKA。

YUUKA 是一个个人电脑 Agent，运行在你的终端中。它能理解你的代码库、编辑文件、运行命令，并为你处理整个工作流。

> **安全提示**：YUUKA 默认以 YOLO 模式运行（等同于 Claude Code 的 `--dangerously-skip-permissions` 标志），跳过所有权限检查以获得最大生产力。YOLO 模式仅建议在安全可信的环境中处理非重要项目时使用。如果您正在处理重要文件或使用能力存疑的模型，我们强烈建议使用 `yuuka --safe` 启用权限检查和手动审批所有操作。
> 
> **模型性能建议**：为获得最佳体验，建议使用专为自主任务完成设计的新一代强大模型。避免使用 GPT-4o、Gemini 2.5 Pro 等较老的问答型模型，它们主要针对回答问题进行优化，而非持续的独立任务执行。请选择专门训练用于智能体工作流和扩展推理能力的模型。
>
> **本版本说明（Gemini-only）**：只使用 Gemini 原生 API（`Authorization: Bearer <apiKey>`）。配置只放在当前项目 `./.gemini/settings.json`（不再合并全局）。

## 技术蓝图

- 入口：`src/entrypoints/cli.tsx` → `src/screens/REPL.tsx`
- 输入流：`processUserInput` 分发 `/command` 或普通输入 → `query` → `services/gemini/query.ts`
- 配置：仅项目 `./.gemini/settings.json`（auth/model/mcp）；数据目录 `~/.gemini/yuuka/`
- 工具：`src/tools/*` + 权限系统；Bash 仅供模型调用（无手动 Bash 模式）
- 扩展：`./.gemini/agents/` + `~/.gemini/agents/`，MCP 通过 `mcpServers`

## 功能特性

- **AI 驱动的助手** - 使用先进的 AI 模型理解并响应你的请求
- **Gemini 单模型** - 本版本只使用 Gemini 原生 API
- **代码编辑** - 直接编辑文件，提供智能建议和改进
- **代码库理解** - 分析项目结构和代码关系
- **命令执行** - 实时运行 shell 命令并查看结果
- **工作流自动化** - 用简单的提示处理复杂的开发任务
- **交互式界面** - 美观的终端界面，支持语法高亮
- **工具系统** - 可扩展的架构，为不同任务提供专门的工具
- **上下文管理** - 智能的上下文处理，保持对话连续性

### 创作便捷
- `Ctrl+G` 将消息打开到外部编辑器（优先 `$EDITOR`/`$VISUAL`，回退 code/nano/vim/notepad），关闭后内容自动回填到终端输入框。
- `Shift+Enter` 在输入框内换行但不发送，普通 Enter 提交。

## 安装

```bash
npm install -g yuuka
```

安装后直接运行：
- `yuuka`

### Windows 提示

- 请安装 Git for Windows（包含 Git Bash 类 Unix 终端）：https://git-scm.com/download/win
  - YUUKA 会优先使用 Git Bash/MSYS 或 WSL Bash；没有时会回退到默认终端，但在 Bash 下体验更佳。
- 推荐在 VS Code 的集成终端中运行（而非系统默认的 cmd）：
  - 字体与图标显示更稳定，UI 体验更好。
  - 相比 cmd 路径/编码等兼容性问题更少。
  - 在 VS Code 终端中选择 “Git Bash” 作为默认 Shell。
- 可选：若通过 npm 全局安装，建议避免将 npm 全局 prefix 设置在含空格的路径，以免生成的可执行 shim 出现路径解析问题。
  - 示例：`npm config set prefix "C:\\npm"`，然后重新安装全局包。

## 使用方法

### 交互模式
启动交互式会话：
```bash
yuuka
```

### 非交互模式
获取快速响应：
```bash
yuuka -p "解释这个函数" 路径/到/文件.js
```

### 配置

- 配置文件：`./.gemini/settings.json`（仅项目）
- 数据目录：`~/.gemini/yuuka/`
- `/config` 设置 `baseUrl/apiKey/model`；`/model <name>` 写入项目 settings
- 默认模型：`models/gemini-3-flash-preview`（可选 `models/gemini-3-pro-preview`）

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


### 常用命令

- `/config` - 打开配置面板
- `/model` - 选择/设置模型（Gemini）
- `/auth` - 设置 Gemini Base URL / API Key
- `/agents` - 管理 agents
- `/mcp` - 管理 MCP
- `/clear` - 清空对话
- `/compact` - 压缩并继续
- `/resume` - 恢复上次会话
- `/memory` - 把今日总结写入 AGENTS.md

## 架构说明（当前版本）

当前版本以 Gemini 为唯一运行时链路，核心路径如下：

- 对话主链路：`src/query.ts` → `src/services/llm.ts` → `src/services/gemini/query.ts`
- 历史 `src/services/claude.ts` 分叉已下线，运行时统一收敛到 `src/services/llm.ts`（Gemini-only）
- Provider 校验与模型列表能力拆分到 `src/services/llm/*` 独立模块
- 系统提示词与项目上下文拼装独立到 `src/services/llm/systemPrompt.ts`、`src/services/llm/yuukaContext.ts`

如果你从旧版本升级，可把历史“多 provider 运行时”文档视为过时内容。

## 开发

YUUKA 使用现代化工具构建，开发需要 Node.js（>=20）。

### 设置开发环境

```bash
# 克隆仓库
git clone https://github.com/shareAI-lab/yuuka.git
cd yuuka

# 安装依赖
npm install

# 在开发模式下运行
npm run dev
```

### 构建

```bash
npm run build
```

### 测试

```bash
# 类型检查
npm run typecheck

# 构建校验
npm run build

# 测试 CLI
./cli.cjs --help
```

### 论坛巡检命令

执行一轮“逛论坛 + 可选回复 1 条”：

```bash
npm run forum:patrol
```

前置条件：
- 必须存在 `~/.config/astrbook/credentials.json`
- 文件格式：

```json
{
  "api_base": "https://your-astrbook-host",
  "token": "YOUR_TOKEN"
}
```

可选：
- 你可以用 `FORUM_PATROL_PROMPT` 覆盖默认巡检提示词。

### 定时巡检（每 4 小时）

工作流文件：`.github/workflows/forum-patrol.yml`

- 触发：每 4 小时一次（`cron: 0 */4 * * *`，UTC）+ 手动触发 `workflow_dispatch`
- 必需 GitHub Secrets：
  - `GEMINI_API_KEY`
  - `ASTRBOOK_API_BASE`
  - `ASTRBOOK_TOKEN`
- 可选 GitHub Secrets：
  - `GEMINI_BASE_URL`（默认 `https://generativelanguage.googleapis.com`）
  - `GEMINI_MODEL`（默认 `models/gemini-2.5-flash`）

如果缺少必需密钥，工作流会安全跳过，不会发帖/回复。

### MCP 在 GitHub 上怎么配（重点）

你本机 MCP 正常不代表 GitHub Runner 能直接用。GitHub 托管 Runner 无法直接访问你本机进程/文件。常见做法：

1. 用 `self-hosted runner`（部署在你自己的机器/VPS）复用本地 MCP。
2. 把 MCP 打包成服务/容器，在 GitHub Actions 里临时启动。
3. 用远程 MCP 服务地址，通过 GitHub Secrets 注入凭据。

### GitHub 发布前清单

推送前请检查：
- 不提交密钥：`.gemini/settings.json`、OAuth 凭据、token、本地历史。
- 不提交本地缓存/构建垃圾：`node_modules/`、`dist/`（除非你明确需要）、`.npm-cache-local/`。
- 不提交本地专用二进制（本仓库：`mcp-servers/windows-mcp/bin/`）。
- 执行：

```bash
npm run typecheck
npm run build
git status --ignored=matching
```

## 许可证

Apache 2.0 许可证 - 详见 [LICENSE](LICENSE)。

## 支持

- [报告问题](https://github.com/shareAI-lab/yuuka/issues)
- [讨论](https://github.com/shareAI-lab/yuuka/discussions)
