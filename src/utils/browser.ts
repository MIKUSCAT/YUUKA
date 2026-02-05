import { execFileNoThrow } from './execFileNoThrow'

export async function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform

  try {
    if (platform === 'win32') {
      // `start` 是 cmd 内置命令，不能直接 execFile('start')
      // 注意：cmd 会把 `&` 当作命令分隔符，导致 OAuth URL 被截断（进而出现 response_type 缺失等 400）。
      // 这里用 cmd 的转义规则把 `&` 变成 `^&`，避免被解析截断（也顺手转义 `^` 本身）。
      const safeUrl = url.replace(/\^/g, '^^').replace(/&/g, '^&')
      const { code } = await execFileNoThrow('cmd', ['/c', 'start', '', safeUrl])
      return code === 0
    }

    const command = platform === 'darwin' ? 'open' : 'xdg-open'
    const { code } = await execFileNoThrow(command, [url])
    return code === 0
  } catch (_) {
    return false
  }
}
