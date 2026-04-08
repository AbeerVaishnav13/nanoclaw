/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Three auth modes:
 *   API key:  Proxy injects x-api-key on every request (Anthropic default).
 *   Bearer:   Proxy injects Authorization: Bearer on every request.
 *             Used for third-party Anthropic-compatible APIs (e.g. Z.AI)
 *             that use Bearer token auth instead of x-api-key.
 *             Enable by setting ZAI_API_KEY (and ANTHROPIC_BASE_URL) in .env.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'bearer' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const OPENROUTER_URL = new URL('https://openrouter.ai/api');

/** Check if a model name is an OpenRouter namespaced model (contains '/'). */
function isOpenRouterModel(model: string | undefined): boolean {
  return !!model && model.includes('/');
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ZAI_API_KEY',
    'OPENROUTER_API_KEY',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY
    ? 'api-key'
    : secrets.ZAI_API_KEY
      ? 'bearer'
      : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const defaultUpstream = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const defaultIsHttps = defaultUpstream.protocol === 'https:';

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Try to extract model from request body for routing
        let model: string | undefined;
        try {
          const parsed = JSON.parse(body.toString());
          model = parsed.model;
        } catch {
          // Non-JSON or malformed — fall through to default upstream
        }

        const useOpenRouter =
          isOpenRouterModel(model) && !!secrets.OPENROUTER_API_KEY;

        // Return 503 if model needs OpenRouter but key is not configured
        if (isOpenRouterModel(model) && !secrets.OPENROUTER_API_KEY) {
          logger.warn(
            { model },
            'OpenRouter model requested but OPENROUTER_API_KEY not set',
          );
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error:
                'OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env to use OpenRouter models.',
            }),
          );
          return;
        }

        const upstreamUrl = useOpenRouter ? OPENROUTER_URL : defaultUpstream;
        const isHttps = useOpenRouter ? true : defaultIsHttps;
        const makeReq = isHttps ? httpsRequest : httpRequest;

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (useOpenRouter) {
          // OpenRouter: Bearer auth with OpenRouter API key
          delete headers['x-api-key'];
          delete headers['authorization'];
          headers['authorization'] = `Bearer ${secrets.OPENROUTER_API_KEY}`;
        } else if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request (Anthropic)
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else if (authMode === 'bearer') {
          // Bearer mode: inject Authorization: Bearer on every request.
          // Used for third-party APIs (e.g. Z.AI) that use Bearer auth.
          delete headers['x-api-key'];
          delete headers['authorization'];
          headers['authorization'] = `Bearer ${secrets.ZAI_API_KEY}`;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        // Prepend the base URL path (e.g. /api/anthropic or /api) to the request path
        const basePath = upstreamUrl.pathname.replace(/\/+$/, '');
        const fullPath = basePath + req.url;

        const upstream = makeReq(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: fullPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, openRouter: !!secrets.OPENROUTER_API_KEY },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'ZAI_API_KEY']);
  return secrets.ANTHROPIC_API_KEY
    ? 'api-key'
    : secrets.ZAI_API_KEY
      ? 'bearer'
      : 'oauth';
}
