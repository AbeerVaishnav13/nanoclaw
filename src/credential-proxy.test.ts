import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy, _setOpenRouterUrl } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('routes OpenRouter models with Bearer auth and strips Anthropic headers', async () => {
    // Start a mock server to act as OpenRouter
    let openRouterHeaders: http.IncomingHttpHeaders = {};
    const openRouterServer = http.createServer((req, res) => {
      openRouterHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      openRouterServer.listen(0, '127.0.0.1', resolve),
    );
    const orPort = (openRouterServer.address() as AddressInfo).port;

    // Override OPENROUTER_URL to point at our mock server
    _setOpenRouterUrl(new URL(`http://127.0.0.1:${orPort}`));

    try {
      proxyPort = await startProxy({
        ZAI_API_KEY: 'zai-key',
        OPENROUTER_API_KEY: 'or-key',
      });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'anthropic-beta': 'context-management-2025-06-27',
            'anthropic-version': '2023-06-01',
            'x-api-key': 'placeholder',
          },
        },
        JSON.stringify({ model: 'google/gemma-4-31b-it:free', messages: [] }),
      );

      // Should use Bearer auth with OpenRouter key
      expect(openRouterHeaders['authorization']).toBe('Bearer or-key');
      // Should strip Anthropic-specific headers
      expect(openRouterHeaders['x-api-key']).toBeUndefined();
      expect(openRouterHeaders['anthropic-beta']).toBeUndefined();
      expect(openRouterHeaders['anthropic-version']).toBeUndefined();
    } finally {
      _setOpenRouterUrl(null);
      await new Promise<void>((r) => openRouterServer.close(() => r()));
    }
  });

  it('non-OpenRouter model routes to default upstream when OPENROUTER_API_KEY is set', async () => {
    proxyPort = await startProxy({
      ZAI_API_KEY: 'zai-key',
      OPENROUTER_API_KEY: 'or-key',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({ model: 'glm-5-turbo', messages: [] }),
    );

    // Non-OpenRouter model should route to default upstream with Z.AI bearer auth
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer zai-key');
    expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
  });

  it('returns 503 when OpenRouter model requested but no key set', async () => {
    proxyPort = await startProxy({ ZAI_API_KEY: 'zai-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({ model: 'google/gemma-4-31b-it:free', messages: [] }),
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toContain('OPENROUTER_API_KEY');
  });

  it('passes Anthropic image blocks through unchanged for OpenRouter', async () => {
    let openRouterBody = '';
    const openRouterServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        openRouterBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) =>
      openRouterServer.listen(0, '127.0.0.1', resolve),
    );
    const orPort = (openRouterServer.address() as AddressInfo).port;

    _setOpenRouterUrl(new URL(`http://127.0.0.1:${orPort}`));

    try {
      proxyPort = await startProxy({
        ZAI_API_KEY: 'zai-key',
        OPENROUTER_API_KEY: 'or-key',
      });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          model: 'google/gemma-4-31b-it:free',
          context_management: { foo: 'bar' },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: 'abc123',
                  },
                },
                { type: 'text', text: 'What is in this image?' },
              ],
            },
          ],
        }),
      );

      const parsed = JSON.parse(openRouterBody);
      const content = parsed.messages[0].content;
      // Image block should pass through in Anthropic format (not converted)
      expect(content[0]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
      });
      // Text block should be unchanged
      expect(content[1]).toEqual({
        type: 'text',
        text: 'What is in this image?',
      });
      // context_management should be stripped
      expect(parsed.context_management).toBeUndefined();
    } finally {
      _setOpenRouterUrl(null);
      await new Promise<void>((r) => openRouterServer.close(() => r()));
    }
  });

  it('converts Anthropic thinking to OpenRouter reasoning format', async () => {
    let openRouterBody = '';
    const openRouterServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        openRouterBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) =>
      openRouterServer.listen(0, '127.0.0.1', resolve),
    );
    const orPort = (openRouterServer.address() as AddressInfo).port;

    _setOpenRouterUrl(new URL(`http://127.0.0.1:${orPort}`));

    try {
      proxyPort = await startProxy({
        ZAI_API_KEY: 'zai-key',
        OPENROUTER_API_KEY: 'or-key',
      });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          model: 'google/gemma-4-31b-it:free',
          thinking: { type: 'enabled', budget_tokens: 10000 },
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      );

      const parsed = JSON.parse(openRouterBody);
      // Anthropic thinking should be stripped
      expect(parsed.thinking).toBeUndefined();
      // OpenRouter reasoning should be added
      expect(parsed.reasoning).toEqual({ enabled: true });
    } finally {
      _setOpenRouterUrl(null);
      await new Promise<void>((r) => openRouterServer.close(() => r()));
    }
  });

  it('falls through to default upstream on unparseable body', async () => {
    proxyPort = await startProxy({
      ZAI_API_KEY: 'zai-key',
      OPENROUTER_API_KEY: 'or-key',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      'not json',
    );

    // Should route to default upstream (Z.AI bearer mode)
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer zai-key');
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });
});
