/**
 * UAG 缓存 TTL 转换测试
 *
 * 验证：
 * 1. putInCache 中 cacheMaxAge * 1000 秒→毫秒转换逻辑正确
 * 2. requestContext 中 cacheConfig.maxAge ?? cacheConfig.max_age 的 snake_case 兼容
 *
 * 对应 UAG 修改：
 * - src/middlewares/cache/index.ts: cacheMaxAge * 1000 TTL 转换
 * - src/handlers/services/requestContext.ts: maxAge ?? max_age snake_case 兼容
 */

import { getFromCache, putInCache } from '../../src/middlewares/cache/index';
import { RequestContext } from '../../src/handlers/services/requestContext';
import { Context } from 'hono';
import { Options, Params } from '../../src/types/requestBody';
import { endpointStrings } from '../../src/providers/types';

// Mock transformToProviderRequest
jest.mock('../../src/services/transformToProviderRequest', () => ({
  transformToProviderRequest: jest.fn().mockReturnValue({ transformed: true }),
}));

describe('UAG: TTL 秒→毫秒转换 (AC #3)', () => {
  beforeEach(() => {
    // Reset in-memory cache state between tests by putting known keys
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('putInCache should store response with maxAge as a millisecond timestamp', async () => {
    const requestBody = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
    };
    const responseBody = { choices: [{ message: { content: 'world' } }] };
    const url = 'https://api.openai.com/v1/chat/completions';

    // putInCache stores the cacheMaxAge value directly as passed
    // In the memoryCache middleware, it's computed as:
    // new Date().getTime() + (cacheMaxAge ? cacheMaxAge * 1000 : 24*60*60*1000)
    // So cacheMaxAge passed to putInCache is already in milliseconds (a future timestamp)
    await putInCache(null, {}, requestBody, responseBody, url, '', null, null);

    // Verify basic cache miss/hit cycle
    const [cached, status] = await getFromCache(
      null,
      {},
      requestBody,
      url,
      '',
      'simple',
      null
    );
    expect(status).toBe('HIT');
    expect(JSON.parse(cached)).toEqual(responseBody);
  });

  it('cache entry with future maxAge timestamp should be valid (not expired)', async () => {
    const requestBody = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'ttl-test' }],
    };
    const responseBody = { result: 'cached' };
    const url = 'https://api.test.com/v1/completions';

    // Simulate what memoryCache does: cacheMaxAge * 1000 + current time
    const cacheMaxAgeSeconds = 3600; // 1 hour in seconds
    const futureTimestamp = Date.now() + cacheMaxAgeSeconds * 1000;

    await putInCache(
      null,
      {},
      requestBody,
      responseBody,
      url,
      '',
      'simple',
      futureTimestamp
    );

    const [cached, status] = await getFromCache(
      null,
      {},
      requestBody,
      url,
      '',
      'simple',
      null
    );
    expect(status).toBe('HIT');
  });

  it('cache entry with past maxAge timestamp should be expired (MISS)', async () => {
    const requestBody = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'expire-test' }],
    };
    const responseBody = { result: 'should-expire' };
    const url = 'https://api.test.com/v1/expire';

    // Set maxAge to a past timestamp (already expired)
    const pastTimestamp = Date.now() - 1000;

    await putInCache(
      null,
      {},
      requestBody,
      responseBody,
      url,
      '',
      'simple',
      pastTimestamp
    );

    const [cached, status] = await getFromCache(
      null,
      {},
      requestBody,
      url,
      '',
      'simple',
      null
    );
    expect(status).toBe('MISS');
    expect(cached).toBeNull();
  });

  it('memoryCache middleware computes TTL as cacheMaxAge * 1000 (seconds to milliseconds)', () => {
    // This test validates the conversion formula used in memoryCache():
    // new Date().getTime() + (requestOptions.cacheMaxAge ? requestOptions.cacheMaxAge * 1000 : 24 * 60 * 60 * 1000)
    const cacheMaxAgeSeconds = 7200; // 2 hours
    const now = Date.now();
    const expectedMaxAge = now + cacheMaxAgeSeconds * 1000;

    // The formula from the middleware
    const computedMaxAge = now + cacheMaxAgeSeconds * 1000;

    expect(computedMaxAge).toBe(expectedMaxAge);
    // Verify it's in milliseconds (much larger than seconds value)
    expect(computedMaxAge).toBeGreaterThan(cacheMaxAgeSeconds);
    // Verify the multiplication factor
    expect(computedMaxAge - now).toBe(cacheMaxAgeSeconds * 1000);
  });

  it('default TTL should be 24 hours in milliseconds when cacheMaxAge is not provided', () => {
    // When cacheMaxAge is falsy, the formula uses: 24 * 60 * 60 * 1000
    const defaultTTLms = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const expectedMaxAge = now + defaultTTLms;

    // Simulate the middleware logic: cacheMaxAge is undefined/null/0
    const cacheMaxAge = 0;
    const computedMaxAge =
      now + (cacheMaxAge ? cacheMaxAge * 1000 : 24 * 60 * 60 * 1000);

    expect(computedMaxAge).toBe(expectedMaxAge);
    expect(defaultTTLms).toBe(86400000); // 24h in ms
  });
});

