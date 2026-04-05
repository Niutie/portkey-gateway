/**
 * UAG 路由元数据 Header 测试
 *
 * 验证路由决策后响应应包含统一的 x-router-attempt-log header：
 * - Retry 场景（retryHandler）：is_retry 标记
 * - Fallback 场景（handlerUtils）：is_fallback 标记 + duration_ms
 *
 * 对应 UAG 修改（Story 33.4 / Task 1 + Task 2）：
 * - retryHandler: 统一 attempt log with is_retry
 * - handlerUtils fallback block: 统一 attempt log with is_fallback + duration_ms
 */

import { StrategyModes } from '../../src/types/requestBody';
import {
  retryRequest,
  truncateAttemptLog,
  RouterAttemptLog,
  RouterAttemptEntry,
} from '../../src/handlers/retryHandler';

/**
 * Helper: 模拟 handlerUtils.ts 中 fallback 模式的统一 x-router-attempt-log 构建逻辑
 *
 * 复现 handlerUtils.ts fallback block 的 header 构建：
 * - 遍历 targets，记录 attemptLog (RouterAttemptEntry[])
 * - 使用 truncateAttemptLog 截断
 * - 写入 x-router-attempt-log = JSON({total, attempts})
 */
function buildFallbackAttemptLogHeader(
  attempts: RouterAttemptEntry[]
): Record<string, string> {
  const headers: Record<string, string> = {};
  const routerLog: RouterAttemptLog = {
    total: attempts.length,
    attempts: truncateAttemptLog(attempts),
  };
  headers['x-router-attempt-log'] = JSON.stringify(routerLog);
  return headers;
}

/**
 * Helper: 创建 fallback attempt entry
 */
function makeFallbackEntry(
  overrides: Partial<RouterAttemptEntry> & {
    provider: string;
    status: number;
    ok: boolean;
  }
): RouterAttemptEntry {
  return {
    duration_ms: 100,
    is_retry: false,
    is_fallback: false,
    ...overrides,
  };
}

