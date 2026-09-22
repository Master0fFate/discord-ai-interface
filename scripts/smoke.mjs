import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const cli = spawnSync(process.execPath, [resolve(root, 'dist/cli.js'), '--help'], { cwd: root, encoding: 'utf8' });
if (cli.status !== 0 || !cli.stdout.includes('policy-controlled Discord administration') || cli.stderr !== '') {
  throw new Error(`CLI smoke failed (status ${String(cli.status)}): ${cli.stderr}`);
}

const directory = mkdtempSync(join(tmpdir(), 'discord-ai-mcp-smoke-'));
const policyPath = join(directory, 'policy.json');
const token = 'stdio-smoke-token';
try {
  writeFileSync(policyPath, '{"guilds":{}}', { mode: 0o600 });
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((value) => JSON.stringify(value)).join('\n') + '\n';
  const mcp = spawnSync(process.execPath, [resolve(root, 'dist/mcp.js')], {
    cwd: root, encoding: 'utf8', input,
    env: { ...process.env, DISCORD_BOT_TOKEN: token, DISCORD_AI_POLICY: policyPath, DISCORD_AI_DATA_DIR: directory, LOG_LEVEL: 'silent' },
  });
  const lines = mcp.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const tools = lines[1]?.result?.tools;
  if (mcp.status !== 0 || lines[0]?.result?.serverInfo?.name !== 'discord-ai-interface' || !Array.isArray(tools) || tools.some((tool) => tool.name === 'discord_request')) {
    throw new Error(`MCP stdio smoke failed (status ${String(mcp.status)}): ${mcp.stderr}`);
  }
  if (`${mcp.stdout}\n${mcp.stderr}`.includes(token)) throw new Error('MCP stdio smoke exposed its token');
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write('CLI and MCP stdio smoke checks passed.\n');