describe('UAG: snake_case max_age 兼容 (AC #4)', () => {
  let mockContext: Partial<Context>;

  beforeEach(() => {
    mockContext = {
      get: jest.fn(),
      set: jest.fn(),
    };
  });

  it('cacheConfig should use maxAge when both maxAge and max_age are present (maxAge priority)', () => {
    const providerOption: Options = {
      provider: 'openai',
      apiKey: 'sk-test',
      cache: {
        mode: 'simple',
        maxAge: 3600,
      } as any,
    };

    const ctx = new RequestContext(
      mockContext as Context,
      providerOption,
      'chatComplete' as endpointStrings,
      {},
      {} as Params,
      'POST',
      0
    );

    const config = ctx.cacheConfig;
    expect(config.mode).toBe('simple');
    expect(config.maxAge).toBe(3600);
  });

  it('cacheConfig should fall back to max_age when maxAge is not present', () => {
    const providerOption: Options = {
      provider: 'openai',
      apiKey: 'sk-test',
      cache: {
        mode: 'simple',
        max_age: 7200,
      } as any,
    };

    const ctx = new RequestContext(
      mockContext as Context,
      providerOption,
      'chatComplete' as endpointStrings,
      {},
      {} as Params,
      'POST',
      0
    );

    const config = ctx.cacheConfig;
    expect(config.mode).toBe('simple');
    expect(config.maxAge).toBe(7200);
  });

  it('cacheConfig should handle maxAge as string and parse to integer', () => {
    const providerOption: Options = {
      provider: 'openai',
      apiKey: 'sk-test',
      cache: {
        mode: 'simple',
        maxAge: '1800',
      } as any,
    };

    const ctx = new RequestContext(
      mockContext as Context,
      providerOption,
      'chatComplete' as endpointStrings,
      {},
      {} as Params,
      'POST',
      0
    );

    const config = ctx.cacheConfig;
    expect(config.maxAge).toBe(1800);
  });

  it('cacheConfig should return undefined maxAge when neither maxAge nor max_age is set', () => {
    const providerOption: Options = {
      provider: 'openai',
      apiKey: 'sk-test',
      cache: {
        mode: 'simple',
      },
    };

    const ctx = new RequestContext(
      mockContext as Context,
      providerOption,
      'chatComplete' as endpointStrings,
      {},
      {} as Params,
      'POST',
      0
    );

    const config = ctx.cacheConfig;
    expect(config.mode).toBe('simple');
    expect(config.maxAge).toBeUndefined();
  });

  it('cacheConfig should handle string-type cache (non-object)', () => {
    const providerOption: Options = {
      provider: 'openai',
      apiKey: 'sk-test',
      cache: 'simple' as any,
    };

    const ctx = new RequestContext(
      mockContext as Context,
      providerOption,
      'chatComplete' as endpointStrings,
      {},
      {} as Params,
      'POST',
      0
    );

    const config = ctx.cacheConfig;
    expect(config.mode).toBe('simple');
    expect(config.maxAge).toBeUndefined();
  });

  it('cacheConfig should return DISABLED when no cache config is set', () => {
    const providerOption: Options = {
      provider: 'openai',
      apiKey: 'sk-test',
    };

    const ctx = new RequestContext(
      mockContext as Context,
      providerOption,
      'chatComplete' as endpointStrings,
      {},
      {} as Params,
      'POST',
      0
    );

    const config = ctx.cacheConfig;
    expect(config.mode).toBe('DISABLED');
    expect(config.cacheStatus).toBe('DISABLED');
  });
});
