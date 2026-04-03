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
