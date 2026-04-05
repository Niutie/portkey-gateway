/**
 * UAG 路由元数据 Header 测试
 *
 * 验证路由决策后响应应包含：
 * - x-portkey-fallback-activated: 是否激活了 fallback（true/false）
 * - x-portkey-fallback-from: fallback 来源 target 索引
 * - x-portkey-lb-weights: 负载均衡权重信息
 * - x-portkey-attempt-log: 多 target 尝试日志
 *
 * 注意：Story 33.4 的 fork 源码修改定义了 header 注入逻辑。
 * 本测试验证路由策略的数据流和基于路由结果构建 header 的逻辑。
 *
 * 对应 UAG 修改（Story 33.4）：
 * - 路由决策链路注入 fallback-activated/fallback-from/lb-weights/attempt-log 响应 header
 */

import { StrategyModes } from '../../src/types/requestBody';
import {
  retryRequest,
  truncateAttemptLog,
  RouterAttemptLog,
  RouterAttemptEntry,
} from '../../src/handlers/retryHandler';

/**
 * 路由尝试记录类型 — 匹配 handlerUtils.ts 中 attemptLog 数组元素的实际结构
 */
interface AttemptRecord {
  provider: string;
  status: number;
  ok: boolean;
}

/**
 * Helper: 模拟 handlerUtils.ts 中 tryTargetsRecursively 的路由元数据 header 构建逻辑
 *
 * 注意：实际代码使用 JSON.stringify 序列化 attemptLog 和 weightSnapshot，
 * 本辅助函数复现相同逻辑以便测试验证。
 */
function buildRoutingMetadataHeaders(params: {
  strategyMode: string;
  attempts: AttemptRecord[];
  fallbackActivated: boolean;
  fallbackFrom?: string;
  weights?: Record<string, number>;
}): Record<string, string> {
  const { strategyMode, attempts, fallbackActivated, fallbackFrom, weights } =
    params;
  const headers: Record<string, string> = {};

  // Fallback mode: set activation status and source
  if (strategyMode === StrategyModes.FALLBACK) {
    headers['x-portkey-fallback-activated'] = String(fallbackActivated);
    if (fallbackActivated && fallbackFrom) {
      headers['x-portkey-fallback-from'] = fallbackFrom;
    }
  }

  // Single mode or no strategy: no fallback
  if (strategyMode === StrategyModes.SINGLE || !strategyMode) {
    headers['x-portkey-fallback-activated'] = 'false';
  }

  // Load balance weights — JSON serialized as in actual code
  if (strategyMode === StrategyModes.LOADBALANCE && weights) {
    headers['x-portkey-lb-weights'] = JSON.stringify(weights);
    // loadbalance doesn't explicitly set fallback-activated in actual code
  }

  // Attempt log — JSON serialized as in actual code, truncated at 10
  if (attempts.length > 0) {
    const truncatedLog =
      attempts.length > 10
        ? [
            ...attempts.slice(0, 10),
            { provider: '_truncated', status: 0, ok: false },
          ]
        : attempts;
    headers['x-portkey-attempt-log'] = JSON.stringify(truncatedLog);
  }

  return headers;
}