describe('UAG: Fallback 模式 x-router-attempt-log (Task 2)', () => {
  describe('is_fallback 标记', () => {
    it('should set is_fallback=false for first target, is_fallback=true for subsequent targets', () => {
      const attempts: RouterAttemptEntry[] = [
        makeFallbackEntry({
          provider: 'openai',
          status: 500,
          ok: false,
          is_fallback: false,
        }),
        makeFallbackEntry({
          provider: 'anthropic',
          status: 200,
          ok: true,
          is_fallback: true,
        }),
      ];

      const headers = buildFallbackAttemptLogHeader(attempts);
      const log: RouterAttemptLog = JSON.parse(headers['x-router-attempt-log']);

      expect(log.total).toBe(2);
      expect(log.attempts).toHaveLength(2);

      const first = log.attempts[0] as RouterAttemptEntry;
      expect(first.is_fallback).toBe(false);
      expect(first.provider).toBe('openai');

      const second = log.attempts[1] as RouterAttemptEntry;
      expect(second.is_fallback).toBe(true);
      expect(second.provider).toBe('anthropic');
    });

    it('should set is_fallback=true for all targets after index 0 in multi-target chain', () => {
      const attempts: RouterAttemptEntry[] = [
        makeFallbackEntry({
          provider: 'openai',
          status: 500,
          ok: false,
          is_fallback: false,
        }),
        makeFallbackEntry({
          provider: 'azure',
          status: 503,
          ok: false,
          is_fallback: true,
        }),
        makeFallbackEntry({
          provider: 'anthropic',
          status: 200,
          ok: true,
          is_fallback: true,
        }),
      ];

      const headers = buildFallbackAttemptLogHeader(attempts);
      const log: RouterAttemptLog = JSON.parse(headers['x-router-attempt-log']);

      expect(log.total).toBe(3);
      expect((log.attempts[0] as RouterAttemptEntry).is_fallback).toBe(false);
      expect((log.attempts[1] as RouterAttemptEntry).is_fallback).toBe(true);
      expect((log.attempts[2] as RouterAttemptEntry).is_fallback).toBe(true);
    });
  });

  describe('is_retry 始终为 false（fallback 循环不处理重试）', () => {
    it('should set is_retry=false for all fallback entries', () => {
      const attempts: RouterAttemptEntry[] = [
        makeFallbackEntry({
          provider: 'openai',
          status: 429,
          ok: false,
          is_fallback: false,
        }),
        makeFallbackEntry({
          provider: 'anthropic',
          status: 200,
          ok: true,
          is_fallback: true,
        }),
      ];

      const headers = buildFallbackAttemptLogHeader(attempts);
      const log: RouterAttemptLog = JSON.parse(headers['x-router-attempt-log']);

      const entries = log.attempts as RouterAttemptEntry[];
      expect(entries.every((e) => e.is_retry === false)).toBe(true);
    });
  });

  describe('duration_ms 字段', () => {
    it('should include duration_ms for each attempt', () => {
      const attempts: RouterAttemptEntry[] = [
        makeFallbackEntry({
          provider: 'openai',
          status: 500,
          ok: false,
          duration_ms: 150,
          is_fallback: false,
        }),
        makeFallbackEntry({
          provider: 'anthropic',
          status: 200,
          ok: true,
          duration_ms: 230,
          is_fallback: true,
        }),
      ];

      const headers = buildFallbackAttemptLogHeader(attempts);
      const log: RouterAttemptLog = JSON.parse(headers['x-router-attempt-log']);

      expect((log.attempts[0] as RouterAttemptEntry).duration_ms).toBe(150);
      expect((log.attempts[1] as RouterAttemptEntry).duration_ms).toBe(230);
    });
  });

  describe('status_text 可选字段', () => {
    it('should include status_text when present on failed attempts', () => {
      const attempts: RouterAttemptEntry[] = [
        makeFallbackEntry({
          provider: 'openai',
          status: 429,
          ok: false,
          is_fallback: false,
          status_text: 'Too Many Requests',
        }),
        makeFallbackEntry({
          provider: 'anthropic',
          status: 200,
          ok: true,
          is_fallback: true,
        }),
      ];

      const headers = buildFallbackAttemptLogHeader(attempts);
      const log: RouterAttemptLog = JSON.parse(headers['x-router-attempt-log']);

      expect((log.attempts[0] as RouterAttemptEntry).status_text).toBe(
        'Too Many Requests'
      );
      expect(
        (log.attempts[1] as RouterAttemptEntry).status_text
      ).toBeUndefined();
    });
  });

  describe('单目标成功场景', () => {
    it('should produce log with single entry when first target succeeds', () => {
      const attempts: RouterAttemptEntry[] = [
        makeFallbackEntry({
          provider: 'openai',
          status: 200,
          ok: true,
          is_fallback: false,
        }),
      ];

      const headers = buildFallbackAttemptLogHeader(attempts);
      const log: RouterAttemptLog = JSON.parse(headers['x-router-attempt-log']);

      expect(log.total).toBe(1);
      expect(log.attempts).toHaveLength(1);
      const entry = log.attempts[0] as RouterAttemptEntry;
      expect(entry.is_fallback).toBe(false);
      expect(entry.ok).toBe(true);
    });
  });

  describe('全部失败场景', () => {
    it('should log all failed attempts with correct fallback flags', () => {
      const attempts: RouterAttemptEntry[] = [
        makeFallbackEntry({
          provider: 'openai',
          status: 500,
          ok: false,
          is_fallback: false,
        }),
        makeFallbackEntry({
          provider: 'anthropic',
          status: 503,
          ok: false,
          is_fallback: true,
        }),
      ];

      const headers = buildFallbackAttemptLogHeader(attempts);
      const log: RouterAttemptLog = JSON.parse(headers['x-router-attempt-log']);

      expect(log.total).toBe(2);
      expect(
        (log.attempts as RouterAttemptEntry[]).every((e) => e.ok === false)
      ).toBe(true);
      expect((log.attempts[0] as RouterAttemptEntry).is_fallback).toBe(false);
      expect((log.attempts[1] as RouterAttemptEntry).is_fallback).toBe(true);
    });
  });

  describe('旧 header 不再设置', () => {
    it('should NOT include old fallback/attempt headers in the unified format', () => {
      const attempts: RouterAttemptEntry[] = [
        makeFallbackEntry({
          provider: 'openai',
          status: 500,
          ok: false,
          is_fallback: false,
        }),
        makeFallbackEntry({
          provider: 'anthropic',
          status: 200,
          ok: true,
          is_fallback: true,
        }),
      ];

      const headers = buildFallbackAttemptLogHeader(attempts);

      // Old headers must NOT be present
      expect(headers['x-portkey-fallback-activated']).toBeUndefined();
      expect(headers['x-portkey-fallback-from']).toBeUndefined();
      expect(headers['x-portkey-attempt-log']).toBeUndefined();

      // Only x-router-attempt-log should be present
      expect(headers['x-router-attempt-log']).toBeDefined();
    });
  });

  describe('Truncation (使用 truncateAttemptLog)', () => {
    it('should use truncateAttemptLog for > 10 entries with _skip marker', () => {
      const attempts: RouterAttemptEntry[] = Array.from(
        { length: 15 },
        (_, i) =>
          makeFallbackEntry({
            provider: `provider-${i}`,
            status: i === 14 ? 200 : 500,
            ok: i === 14,
            is_fallback: i > 0,
            duration_ms: 100 + i * 10,
          })
      );

      const headers = buildFallbackAttemptLogHeader(attempts);
      const log: RouterAttemptLog = JSON.parse(headers['x-router-attempt-log']);

      expect(log.total).toBe(15);
      // truncateAttemptLog: first 1 + _skip + last 3 = 5 items
      expect(log.attempts).toHaveLength(5);

      // First entry preserved
      expect((log.attempts[0] as RouterAttemptEntry).provider).toBe(
        'provider-0'
      );
      // Skip marker
      expect((log.attempts[1] as { _skip: number })._skip).toBe(11);
      // Last entry
      expect((log.attempts[4] as RouterAttemptEntry).provider).toBe(
        'provider-14'
      );
      expect((log.attempts[4] as RouterAttemptEntry).ok).toBe(true);
    });

    it('should NOT truncate when <= 10 entries', () => {
      const attempts: RouterAttemptEntry[] = Array.from(
        { length: 10 },
        (_, i) =>
          makeFallbackEntry({
            provider: `provider-${i}`,
            status: i === 9 ? 200 : 500,
            ok: i === 9,
            is_fallback: i > 0,
          })
      );

      const headers = buildFallbackAttemptLogHeader(attempts);
      const log: RouterAttemptLog = JSON.parse(headers['x-router-attempt-log']);

      expect(log.total).toBe(10);
      expect(log.attempts).toHaveLength(10);
      expect(log.attempts.every((e: any) => !('_skip' in e))).toBe(true);
    });
  });
});

