import { memoize } from 'lodash-es'

export const getCodeStyle = memoize((): string => {
  // 项目级 AGENTS/CLAUDE 样式注入已移除
  return ''
})
