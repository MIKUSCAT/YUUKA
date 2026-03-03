import { MACRO } from '@constants/macros'

export type ClientMetadataPlatform =
  | 'DARWIN_AMD64'
  | 'DARWIN_ARM64'
  | 'LINUX_AMD64'
  | 'LINUX_ARM64'
  | 'WINDOWS_AMD64'
  | 'PLATFORM_UNSPECIFIED'

export type ClientMetadata = {
  ideName: 'IDE_UNSPECIFIED' | string
  pluginType: 'GEMINI' | string
  ideVersion: string
  platform: ClientMetadataPlatform
  updateChannel: 'nightly' | 'preview' | 'stable' | string
}

let cached: Promise<ClientMetadata> | null = null

function getPlatform(): ClientMetadataPlatform {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin' && arch === 'x64') return 'DARWIN_AMD64'
  if (platform === 'darwin' && arch === 'arm64') return 'DARWIN_ARM64'
  if (platform === 'linux' && arch === 'x64') return 'LINUX_AMD64'
  if (platform === 'linux' && arch === 'arm64') return 'LINUX_ARM64'
  if (platform === 'win32' && arch === 'x64') return 'WINDOWS_AMD64'
  return 'PLATFORM_UNSPECIFIED'
}

function getUpdateChannelFromVersion(version: string): 'nightly' | 'preview' | 'stable' {
  const v = String(version ?? '').trim()
  if (!v || v.includes('nightly')) return 'nightly'
  if (v.includes('preview')) return 'preview'
  return 'stable'
}

export async function getClientMetadata(): Promise<ClientMetadata> {
  if (!cached) {
    cached = (async () => {
      const version = String(MACRO.VERSION ?? '').trim()
      return {
        ideName: 'IDE_UNSPECIFIED',
        pluginType: 'GEMINI',
        ideVersion: version || '0.0.0',
        platform: getPlatform(),
        updateChannel: getUpdateChannelFromVersion(version),
      }
    })()
  }
  return cached
}