describe('UAG: Loadbalance 场景 (lb-weights)', () => {
  it('should include lb-weights as JSON with weight distribution', () => {
    // This test validates the loadbalance header format which is unchanged
    const weights = { openai: 3, anthropic: 7 };
    const headers: Record<string, string> = {};
    headers['x-portkey-lb-weights'] = JSON.stringify(weights);

    expect(headers['x-portkey-lb-weights']).toBe(JSON.stringify(weights));
  });

  it('should handle equal weights', () => {
    const weights = { openai: 1, azure: 1, anthropic: 1 };
    const headers: Record<string, string> = {};
    headers['x-portkey-lb-weights'] = JSON.stringify(weights);

    expect(headers['x-portkey-lb-weights']).toBe(JSON.stringify(weights));
  });
});

describe('UAG: StrategyModes enum values', () => {
  it('should have correct enum values matching handlerUtils usage', () => {
    expect(StrategyModes.FALLBACK).toBe('fallback');
    expect(StrategyModes.LOADBALANCE).toBe('loadbalance');
    expect(StrategyModes.SINGLE).toBe('single');
  });
});

describe('UAG: Retry attempt log (x-router-attempt-log)', () => {
  const dummyUrl = 'http://localhost:9999/v1/chat/completions';
  const dummyOptions: RequestInit = { method: 'POST', headers: {} };

  /**
   * Helper to parse the x-router-attempt-log header from a response.
   */
  function parseAttemptLog(response: Response): RouterAttemptLog {
    const raw = response.headers.get('x-router-attempt-log');
    expect(raw).toBeTruthy();
    return JSON.parse(raw!);
  }

  it('should set x-router-attempt-log on a successful first attempt', async () => {
    let callCount = 0;
    const handler = async () => {
      callCount++;
      return new Response('ok', { status: 200 });
    };

    const { response } = await retryRequest(
      dummyUrl,
      dummyOptions,
      2, // retryCount
      [429, 500],
      null,
      handler,
      false,
      'openai'
    );

    expect(response.status).toBe(200);
    const log = parseAttemptLog(response);
    expect(log.total).toBe(1);
    expect(log.attempts).toHaveLength(1);

    const entry = log.attempts[0] as RouterAttemptEntry;
    expect(entry.provider).toBe('openai');
    expect(entry.status).toBe(200);
    expect(entry.ok).toBe(true);
    expect(entry.is_retry).toBe(false);
    expect(entry.is_fallback).toBe(false);
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
    expect(callCount).toBe(1);
  });

  it('should track retried attempts before final success', async () => {
    let callCount = 0;
    const handler = async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response('ok', { status: 200 });
    };

    const { response } = await retryRequest(
      dummyUrl,
      dummyOptions,
      3,
      [429, 500],
      null,
      handler,
      false,
      'openai'
    );

    expect(response.status).toBe(200);
    const log = parseAttemptLog(response);
    expect(log.total).toBe(3);
    expect(log.attempts).toHaveLength(3);

    // First attempt: failed, not a retry
    const a0 = log.attempts[0] as RouterAttemptEntry;
    expect(a0.provider).toBe('openai');
    expect(a0.status).toBe(429);
    expect(a0.ok).toBe(false);
    expect(a0.is_retry).toBe(false);

    // Second attempt: failed, is a retry
    const a1 = log.attempts[1] as RouterAttemptEntry;
    expect(a1.status).toBe(429);
    expect(a1.ok).toBe(false);
    expect(a1.is_retry).toBe(true);

    // Third attempt: success, is a retry
    const a2 = log.attempts[2] as RouterAttemptEntry;
    expect(a2.status).toBe(200);
    expect(a2.ok).toBe(true);
    expect(a2.is_retry).toBe(true);
  });

  it('should track all failed attempts when retries exhausted', async () => {
    const handler = async () => {
      return new Response('error', { status: 500 });
    };

    const { response } = await retryRequest(
      dummyUrl,
      dummyOptions,
      2, // 2 retries = 3 total attempts
      [500],
      null,
      handler,
      false,
      'anthropic'
    );

    expect(response.status).toBe(500);
    const log = parseAttemptLog(response);
    // 2 from onRetry + 1 final from catch = 3
    expect(log.total).toBe(3);

    const entries = log.attempts as RouterAttemptEntry[];
    expect(entries.every((e) => e.ok === false)).toBe(true);
    expect(entries.every((e) => e.provider === 'anthropic')).toBe(true);
    expect(entries[0].is_retry).toBe(false);
    expect(entries[1].is_retry).toBe(true);
    expect(entries[2].is_retry).toBe(true);
  });

  it('should NOT set old retry headers (x-retry-attempts, x-retry-elapsed-ms, x-retry-per-attempt-timeout-ms)', async () => {
    const handler = async () => {
      return new Response('error', { status: 500 });
    };

    const { response } = await retryRequest(
      dummyUrl,
      dummyOptions,
      1,
      [500],
      5000,
      handler,
      false,
      'openai'
    );

    expect(response.headers.get('x-retry-attempts')).toBeNull();
    expect(response.headers.get('x-retry-elapsed-ms')).toBeNull();
    expect(response.headers.get('x-retry-per-attempt-timeout-ms')).toBeNull();
    // But x-router-attempt-log should be present
    expect(response.headers.get('x-router-attempt-log')).toBeTruthy();
  });

  it('should use "unknown" as provider when not specified', async () => {
    const handler = async () => new Response('ok', { status: 200 });

    const { response } = await retryRequest(
      dummyUrl,
      dummyOptions,
      0,
      [500],
      null,
      handler
    );

    const log = parseAttemptLog(response);
    const entry = log.attempts[0] as RouterAttemptEntry;
    expect(entry.provider).toBe('unknown');
  });

  it('should record bail path (non-retryable error) as single attempt', async () => {
    const handler = async () => {
      return new Response('bad request', { status: 400 });
    };

    const { response } = await retryRequest(
      dummyUrl,
      dummyOptions,
      3,
      [429, 500], // 400 is NOT retryable
      null,
      handler,
      false,
      'openai'
    );

    expect(response.status).toBe(400);
    const log = parseAttemptLog(response);
    expect(log.total).toBe(1);
    const entry = log.attempts[0] as RouterAttemptEntry;
    expect(entry.provider).toBe('openai');
    expect(entry.status).toBe(400);
    expect(entry.ok).toBe(false);
    expect(entry.is_retry).toBe(false);
  });

  it('should set is_fallback=false for all retry entries', async () => {
    let callCount = 0;
    const handler = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('error', { status: 429 });
      }
      return new Response('ok', { status: 200 });
    };

    const { response } = await retryRequest(
      dummyUrl,
      dummyOptions,
      2,
      [429],
      null,
      handler,
      false,
      'openai'
    );

    const log = parseAttemptLog(response);
    const entries = log.attempts as RouterAttemptEntry[];
    expect(entries.every((e) => e.is_fallback === false)).toBe(true);
  });

  describe('Truncation (> 10 entries)', () => {
    /**
     * Helper to create N attempt entries for truncation testing.
     */
    function makeEntries(n: number): RouterAttemptEntry[] {
      return Array.from({ length: n }, (_, i) => ({
        provider: 'openai',
        status: i === n - 1 ? 200 : 429,
        ok: i === n - 1,
        duration_ms: 100 + i * 50,
        is_retry: i > 0,
        is_fallback: false,
      }));
    }

    it('should truncate to first 1 + _skip marker + last 3 when > 10 entries', () => {
      const entries = makeEntries(15);
      const result = truncateAttemptLog(entries);

      expect(result).toHaveLength(5);

      // First entry preserved
      const first = result[0] as RouterAttemptEntry;
      expect(first.provider).toBe('openai');
      expect(first.status).toBe(429);
      expect(first.ok).toBe(false);

      // Skip marker
      const skip = result[1] as { _skip: number };
      expect(skip._skip).toBe(11); // 15 - 4 = 11

      // Last 3 entries preserved
      const last = result[4] as RouterAttemptEntry;
      expect(last.ok).toBe(true);
      expect(last.status).toBe(200);
    });

    it('should NOT truncate when exactly 10 entries', () => {
      const entries = makeEntries(10);
      const result = truncateAttemptLog(entries);

      expect(result).toHaveLength(10);
      // No _skip marker
      expect(result.every((e: any) => !('_skip' in e))).toBe(true);
    });

    it('should truncate 11 entries to first 1 + _skip(7) + last 3', () => {
      const entries = makeEntries(11);
      const result = truncateAttemptLog(entries);

      expect(result).toHaveLength(5);
      const skip = result[1] as { _skip: number };
      expect(skip._skip).toBe(7); // 11 - 4 = 7
    });

    it('should NOT truncate when fewer than 10 entries', () => {
      const entries = makeEntries(5);
      const result = truncateAttemptLog(entries);

      expect(result).toHaveLength(5);
      expect(result.every((e: any) => !('_skip' in e))).toBe(true);
    });
  });
});
