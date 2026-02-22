export const DESCRIPTION = '按查询检索记忆索引，返回最相关的 1-3 条候选'

export const PROMPT = `使用 MemorySearch 在大量记忆中先定位候选，再按需读取细节。

何时使用：
- 你知道大概主题，但不知道具体文件路径
- 用户说“之前有说过...”，需要先定位哪条记忆
- 开局索引摘要不够，需要进一步检索

用法：
- query：关键词，建议短句
- limit：返回数量，默认 3，建议 1-3
- include_archived：是否包含已归档记忆（默认 false）

建议流程：
1) 先 MemorySearch(query) 找候选
2) 再 MemoryRead(file_path) 读全文
3) 如果这条记忆确实帮上忙，MemoryRead 时加 helpful=true`
