export const DESCRIPTION = '将重要信息持久化到记忆存储中'

export const PROMPT = `使用 MemoryWrite 保存需要跨会话记住的信息。

何时写入：
- 用户明确表达偏好时（例如“我喜欢…”、“以后都…”、“记住…”）
- 做出重要的架构/技术决策时
- 发现项目关键知识时（如特殊构建流程、部署方式）
- 用户纠正你的行为时（说明希望你以后怎么做）

何时不写入：
- 临时性、一次性的信息
- 不需要跨会话保留的信息
- 敏感信息（密码、密钥、令牌等）

写入规范：
- file_path 使用有意义的名字（如 preferences.md、decisions.md）
- 内容使用 Markdown，简洁、可回读
- 优先“更新已有内容”，不要无脑追加重复段落
- 可以补充 title / tags / summary / layer，提升后续检索质量
- layer 建议：core（核心偏好）、retrievable（可检索知识）、episodic（临时情景）
- 用户偏好主档 \`YUUKA.md\` 通常由 \`/memory\` 手动维护，除非用户明确要求你直接改`
