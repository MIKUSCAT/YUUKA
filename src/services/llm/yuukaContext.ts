import { getProjectDocs } from '@context'
import { debug as debugLogger } from '@utils/debugLogger'

class YuukaContextManager {
  private static instance: YuukaContextManager
  private projectDocsCache = ''
  private cacheInitialized = false
  private initPromise: Promise<void> | null = null

  private constructor() {}

  public static getInstance(): YuukaContextManager {
    if (!YuukaContextManager.instance) {
      YuukaContextManager.instance = new YuukaContextManager()
    }
    return YuukaContextManager.instance
  }

  public async initialize(): Promise<void> {
    if (this.cacheInitialized) {
      return
    }
    if (this.initPromise) {
      await this.initPromise
      return
    }
    this.initPromise = this.loadProjectDocs()
    await this.initPromise
  }

  public getYuukaContext(): string {
    if (!this.cacheInitialized) {
      this.initialize().catch(console.warn)
      return ''
    }
    return this.projectDocsCache
  }

  public async refreshCache(): Promise<void> {
    this.cacheInitialized = false
    this.initPromise = null
    await this.initialize()
  }

  private async loadProjectDocs(): Promise<void> {
    try {
      const projectDocs = await getProjectDocs()
      this.projectDocsCache = projectDocs || ''
      this.cacheInitialized = true

      if (process.env.NODE_ENV === 'development') {
        debugLogger.info('YUUKA_CONTEXT_LOADED', {
          characters: this.projectDocsCache.length,
        })
      }
    } catch (error) {
      console.warn('[YuukaContext] Failed to load project docs:', error)
      this.projectDocsCache = ''
      this.cacheInitialized = true
    }
  }
}

const yuukaContextManager = YuukaContextManager.getInstance()
yuukaContextManager.initialize().catch(console.warn)

export const generateYuukaContext = (): string => {
  return yuukaContextManager.getYuukaContext()
}

export const refreshYuukaContext = async (): Promise<void> => {
  await yuukaContextManager.refreshCache()
}
