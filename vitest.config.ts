import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

function resolvePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url))
}

const SRC = resolvePath('./src')

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@components$/, replacement: `${SRC}/components` },
      { find: /^@components\/(.*)$/, replacement: `${SRC}/components/$1` },

      { find: /^@commands$/, replacement: `${SRC}/commands.ts` },
      { find: /^@commands\/(.*)$/, replacement: `${SRC}/commands/$1` },

      { find: /^@utils$/, replacement: `${SRC}/utils` },
      { find: /^@utils\/(.*)$/, replacement: `${SRC}/utils/$1` },

      { find: /^@constants$/, replacement: `${SRC}/constants` },
      { find: /^@constants\/(.*)$/, replacement: `${SRC}/constants/$1` },

      { find: /^@hooks$/, replacement: `${SRC}/hooks` },
      { find: /^@hooks\/(.*)$/, replacement: `${SRC}/hooks/$1` },

      { find: /^@services$/, replacement: `${SRC}/services` },
      { find: /^@services\/(.*)$/, replacement: `${SRC}/services/$1` },

      { find: /^@screens$/, replacement: `${SRC}/screens` },
      { find: /^@screens\/(.*)$/, replacement: `${SRC}/screens/$1` },

      { find: /^@tools$/, replacement: `${SRC}/tools.ts` },
      { find: /^@tools\/(.*)$/, replacement: `${SRC}/tools/$1` },

      { find: /^@tool$/, replacement: `${SRC}/Tool.ts` },

      { find: /^@kode-types$/, replacement: `${SRC}/types` },
      { find: /^@kode-types\/(.*)$/, replacement: `${SRC}/types/$1` },

      { find: /^@context$/, replacement: `${SRC}/context.ts` },
      { find: /^@context\/(.*)$/, replacement: `${SRC}/context/$1` },

      { find: /^@history$/, replacement: `${SRC}/history.ts` },
      { find: /^@costTracker$/, replacement: `${SRC}/cost-tracker.ts` },
      { find: /^@permissions$/, replacement: `${SRC}/permissions.ts` },
      { find: /^@query$/, replacement: `${SRC}/query.ts` },
      { find: /^@messages$/, replacement: `${SRC}/messages.ts` },
    ],
  },
  test: {
    environment: 'node',
  },
})

