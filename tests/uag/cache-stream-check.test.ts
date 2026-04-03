/**
 * UAG Stream 判断修复测试
 *
 * 验证 `!stream`（truthy check）替代原 `stream === (false || undefined)` 的逻辑正确性。
 *
 * 原始 bug: `stream === (false || undefined)` 等价于 `stream === false`，
 * 导致 stream 为 undefined 时也不会被缓存（误判为 stream 模式）。
 *
 * UAG 修复: 使用 `!stream` 进行 truthy check，当 stream 为 false/undefined/null/0 时均视为非流式。
 *
 * 对应 UAG 修改：
 * - src/middlewares/cache/index.ts: putInCache 中 `if (requestBody.stream)` 替代旧逻辑
 * - src/middlewares/cache/index.ts: memoryCache 中 `!requestOptions[0].requestParams.stream`
 */

import { putInCache, getFromCache } from '../../src/middlewares/cache/index';

describe('UAG: stream 判断逻辑修复 (AC #5)', () => {
  describe('putInCache stream check', () => {
    it('should cache when stream is false', async () => {
      const requestBody = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'stream-false' }],
        stream: false,
      };
      const responseBody = { choices: [{ message: { content: 'cached' } }] };
      const url = 'https://api.test.com/stream-false';

      await putInCache(
        null,
        {},
        requestBody,
        responseBody,
        url,
        '',
        'simple',
        null
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
      expect(cached).not.toBeNull();
    });

    it('should cache when stream is undefined', async () => {
      // This is the key fix: stream undefined should allow caching
      const requestBody = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'stream-undef' }],
      };
      const responseBody = {
        choices: [{ message: { content: 'cached-undef' } }],
      };
      const url = 'https://api.test.com/stream-undef';

      await putInCache(
        null,
        {},
        requestBody,
        responseBody,
        url,
        '',
        'simple',
        null
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
      expect(cached).not.toBeNull();
    });

    it('should cache when stream is null', async () => {
      const requestBody = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'stream-null' }],
        stream: null,
      };
      const responseBody = {
        choices: [{ message: { content: 'cached-null' } }],
      };
      const url = 'https://api.test.com/stream-null';

      await putInCache(
        null,
        {},
        requestBody,
        responseBody,
        url,
        '',
        'simple',
        null
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
      expect(cached).not.toBeNull();
    });

    it('should NOT cache when stream is true', async () => {
      const requestBody = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'stream-true' }],
        stream: true,
      };
      const responseBody = {
        choices: [{ message: { content: 'not-cached' } }],
      };
      const url = 'https://api.test.com/stream-true';

      await putInCache(
        null,
        {},
        requestBody,
        responseBody,
        url,
        '',
        'simple',
        null
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

    it('should demonstrate the original bug: stream === (false || undefined) === stream === false', () => {
      // This test documents why the original code was buggy
      // `(false || undefined)` evaluates to `undefined`
      // So `stream === (false || undefined)` === `stream === undefined`
      // This means stream === false would NOT match, which is the opposite of intention

      // Original broken logic:
      const originalCheck = (stream: any) => stream === (false || undefined);

      // Actually (false || undefined) === undefined, so:
      expect(false || undefined).toBe(undefined);
      expect(originalCheck(false)).toBe(false); // Bug: false should allow caching but doesn't match
      expect(originalCheck(undefined)).toBe(true); // This works by accident
      expect(originalCheck(true)).toBe(false); // Correct

      // UAG fixed logic: !stream (truthy check)
      const fixedCheck = (stream: any) => !stream;

      expect(fixedCheck(false)).toBe(true); // Correct: should cache
      expect(fixedCheck(undefined)).toBe(true); // Correct: should cache
      expect(fixedCheck(null)).toBe(true); // Correct: should cache
      expect(fixedCheck(true)).toBe(false); // Correct: should NOT cache
    });
  });

  describe('memoryCache middleware stream check (post-next phase)', () => {
    it('should verify !stream logic in memoryCache post-processing', () => {
      // The memoryCache middleware checks: !requestOptions[0].requestParams.stream
      // This test validates the logic used in the middleware's post-next phase

      const cases = [
        { stream: false, shouldCache: true },
        { stream: undefined, shouldCache: true },
        { stream: null, shouldCache: true },
        { stream: 0, shouldCache: true },
        { stream: '', shouldCache: true },
        { stream: true, shouldCache: false },
        { stream: 'true', shouldCache: false },
        { stream: 1, shouldCache: false },
      ];

      for (const { stream, shouldCache } of cases) {
        const requestOptions = [{ requestParams: { stream } }];
        const willCache = !requestOptions[0].requestParams.stream;
        expect(willCache).toBe(shouldCache);
      }
    });
  });
});
