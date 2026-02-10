// 助手消息前缀
export const ASSISTANT_PREFIX = '✦'

// 树状图符号 - 简洁拐角式（带缩进，和标题对齐）
export const TREE_BRANCH_MID = '  ├─'  // 中间连接（非末尾子项）
export const TREE_END = '  └─'         // 最后一项拐角
export const TREE_VERTICAL = '  │'     // 垂直延续线

// 兼容旧代码的别名
export const TOOL_TREE_BRANCH = TREE_BRANCH_MID
export const TOOL_TREE_END = TREE_END
export const TREE_BRANCH = TREE_BRANCH_MID

// Task 行首符号（和 Kode 一致）
export const TASK_DASH = '⎯'

// 圆点动画 Spinner（8帧，现代感）
export const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const
