# YUUKA - 终端个人电脑 Agent

[![npm version](https://badge.fury.io/js/yuuka.svg)](https://www.npmjs.com/package/yuuka)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[English](README.md)

## 🎉 重磅消息：我们已切换至 Apache 2.0 开源协议！

**开发者社区的福音来了！** 为了推动 AI 智能体技术的民主化进程，构建充满活力的创新生态，我们激动地宣布：YUUKA 已正式从 AGPLv3 协议升级为 **Apache 2.0 开源协议**。

### 这对您意味着什么：
- ✅ **完全自由**：在任何项目中使用 YUUKA - 无论是个人项目、商业产品还是企业方案
- ✅ **无障碍创新**：构建专有解决方案，无需开源您的代码
- ✅ **极简要求**：仅需保留版权声明和许可信息
- ✅ **共创未来**：与全球开发者一起，加速世界向 AI 驱动生产的转型

让我们携手共建未来！🚀

## 📢 更新日志

**2025-08-29**：我们添加了 Windows 电脑的运行支持！所有的 Windows 用户现在可以使用你电脑上的 Git Bash、Unix 子系统或 WSL（Windows Subsystem for Linux）来运行 YUUKA。

YUUKA 是一个个人电脑 Agent，运行在你的终端中。它能理解你的代码库、编辑文件、运行命令，并为你处理整个工作流。

> **⚠️ 安全提示**：YUUKA 默认以 YOLO 模式运行（等同于 Claude Code 的 `--dangerously-skip-permissions` 标志），跳过所有权限检查以获得最大生产力。YOLO 模式仅建议在安全可信的环境中处理非重要项目时使用。如果您正在处理重要文件或使用能力存疑的模型，我们强烈建议使用 `yuuka --safe` 启用权限检查和手动审批所有操作。
> 
> **📊 模型性能建议**：为获得最佳体验，建议使用专为自主任务完成设计的新一代强大模型。避免使用 GPT-4o、Gemini 2.5 Pro 等较老的问答型模型，它们主要针对回答问题进行优化，而非持续的独立任务执行。请选择专门训练用于智能体工作流和扩展推理能力的模型。
>
> **🧭 本版本说明（Gemini-only）**：只使用 Gemini 原生 API（`Authorization: Bearer <apiKey>`）。配置只放在当前项目 `./.gemini/settings.json`（不再合并全局）。

## 技术蓝图

- 入口：`src/entrypoints/cli.tsx` → `src/screens/REPL.tsx`
- 输入流：`processUserInput` 分发 `/command` 或普通输入 → `query` → `services/gemini/query.ts`
- 配置：仅项目 `./.gemini/settings.json`（auth/model/mcp）；数据目录 `~/.gemini/yuuka/`
- 工具：`src/tools/*` + 权限系统；Bash 仅供模型调用（无手动 Bash 模式）
- 扩展：`./.gemini/agents/` + `~/.gemini/agents/`，MCP 通过 `mcpServers`

## 功能特性

- 🤖 **AI 驱动的助手** - 使用先进的 AI 模型理解并响应你的请求
- 🔄 **Gemini 单模型** - 本版本只使用 Gemini 原生 API
- 📝 **代码编辑** - 直接编辑文件，提供智能建议和改进
- 🔍 **代码库理解** - 分析项目结构和代码关系
- 🚀 **命令执行** - 实时运行 shell 命令并查看结果
- 🛠️ **工作流自动化** - 用简单的提示处理复杂的开发任务
- 🎨 **交互式界面** - 美观的终端界面，支持语法高亮
- 🔌 **工具系统** - 可扩展的架构，为不同任务提供专门的工具
- 💾 **上下文管理** - 智能的上下文处理，保持对话连续性

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

## 多模型智能协同

> ⚠️ 下面这章是旧文档（历史功能介绍），当前版本已收敛为 Gemini-only，内容待更新。

与 CC 仅支持单一模型不同，YUUKA 实现了**真正的多模型协同工作**，让你能够充分发挥不同 AI 模型的独特优势。

### 🏗️ 核心技术架构

#### 1. **ModelManager 多模型管理器**
我们设计了统一的 `ModelManager` 系统，支持：
- **模型配置文件（Model Profiles）**：每个模型都有独立的配置文件，包含 API 端点、认证信息、上下文窗口大小、成本等参数
- **模型指针（Model Pointers）**：用户可以在 `/model` 命令中配置不同用途的默认模型：
  - `main`：主 Agent 的默认模型
  - `task`：SubAgent 的默认模型
  - `reasoning`：预留给未来 ThinkTool 使用
  - `quick`：用于简单 NLP 任务（如安全性识别、生成标题描述等）的快速模型

#### 2. **TaskTool 智能任务分发工具**
专门设计的 `TaskTool`（Architect 工具）实现了：
- **Subagent 机制**：可以启动多个子代理并行处理任务
- **模型参数传递**：用户可以在请求中指定 SubAgent 使用的模型
- **默认模型配置**：SubAgent 默认使用 `task` 指针配置的模型

#### 3. **AskExpertModel 专家咨询工具**
我们专门设计了 `AskExpertModel` 工具：
- **专家模型调用**：允许在对话中临时调用特定的专家模型解决疑难问题
- **模型隔离执行**：专家模型的响应独立处理，不影响主对话流程
- **知识整合**：将专家模型的见解整合到当前任务中

#### 🔄 智能的工作分配策略

**架构设计阶段**
- 使用 **o3 模型** 或 **GPT-5 模型** 探讨系统架构，制定犀利明确的技术方案
- 这些模型在抽象思维和系统设计方面表现卓越

**方案细化阶段**
- 使用 **gemini 模型** 深入探讨生产环境的设计细节
- 利用其在实际工程实践中的深厚积累和平衡的推理能力

**代码实现阶段**
- 使用 **Qwen Coder 模型**、**Kimi k2 模型** 、**GLM-4.5 模型** 或 **Claude Sonnet 4 模型** 进行具体的代码编写
- 这些模型在代码生成、文件编辑和工程实现方面性能强劲
- 支持通过 subagent 并行处理多个编码任务

**疑难问题解决**
- 遇到复杂问题时，可单独咨询 **o3 模型**、**Claude Opus 4.1 模型** 或 **Grok 4 模型** 等专家模型
- 获得深度的技术见解和创新的解决方案

#### 💡 实际应用场景

```bash
# 示例 1：架构设计
"用 o3 模型帮我设计一个高并发的消息队列系统架构"

# 示例 2：多模型协作
"先用 GPT-5 模型分析这个性能问题的根本原因，然后用 Claude Sonnet 4 模型编写优化代码"

# 示例 3：并行任务处理
"用 Qwen Coder 模型作为 subagent 同时重构这三个模块"

# 示例 4：专家咨询
"这个内存泄漏问题很棘手，单独问问 Claude Opus 4.1 模型有什么解决方案"

# 示例 5：代码审查
"让 Kimi k2 模型审查这个 PR 的代码质量"

# 示例 6：复杂推理
"用 Grok 4 模型帮我推导这个算法的时间复杂度"

# 示例 7：方案设计
"让 GLM-4.5 模型设计微服务拆分方案"
```

### 🛠️ 关键实现机制

#### **配置系统（Configuration System）**
```typescript
// 支持多模型配置的示例
{
  "modelProfiles": {
    "o3": { "provider": "openai", "model": "o3", "apiKey": "..." },
    "claude4": { "provider": "anthropic", "model": "claude-sonnet-4", "apiKey": "..." },
    "qwen": { "provider": "alibaba", "model": "qwen-coder", "apiKey": "..." }
  },
  "modelPointers": {
    "main": "claude4",      // 主对话模型
    "task": "qwen",         // 任务执行模型
    "reasoning": "o3",      // 推理模型
    "quick": "glm-4.5"      // 快速响应模型
  }
}
```

#### **成本追踪系统（Cost Tracking）**
- **使用统计**：`/cost` 命令查看各模型的 token 使用量和花费
- **多模型成本对比**：实时追踪不同模型的使用成本
- **历史记录**：保存每个会话的成本数据

#### **上下文管理器（Context Manager）**
- **上下文窗口适配**：根据不同模型的上下文窗口大小自动调整
- **会话状态保持**：确保多模型协作时的信息一致性

### 🚀 多模型协同的优势

1. **效率最大化**：每个任务都由最适合的模型处理
2. **成本优化**：简单任务用轻量模型，复杂任务用强大模型
3. **并行处理**：多个模型可以同时处理不同的子任务
4. **取长补短**：结合不同模型的优势，获得最佳的整体效果

### 📊 与官方实现的对比

| 特性 | YUUKA | 官方 CC |
|------|------|---------|
| 支持模型数量 | 无限制，可配置任意模型 | 仅支持单一 Claude 模型 |
| 并行处理 | ✅ 多个 SubAgent 并行工作 | ❌ 单线程处理 |
| 成本追踪 | ✅ 多模型成本分别统计 | ❌ 单一模型成本 |
| 任务模型配置 | ✅ 不同用途配置不同默认模型 | ❌ 所有任务用同一模型 |
| 专家咨询 | ✅ AskExpertModel 工具 | ❌ 不支持 |

这种多模型协同能力让 YUUKA 成为真正的 **AI 开发工作台**，而不仅仅是一个单一的 AI 助手。

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
# 运行测试
npm run test

# 测试 CLI
./cli.cjs --help
```

## 许可证

Apache 2.0 许可证 - 详见 [LICENSE](LICENSE)。

## 支持

- 🐛 [报告问题](https://github.com/shareAI-lab/yuuka/issues)
- 💬 [讨论](https://github.com/shareAI-lab/yuuka/discussions)
