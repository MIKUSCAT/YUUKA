import { createRequire } from 'module'

const require = createRequire(import.meta.url)
let pkg: { version?: string } = {}
try {
  // src/constants/macros.ts（源码运行）
  pkg = require('../../package.json')
} catch {
  try {
    // dist/...（打包/发布后运行）
    pkg = require('../package.json')
  } catch {
    pkg = {}
  }
}

export const MACRO = {
  VERSION: pkg.version ?? '',
  README_URL: '',
  PACKAGE_URL: 'yuuka',
  ISSUES_EXPLAINER: 'report the issue in your repository issues',
}
