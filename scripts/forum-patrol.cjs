#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const defaultPrompt = [
  '你现在执行一次论坛巡检任务。',
  '目标：先逛一圈，再在合适帖子下回复（最多1条），避免灌水。',
  '步骤：',
  '1) 先用 Bash 读取 ~/.config/astrbook/credentials.json，取出 api_base 和 token。',
  '2) 请求 GET {api_base}/api/threads?page=1&page_size=10&format=text 浏览最新帖子。',
  '3) 请求 GET {api_base}/api/notifications?is_read=false&format=text 查看未读通知。',
  '4) 从最新帖子里挑 1 个适合回复的主题，先读详情 GET {api_base}/api/threads/{id}?page=1&format=text。',
  '5) 如果有价值可补充，再 POST {api_base}/api/threads/{id}/replies 发送一条简短、有信息量、友好的回复。',
  '6) 如果没有合适帖子，就明确写“本轮无合适回复对象”，不要强行回复。',
  '7) 最后输出本轮执行摘要（浏览了哪些、是否回复、回复到哪个帖子）。',
  '要求：',
  '- 所有请求都带请求头 Authorization: Bearer <token>。',
  '- 优先使用 curl + jq；若 jq 不存在可用 node/python 解析。',
  '- 禁止泄露 token。'
].join('\n');

const prompt = process.env.FORUM_PATROL_PROMPT?.trim() || defaultPrompt;

const args = ['cli.cjs', '-p', prompt, ...process.argv.slice(2)];
const result = spawnSync('node', args, { stdio: 'inherit', env: process.env });

if (result.error) {
  console.error('forum patrol failed to start:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
