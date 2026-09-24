import type { CreatedToken, McpConfigs } from '../api/types';

/**
 * Ready-to-paste assistant configs (SPEC §9). Core returns these with a new token; this
 * builder is the fallback when a response has none, and what the mock API uses.
 */
export function buildAgentConfigs(appUrl: string, token: string): McpConfigs {
  const base = appUrl.replace(/\/+$/, '');
  const mcpUrl = `${base}/mcp`;
  const bearer = `Bearer ${token}`;
  return {
    claudeCode: `claude mcp add --transport http witness ${mcpUrl} --header "Authorization: ${bearer}"`,
    codex: [
      '[mcp_servers.witness]',
      `url = "${mcpUrl}"`,
      `http_headers = { "Authorization" = "${bearer}" }`,
    ].join('\n'),
    json: JSON.stringify(
      { mcpServers: { witness: { type: 'http', url: mcpUrl, headers: { Authorization: bearer } } } },
      null,
      2,
    ),
    curl: `curl -s ${base}/api/v1/status \\\n  -H "Authorization: ${bearer}"`,
  };
}

/** Core's configs where it sent them, the local builder for anything missing. */
export function configsFor(created: CreatedToken, appUrl: string): McpConfigs {
  const built = buildAgentConfigs(appUrl, created.token);
  const sent = created.configs ?? {};
  return {
    claudeCode: sent.claudeCode ?? built.claudeCode,
    codex: sent.codex ?? built.codex,
    json: sent.json ?? built.json,
    curl: sent.curl ?? built.curl,
  };
}

export const CONFIG_TABS: { id: keyof McpConfigs; label: string; hint: string }[] = [
  { id: 'claudeCode', label: 'Claude Code', hint: 'Run this once in your terminal.' },
  { id: 'codex', label: 'Codex', hint: 'Add this to ~/.codex/config.toml.' },
  { id: 'json', label: 'JSON', hint: 'For assistants set up with an mcpServers file that supports HTTP servers.' },
  { id: 'curl', label: 'curl', hint: 'A quick check that the key works. It returns counts only.' },
];