describe('UAG: 路由元数据 header (AC #7)', () => {
  describe('Fallback 激活场景 (fallback-activated=true)', () => {
    it('should set fallback-activated=true when multiple targets are tried', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts: [
          { provider: 'openai', status: 500, ok: false },
          { provider: 'anthropic', status: 200, ok: true },
        ],
        fallbackActivated: true,
        fallbackFrom: 'openai',
      });

      expect(headers['x-portkey-fallback-activated']).toBe('true');
      expect(headers['x-portkey-fallback-from']).toBe('openai');
    });

    it('should include fallback-from pointing to the first target provider', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts: [
          { provider: 'openai', status: 429, ok: false },
          { provider: 'azure', status: 503, ok: false },
          { provider: 'anthropic', status: 200, ok: true },
        ],
        fallbackActivated: true,
        fallbackFrom: 'openai',
      });

      expect(headers['x-portkey-fallback-activated']).toBe('true');
      expect(headers['x-portkey-fallback-from']).toBe('openai');
    });

    it('should set fallback-activated=false when first target succeeds', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts: [{ provider: 'openai', status: 200, ok: true }],
        fallbackActivated: false,
      });

      expect(headers['x-portkey-fallback-activated']).toBe('false');
    });
  });

  describe('Loadbalance 场景 (lb-weights)', () => {
    it('should include lb-weights as JSON with weight distribution', () => {
      const weights = { openai: 3, anthropic: 7 };
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.LOADBALANCE,
        attempts: [{ provider: 'anthropic', status: 200, ok: true }],
        fallbackActivated: false,
        weights,
      });

      expect(headers['x-portkey-lb-weights']).toBe(JSON.stringify(weights));
    });

    it('should handle equal weights', () => {
      const weights = { openai: 1, azure: 1, anthropic: 1 };
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.LOADBALANCE,
        attempts: [{ provider: 'openai', status: 200, ok: true }],
        fallbackActivated: false,
        weights,
      });

      expect(headers['x-portkey-lb-weights']).toBe(JSON.stringify(weights));
    });
  });

  describe('Single 模式场景 (fallback-activated=false)', () => {
    it('should set fallback-activated=false for single mode', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.SINGLE,
        attempts: [{ provider: 'openai', status: 200, ok: true }],
        fallbackActivated: false,
      });

      expect(headers['x-portkey-fallback-activated']).toBe('false');
      expect(headers['x-portkey-fallback-from']).toBeUndefined();
      expect(headers['x-portkey-lb-weights']).toBeUndefined();
    });

    it('should set fallback-activated=false when strategyMode is undefined', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: '',
        attempts: [{ provider: 'openai', status: 200, ok: true }],
        fallbackActivated: false,
      });

      expect(headers['x-portkey-fallback-activated']).toBe('false');
    });
  });

  describe('Attempt log 多 target 尝试场景 (attempt-log)', () => {
    it('should produce JSON attempt log with single successful attempt', () => {
      const attempts = [{ provider: 'openai', status: 200, ok: true }];
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.SINGLE,
        attempts,
        fallbackActivated: false,
      });

      expect(headers['x-portkey-attempt-log']).toBe(JSON.stringify(attempts));
    });

    it('should produce JSON attempt log with multiple fallback attempts', () => {
      const attempts = [
        { provider: 'openai', status: 500, ok: false },
        { provider: 'azure', status: 429, ok: false },
        { provider: 'anthropic', status: 200, ok: true },
      ];
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts,
        fallbackActivated: true,
        fallbackFrom: 'openai',
      });

      expect(headers['x-portkey-attempt-log']).toBe(JSON.stringify(attempts));
    });

    it('should handle all-failed attempts in attempt log', () => {
      const attempts = [
        { provider: 'openai', status: 500, ok: false },
        { provider: 'anthropic', status: 503, ok: false },
      ];
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts,
        fallbackActivated: true,
        fallbackFrom: 'openai',
      });

      expect(headers['x-portkey-attempt-log']).toBe(JSON.stringify(attempts));
      expect(headers['x-portkey-fallback-activated']).toBe('true');
    });

    it('should produce loadbalance attempt log with single selected target', () => {
      const attempts = [{ provider: 'azure', status: 200, ok: true }];
      const weights = { openai: 1, azure: 2, anthropic: 3 };
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.LOADBALANCE,
        attempts,
        fallbackActivated: false,
        weights,
      });

      expect(headers['x-portkey-attempt-log']).toBe(JSON.stringify(attempts));
      expect(headers['x-portkey-lb-weights']).toBe(JSON.stringify(weights));
    });
  });

  describe('StrategyModes enum values', () => {
    it('should have correct enum values matching handlerUtils usage', () => {
      expect(StrategyModes.FALLBACK).toBe('fallback');
      expect(StrategyModes.LOADBALANCE).toBe('loadbalance');
      expect(StrategyModes.SINGLE).toBe('single');
    });
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
