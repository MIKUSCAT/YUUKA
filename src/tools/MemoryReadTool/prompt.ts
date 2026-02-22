export const DESCRIPTION =
  '读取记忆存储中的信息（核心记忆 + 按需细节）'

export const PROMPT = `使用 MemoryRead 在开始任务前回忆相关的上下文信息。

何时使用：
- 需要读取某条记忆全文时
- 用户提到“之前”、“上次”、“记得”等词时，需要核对细节
- 通过 MemorySearch 找到候选后，继续读取具体文件

用法：
- 不带参数：返回开局必读上下文（YUUKA.md + 记忆索引摘要）
- 带 file_path：读取特定记忆文件
- 带 helpful=true：仅在这条记忆确实帮上忙时使用，会给该记忆强度 +1

记忆目录结构（示例）：
- YUUKA.md — 用户偏好主档（手动 /memory 维护）
- decisions.md — 重要历史决策（可检索记忆）
- knowledge/ — 项目相关知识（可检索记忆）
- episodic/ — 临时信息（情景记忆，可衰减归档）`
