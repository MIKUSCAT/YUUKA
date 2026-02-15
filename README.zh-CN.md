<p align="center">
  <img src="./YUUKA.jpeg" width="180" alt="YUUKA" />
</p>

<h1 align="center">
  𝐘 𝐔 𝐔 𝐊 𝐀
</h1>

<p align="center">
  <em>你的终端，你做主。一个先思考再行动的 AI Agent。</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/yuuka"><img src="https://badge.fury.io/js/yuuka.svg" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-4a86c8.svg" alt="License" /></a>
  <img src="https://img.shields.io/node/v/yuuka?color=4a86c8" alt="node version" />
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

<br/>

<p align="center">
  <img width="90%" alt="YUUKA 终端 AI Agent" src="./screenshots/showcase.png" />
</p>

---

## YUUKA 是什么？

YUUKA 是一个基于 Gemini 驱动的编程 Agent，运行在你的终端中。她能阅读代码库、编辑文件、执行命令、委托子 Agent，并跨会话记忆上下文——全部通过自然语言完成。

为偏爱命令行的开发者而生。

## 功能特性

**核心能力**
- Gemini 原生——直接调用 API，无中间层
- 读写和重构代码，提供上下文感知的建议
- 实时运行 shell 命令并查看结果
- 通过 `MemoryRead` / `MemoryWrite` 实现跨会话持久记忆

**Agent 系统**
- 使用 `@run-agent-name` 将任务委托给专门的子 Agent
- 并行任务执行，分组树状进度显示
- 自定义 Agent：放入 `.yuuka/agents/`（项目级或全局）
- MCP 集成，连接外部工具服务器

**智能补全**
- 模糊匹配，支持连字符识别和缩写
- 上下文感知的 `@` 前缀自动补全
- 500+ Unix 命令与系统 PATH 取交集

**用户体验**
- 基于 React/Ink 的交互式终端 UI
- `Ctrl+G` 打开外部编辑器，关闭后内容自动回填
- `Shift+Enter` 换行，`Enter` 提交

## 快速开始

```bash
npm install -g yuuka
yuuka                    # 首次运行：使用 /auth 设置 API Key 或 Google OAuth Client
```

## 使用方法

```bash
# 交互模式
yuuka

# 单次执行
yuuka -p "解释这个函数" path/to/file.js

# 委托给 Agent
@run-agent-simplicity-auditor 审查这段代码是否过度工程化
@run-agent-architect 为这个系统设计微服务架构

# 直接引用文件
@src/components/Button.tsx  解释这个组件
```

### 命令列表

| 命令       | 说明                     |
| ---------- | ------------------------ |
| `/config`  | 打开配置面板             |
| `/model`   | 选择 / 设置模型          |
| `/auth`    | 设置 Gemini Base URL / API Key / Google OAuth |
| `/agents`  | 管理 Agent               |
| `/mcp`     | 管理 MCP 服务器          |
| `/clear`   | 清空对话                 |
| `/compact` | 压缩上下文并继续         |
| `/resume`  | 恢复上次会话             |
| `/memory`  | 更新用户偏好记忆文件     |

## 配置

配置文件：`./.yuuka/settings.json` &nbsp;|&nbsp; 数据目录：`~/.yuuka/data/`

```json
{
  "security": {
    "auth": {
      "geminiApi": {
        "baseUrl": "https://generativelanguage.googleapis.com",
        "apiKey": "YOUR_KEY",
        "apiKeyAuthMode": "bearer"
      },
      "geminiCliOAuth": {
        "clientId": "YOUR_GOOGLE_OAUTH_CLIENT_ID",
        "clientSecret": "YOUR_GOOGLE_OAUTH_CLIENT_SECRET"
      },
      "selectedType": "gemini-api-key"
    }
  },
  "model": { "name": "models/gemini-3-flash-preview" }
}
```

使用 `/config` 交互式配置，或 `/model <name>` 切换模型。
默认：`models/gemini-3-flash-preview`——可选 `models/gemini-3-pro-preview`。

关于 `/auth` 的 Google OAuth：
- 当 `clientId/clientSecret` 为空时，YUUKA 会自动写入默认 Gemini CLI OAuth Client。
- 如果出现 `401`，请改用你自己在 Google Cloud Console 创建的 OAuth Client。

## 截图

<p align="center">
  <img width="90%" alt="YUUKA 深度研究" src="./screenshots/deep-research.png" />
</p>

<p align="center">
  <em>深度研究：并行 Agent 执行与树状进度显示</em>
</p>

## Windows 说明

- 安装 [Git for Windows](https://git-scm.com/download/win)——YUUKA 自动检测 Git Bash / MSYS / WSL。
- 推荐：VS Code 集成终端，选择 Git Bash 作为默认 Shell。
- 可选：避免 npm 全局 prefix 含空格：
  ```bash
  npm config set prefix "C:\npm"
  ```

## 安全

YUUKA 默认以 **YOLO 模式** 运行——所有工具调用自动批准，追求最大心流。处理敏感项目时：

```bash
yuuka --safe
```

该模式对每次工具调用都需要手动确认。

## 架构

```
cli.tsx  →  REPL.tsx  →  query.ts  →  llm.ts  →  gemini/query.ts
                ↓
          processUserInput
          /command  │  plain text
```

- **配置** — `./.yuuka/settings.json`
- **工具** — `src/tools/*` + 权限系统
- **Agent** — `./.yuuka/agents/` + `~/.yuuka/agents/`
- **提示词** — `src/services/llm/systemPrompt.ts`

## 开发

需要 Node.js >= 20。

```bash
git clone https://github.com/MIKUSCAT/YUUKA.git
cd YUUKA
npm install
npm run dev       # 开发模式
npm run build     # 生产构建
npm run typecheck # 类型检查
```

## 致谢

- 部分代码来自 [@dnakov](https://github.com/dnakov) 的 anonkode
- 部分代码来自 [Kode](https://github.com/shareAI-lab/kode)
- UI 灵感来自 [gemini-cli](https://github.com/google-gemini/gemini-cli)
- 系统设计参考了 [Claude Code](https://github.com/anthropics/claude-code)

## 许可证

Apache 2.0 — 详见 [LICENSE](LICENSE)。

## 支持

- [报告问题](https://github.com/MIKUSCAT/YUUKA/issues)
- [讨论](https://github.com/MIKUSCAT/YUUKA/discussions)
