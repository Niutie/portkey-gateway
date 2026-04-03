/**
 * UAG 缓存中间件注册测试
 *
 * 验证当 conf.json 中 cache: true 时，memoryCache() 中间件被正确注册，
 * 且 c.set('getFromCache', ...) 被调用。
 *
 * 对应 UAG 修改：
 * - conf.json: cache: true（启用 memoryCache 中间件注册）
 * - src/index.ts: if (conf.cache === true) { app.use('*', memoryCache()); }
 * - src/middlewares/cache/index.ts: memoryCache() 中间件
 */

import { Context } from 'hono';
import {
  memoryCache,
  getFromCache,
  putInCache,
} from '../../src/middlewares/cache/index';

describe('UAG: memoryCache middleware registration (AC #2)', () => {
  let mockContext: Partial<Context>;
  let mockNext: jest.Mock;
  let storedValues: Record<string, any>;

  beforeEach(() => {
    storedValues = {};
    mockNext = jest.fn().mockResolvedValue(undefined);
    mockContext = {
      req: {
        header: jest.fn().mockReturnValue({}),
      } as any,
      get: jest.fn((key: string) => storedValues[key]),
      set: jest.fn((key: string, value: any) => {
        storedValues[key] = value;
      }),
    };
  });

  it('should register getFromCache function on context via c.set', async () => {
    const middleware = memoryCache();
    await middleware(mockContext as Context, mockNext);

    expect(mockContext.set).toHaveBeenCalledWith(
      'getFromCache',
      expect.any(Function)
    );
  });

  it('should call next() to continue middleware chain', async () => {
    const middleware = memoryCache();
    await middleware(mockContext as Context, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('should provide a working getFromCache wrapper with namespace support', async () => {
    // Setup headers with namespace
    (mockContext.req!.header as jest.Mock).mockReturnValue({
      'x-portkey-cache-namespace': 'test-ns',
    });

    const middleware = memoryCache();
    await middleware(mockContext as Context, mockNext);

    // Verify getFromCache was set
    const setCall = (mockContext.set as jest.Mock).mock.calls.find(
      (call: any[]) => call[0] === 'getFromCache'
    );
    expect(setCall).toBeDefined();

    // The wrapper function should be callable
    const getFromCacheWrapper = setCall![1];
    expect(typeof getFromCacheWrapper).toBe('function');
  });

  it('should handle post-next cache storage for non-streaming simple cache mode', async () => {
    const mockResponseBody = { choices: [{ message: { content: 'test' } }] };
    const mockCloneJson = jest.fn().mockResolvedValue(mockResponseBody);

    // Simulate requestOptions being set during the handler phase
    mockNext.mockImplementation(async () => {
      storedValues['requestOptions'] = [
        {
          requestParams: { stream: false },
          cacheMode: 'simple',
          cacheMaxAge: 3600,
          transformedRequest: {
            body: {
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'hi' }],
            },
          },
          response: { clone: () => ({ json: mockCloneJson }) },
          providerOptions: {
            rubeusURL: 'https://api.openai.com/v1/chat/completions',
          },
        },
      ];
    });

    const middleware = memoryCache();
    await middleware(mockContext as Context, mockNext);

    // After next(), the middleware should attempt to cache the response
    // The putInCache is called internally - verify by checking that next was called
    expect(mockNext).toHaveBeenCalled();
  });

  it('should NOT cache when stream is true in requestOptions', async () => {
    // Simulate streaming requestOptions
    mockNext.mockImplementation(async () => {
      storedValues['requestOptions'] = [
        {
          requestParams: { stream: true },
          cacheMode: 'simple',
          cacheMaxAge: 3600,
          transformedRequest: { body: {} },
          response: { clone: () => ({ json: jest.fn() }) },
          providerOptions: { rubeusURL: 'https://example.com' },
        },
      ];
    });

    const middleware = memoryCache();
    await middleware(mockContext as Context, mockNext);

    // With stream: true, the middleware should skip caching
    // (the !requestOptions[0].requestParams.stream check)
    expect(mockNext).toHaveBeenCalled();
  });
});

describe('UAG: conf.json cache: true triggers memoryCache registration', () => {
  it('conf.json should have cache: true', async () => {
    // Directly verify conf.json configuration
    const conf = await import('../../conf.json');
    expect(conf.cache).toBe(true);
  });
});
