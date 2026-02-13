export const DESCRIPTION =
  '读取记忆存储中的信息（用户偏好、项目知识、历史决策等）'

export const PROMPT = `使用 MemoryRead 在开始任务前回忆相关的上下文信息。

何时使用：
- 开始新对话时，检查是否有关于当前项目/用户的已存记忆
- 处理任务前，查看是否有相关的历史决策或偏好
- 用户提到“之前”、“上次”、“记得”等词时

用法：
- 不带参数：优先读取用户偏好主档 YUUKA.md，并列出当前可读文件
- 带 file_path：读取特定记忆文件

记忆目录结构（示例）：
- YUUKA.md — 用户偏好主档（手动 /memory 维护）
- decisions.md — 重要历史决策
- knowledge/ — 项目相关知识`
