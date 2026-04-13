// UAG: Unit tests for Anthropic provider headers — Bearer token auth support
import AnthropicAPIConfig from './api';
import { Options, Params } from '../../types/requestBody';
import { convertKeysToCamelCase } from '../../utils';

// UAG: Build a mock Hono Context whose req.header(name) resolves from the provided map (lowercase keys).
const makeContext = (clientHeaders: Record<string, string> = {}): any => {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(clientHeaders))
    lower[k.toLowerCase()] = clientHeaders[k];
  return {
    req: {
      header: (name?: string) => (name ? lower[name.toLowerCase()] : undefined),
    },
  };
};

describe('AnthropicAPIConfig.headers', () => {
  const callHeaders = (
    providerOptions: Partial<Options> & { provider?: string },
    gatewayRequestBody?: Partial<Params>,
    clientHeaders?: Record<string, string>
  ) => {
    const opts: Options = {
      provider: 'anthropic',
      ...providerOptions,
    };
    return AnthropicAPIConfig.headers({
      c: makeContext(clientHeaders),
      providerOptions: opts,
      fn: 'chatComplete',
      transformedRequestBody: {},
      transformedRequestUrl: '',
      gatewayRequestBody: gatewayRequestBody as Params,
    }) as Record<string, string>;
  };

  describe('AC1: OAuth token uses Authorization: Bearer header', () => {
    it('should use Authorization: Bearer when authType is oauth_token', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-oat01-test-token',
        authType: 'oauth_token',
      });

      expect(headers['Authorization']).toBe('Bearer sk-ant-oat01-test-token');
      expect(headers['X-API-Key']).toBeUndefined();
    });
  });

  describe('AC2: Default behavior uses X-API-Key (regression safety)', () => {
    it('should use X-API-Key when authType is undefined', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-api03-test-key',
      });

      expect(headers['X-API-Key']).toBe('sk-ant-api03-test-key');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should use X-API-Key when authType is empty string', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-api03-test-key',
        authType: '',
      });

      expect(headers['X-API-Key']).toBe('sk-ant-api03-test-key');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should use X-API-Key when authType is "api_key"', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-api03-test-key',
        authType: 'api_key',
      });

      expect(headers['X-API-Key']).toBe('sk-ant-api03-test-key');
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('AC4: anthropic-beta and anthropic-version headers set regardless of authType', () => {
    it('should set anthropic-beta and anthropic-version with oauth_token auth', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-oat01-test-token',
        authType: 'oauth_token',
        anthropicBeta: 'custom-beta-2024',
        anthropicVersion: '2024-01-01',
      });

      expect(headers['anthropic-beta']).toBe('custom-beta-2024');
      expect(headers['anthropic-version']).toBe('2024-01-01');
      expect(headers['Authorization']).toBe('Bearer sk-ant-oat01-test-token');
    });

    it('should set anthropic-beta and anthropic-version with default api_key auth', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-api03-test-key',
        anthropicBeta: 'custom-beta-2024',
        anthropicVersion: '2024-01-01',
      });

      expect(headers['anthropic-beta']).toBe('custom-beta-2024');
      expect(headers['anthropic-version']).toBe('2024-01-01');
      expect(headers['X-API-Key']).toBe('sk-ant-api03-test-key');
    });

    it('should use default beta and version when not provided', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-api03-test-key',
      });

      expect(headers['anthropic-beta']).toBe('messages-2023-12-15');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('should prefer providerOptions over gatewayRequestBody for beta/version', () => {
      const headers = callHeaders(
        {
          apiKey: 'sk-ant-api03-test-key',
          anthropicBeta: 'provider-beta',
          anthropicVersion: 'provider-version',
        },
        {
          anthropic_beta: 'body-beta',
          anthropic_version: 'body-version',
        }
      );

      expect(headers['anthropic-beta']).toBe('provider-beta');
      expect(headers['anthropic-version']).toBe('provider-version');
    });

    it('should fall back to gatewayRequestBody for beta/version when not in providerOptions', () => {
      const headers = callHeaders(
        {
          apiKey: 'sk-ant-api03-test-key',
        },
        {
          anthropic_beta: 'body-beta',
          anthropic_version: 'body-version',
        }
      );

      expect(headers['anthropic-beta']).toBe('body-beta');
      expect(headers['anthropic-version']).toBe('body-version');
    });
  });

  describe('API key resolution', () => {
    it('should prefer apiKey over anthropicApiKey', () => {
      const headers = callHeaders({
        apiKey: 'primary-key',
        anthropicApiKey: 'fallback-key',
      });

      expect(headers['X-API-Key']).toBe('primary-key');
    });

    it('should fall back to anthropicApiKey when apiKey is missing', () => {
      const headers = callHeaders({
        anthropicApiKey: 'fallback-key',
      });

      expect(headers['X-API-Key']).toBe('fallback-key');
    });

    it('should use anthropicApiKey for Bearer auth when apiKey is missing', () => {
      const headers = callHeaders({
        anthropicApiKey: 'sk-ant-oat01-fallback',
        authType: 'oauth_token',
      });

      expect(headers['Authorization']).toBe('Bearer sk-ant-oat01-fallback');
    });
  });

  // UAG: Story 48.5 — OAuth default beta header and client-header passthrough
  describe('AC5: OAuth default beta is oauth-2025-04-20', () => {
    it('should use oauth-2025-04-20 as default anthropic-beta when authType=oauth_token and no overrides', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-oat01-test',
        authType: 'oauth_token',
      });

      expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
      expect(headers['Authorization']).toBe('Bearer sk-ant-oat01-test');
    });

    it('should still use messages-2023-12-15 default for API Key path (regression)', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-api03-test',
      });

      expect(headers['anthropic-beta']).toBe('messages-2023-12-15');
    });

    it('should still use messages-2023-12-15 default when authType is explicit api_key (regression)', () => {
      const headers = callHeaders({
        apiKey: 'sk-ant-api03-test',
        authType: 'api_key',
      });

      expect(headers['anthropic-beta']).toBe('messages-2023-12-15');
    });
  });

  describe('AC6: client-sent anthropic-beta header is forwarded', () => {
    it('should forward client anthropic-beta header when providerOptions.anthropicBeta is absent (OAuth path)', () => {
      const headers = callHeaders(
        { apiKey: 'sk-ant-oat01-test', authType: 'oauth_token' },
        undefined,
        { 'anthropic-beta': 'oauth-2025-04-20,prompt-caching-2024-07-31' }
      );

      expect(headers['anthropic-beta']).toBe(
        'oauth-2025-04-20,prompt-caching-2024-07-31'
      );
    });

    it('should forward client anthropic-beta header for API Key path too', () => {
      const headers = callHeaders({ apiKey: 'sk-ant-api03-test' }, undefined, {
        'anthropic-beta': 'tools-2024-04-04',
      });

      expect(headers['anthropic-beta']).toBe('tools-2024-04-04');
    });

    it('should prefer providerOptions.anthropicBeta over client header', () => {
      const headers = callHeaders(
        {
          apiKey: 'sk-ant-oat01-test',
          authType: 'oauth_token',
          anthropicBeta: 'provider-option-wins',
        },
        undefined,
        { 'anthropic-beta': 'client-header-loses' }
      );

      expect(headers['anthropic-beta']).toBe('provider-option-wins');
    });

    it('should prefer client header over gatewayRequestBody.anthropic_beta', () => {
      const headers = callHeaders(
        { apiKey: 'sk-ant-oat01-test', authType: 'oauth_token' },
        { anthropic_beta: 'body-loses' },
        { 'anthropic-beta': 'client-header-wins' }
      );

      expect(headers['anthropic-beta']).toBe('client-header-wins');
    });

    it('should fall through to gatewayRequestBody when no client header is set', () => {
      const headers = callHeaders(
        { apiKey: 'sk-ant-oat01-test', authType: 'oauth_token' },
        { anthropic_beta: 'body-beta-wins' }
      );

      expect(headers['anthropic-beta']).toBe('body-beta-wins');
    });
  });

  describe('AC7: case-insensitive client header lookup', () => {
    it('should match client anthropic-beta header regardless of case', () => {
      const headers = callHeaders(
        { apiKey: 'sk-ant-oat01-test', authType: 'oauth_token' },
        undefined,
        { 'Anthropic-Beta': 'case-insensitive-match' }
      );

      expect(headers['anthropic-beta']).toBe('case-insensitive-match');
    });
  });

  // UAG: review-patch — empty client header value must NOT propagate as ""
  describe('AC8: empty-string client anthropic-beta header falls through to default', () => {
    it('should ignore empty client anthropic-beta and use OAuth default', () => {
      const headers = callHeaders(
        { apiKey: 'sk-ant-oat01-test', authType: 'oauth_token' },
        undefined,
        { 'anthropic-beta': '' }
      );

      expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    });

    it('should ignore empty client anthropic-beta and fall through to body field if present', () => {
      const headers = callHeaders(
        { apiKey: 'sk-ant-oat01-test', authType: 'oauth_token' },
        { anthropic_beta: 'body-wins-over-empty-client' },
        { 'anthropic-beta': '' }
      );

      expect(headers['anthropic-beta']).toBe('body-wins-over-empty-client');
    });
  });
});

// AC3: snake_case -> camelCase mapping verification
describe('convertKeysToCamelCase — auth_type mapping', () => {
  it('should convert auth_type to authType in target config', () => {
    const snakeCaseConfig = {
      targets: [
        {
          provider: 'anthropic',
          api_key: 'sk-ant-oat01-test',
          auth_type: 'oauth_token',
        },
      ],
    };

    const camelCaseConfig = convertKeysToCamelCase(snakeCaseConfig);

    expect(camelCaseConfig.targets[0].authType).toBe('oauth_token');
    expect(camelCaseConfig.targets[0].apiKey).toBe('sk-ant-oat01-test');
    expect(camelCaseConfig.targets[0].provider).toBe('anthropic');
  });

  it('should not create authType when auth_type is absent', () => {
    const snakeCaseConfig = {
      targets: [
        {
          provider: 'anthropic',
          api_key: 'sk-ant-api03-test',
        },
      ],
    };

    const camelCaseConfig = convertKeysToCamelCase(snakeCaseConfig);

    expect(camelCaseConfig.targets[0].authType).toBeUndefined();
    expect(camelCaseConfig.targets[0].apiKey).toBe('sk-ant-api03-test');
  });
});
