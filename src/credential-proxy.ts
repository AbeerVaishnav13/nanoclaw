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

const DEFAULT_OPENROUTER_URL = new URL('https://openrouter.ai/api');
let _openRouterUrl = DEFAULT_OPENROUTER_URL;

export function getOpenRouterUrl(): URL {
  return _openRouterUrl;
}

/** @internal Test-only: override the OpenRouter URL. */
export function _setOpenRouterUrl(url: URL | null): void {
  _openRouterUrl = url ?? DEFAULT_OPENROUTER_URL;
}

/** Check if a model name is an OpenRouter namespaced model (contains '/'). */
function isOpenRouterModel(model: string | undefined): boolean {
  return !!model && model.includes('/');
}

/** Check if a model is a Claude model. */
function isClaudeModel(model: string): boolean {
  return (
    model.startsWith('anthropic/') || model.toLowerCase().includes('claude')
  );
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

        // Log raw body from SDK before any rewriting (diagnostic)
        if (useOpenRouter) {
          const rawStr = body.toString();
          const hasImage =
            rawStr.includes('"type":"image"') ||
            rawStr.includes('"type": "image"');
          logger.info(
            { hasImage, bodyLength: rawStr.length },
            'Raw body received from SDK for OpenRouter request',
          );
          if (hasImage) {
            logger.info({ body: rawStr }, 'Raw body with image blocks');
          }
        }

        // Strip Anthropic-specific body fields for OpenRouter
        let finalBody = body;
        if (useOpenRouter && model) {
          try {
            const parsed = JSON.parse(body.toString());
            delete parsed.context_management;

            // Convert Anthropic thinking to OpenRouter reasoning format
            if (parsed.thinking) {
              delete parsed.thinking;
              parsed.reasoning = { enabled: true };
            }

            const rewritten = JSON.stringify(parsed);
            finalBody = Buffer.from(rewritten);
          } catch {
            // Non-JSON — forward as-is
          }
        }

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

        const upstreamUrl = useOpenRouter
          ? getOpenRouterUrl()
          : defaultUpstream;
        const isHttps = upstreamUrl.protocol === 'https:';
        const makeReq = isHttps ? httpsRequest : httpRequest;

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': finalBody.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (useOpenRouter) {
          // OpenRouter: Bearer auth with OpenRouter API key
          delete headers['x-api-key'];
          delete headers['authorization'];
          delete headers['anthropic-beta'];
          delete headers['anthropic-version'];
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
        // Strip ?beta=true query param for OpenRouter (SDK adds it automatically)
        let reqPath = req.url || '';
        if (useOpenRouter) {
          reqPath = reqPath.replace(/[?&]beta=true/, '').replace(/\?$/, '');
        }
        const fullPath = basePath + reqPath;

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

        if (useOpenRouter) {
          logger.info(
            { body: finalBody.toString() },
            'Final body sent to OpenRouter',
          );
        }
        upstream.write(finalBody);
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
