import type { Command } from '@commands'
import { listMCPServers, getClients } from '@services/mcpClient'
import { PRODUCT_COMMAND } from '@constants/product'
import chalk from 'chalk'
import { getTheme } from '@utils/theme'

const mcp = {
  type: 'local',
  name: 'mcp',
  description: '查看 MCP 服务连接状态',
  isEnabled: true,
  isHidden: false,
  async call() {
    const servers = listMCPServers()
    const clients = await getClients()
    const theme = getTheme()

    if (Object.keys(servers).length === 0) {
      return [
        'No MCP servers configured.',
        '',
        'Quick setup (global):',
        `- ${PRODUCT_COMMAND} mcp add office-reader npx -y yuuka-mcp-office-reader`,
        `- ${PRODUCT_COMMAND} mcp add chrome-devtools npx -y chrome-devtools-mcp`,
        '',
        `Use \`${PRODUCT_COMMAND} mcp list\` to verify status after adding.`,
      ].join('\n')
    }

    // Sort servers by name and format status with colors
    const serverStatusLines = clients
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(client => {
        const isConnected = client.type === 'connected'
        const status = isConnected ? 'connected' : 'disconnected'
        const coloredStatus = isConnected
          ? chalk.hex(theme.success)(status)
          : chalk.hex(theme.error)(status)
        return `• ${client.name}: ${coloredStatus}`
      })

    return ['MCP Server Status', ...serverStatusLines].join('\n')
  },
  userFacingName() {
    return 'mcp'
  },
} satisfies Command

export default mcp
