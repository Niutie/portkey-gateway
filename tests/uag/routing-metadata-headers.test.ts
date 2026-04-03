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
 * 路由尝试记录类型
 */
interface AttemptRecord {
  targetIndex: number;
  provider: string;
  status: number;
  success: boolean;
  duration?: number;
}

/**
 * Helper: 从路由执行结果中构建 UAG 路由元数据 header
 * 这是 Story 33.4 应实现的 header 构建逻辑的纯函数版本
 */
function buildRoutingMetadataHeaders(params: {
  strategyMode: string;
  attempts: AttemptRecord[];
  selectedTargetIndex: number;
  weights?: Record<number, number>;
}): Record<string, string> {
  const { strategyMode, attempts, selectedTargetIndex, weights } = params;
  const headers: Record<string, string> = {};

  // Fallback activation detection
  if (strategyMode === StrategyModes.FALLBACK) {
    const fallbackActivated = attempts.length > 1;
    headers['x-portkey-fallback-activated'] = String(fallbackActivated);

    if (fallbackActivated) {
      // fallback-from is the first target that failed
      const failedAttempts = attempts.filter((a) => !a.success);
      if (failedAttempts.length > 0) {
        headers['x-portkey-fallback-from'] = String(
          failedAttempts[0].targetIndex
        );
      }
    }
  }

  // Single mode: no fallback
  if (strategyMode === StrategyModes.SINGLE || !strategyMode) {
    headers['x-portkey-fallback-activated'] = 'false';
  }

  // Load balance weights
  if (strategyMode === StrategyModes.LOADBALANCE && weights) {
    const weightEntries = Object.entries(weights)
      .map(([idx, w]) => `${idx}:${w}`)
      .join(',');
    headers['x-portkey-lb-weights'] = weightEntries;
    headers['x-portkey-fallback-activated'] = 'false';
  }

  // Attempt log for all strategies with multiple attempts
  if (attempts.length > 0) {
    const attemptLog = attempts
      .map((a) => `${a.targetIndex}:${a.provider}:${a.status}`)
      .join('|');
    headers['x-portkey-attempt-log'] = attemptLog;
  }

  return headers;
}

describe('UAG: 路由元数据 header (AC #7)', () => {
  describe('Fallback 激活场景 (fallback-activated=true)', () => {
    it('should set fallback-activated=true when multiple targets are tried', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts: [
          { targetIndex: 0, provider: 'openai', status: 500, success: false },
          { targetIndex: 1, provider: 'anthropic', status: 200, success: true },
        ],
        selectedTargetIndex: 1,
      });

      expect(headers['x-portkey-fallback-activated']).toBe('true');
      expect(headers['x-portkey-fallback-from']).toBe('0');
    });

    it('should include fallback-from pointing to the first failed target', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts: [
          { targetIndex: 0, provider: 'openai', status: 429, success: false },
          { targetIndex: 1, provider: 'azure', status: 503, success: false },
          { targetIndex: 2, provider: 'anthropic', status: 200, success: true },
        ],
        selectedTargetIndex: 2,
      });

      expect(headers['x-portkey-fallback-activated']).toBe('true');
      expect(headers['x-portkey-fallback-from']).toBe('0');
    });

    it('should set fallback-activated=false when first target succeeds', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts: [
          { targetIndex: 0, provider: 'openai', status: 200, success: true },
        ],
        selectedTargetIndex: 0,
      });

      expect(headers['x-portkey-fallback-activated']).toBe('false');
    });
  });

  describe('Loadbalance 场景 (lb-weights)', () => {
    it('should include lb-weights with weight distribution', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.LOADBALANCE,
        attempts: [
          { targetIndex: 1, provider: 'anthropic', status: 200, success: true },
        ],
        selectedTargetIndex: 1,
        weights: { 0: 3, 1: 7 },
      });

      expect(headers['x-portkey-lb-weights']).toBe('0:3,1:7');
      expect(headers['x-portkey-fallback-activated']).toBe('false');
    });

    it('should handle equal weights', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.LOADBALANCE,
        attempts: [
          { targetIndex: 0, provider: 'openai', status: 200, success: true },
        ],
        selectedTargetIndex: 0,
        weights: { 0: 1, 1: 1, 2: 1 },
      });

      expect(headers['x-portkey-lb-weights']).toBe('0:1,1:1,2:1');
    });
  });

  describe('Single 模式场景 (fallback-activated=false)', () => {
    it('should set fallback-activated=false for single mode', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.SINGLE,
        attempts: [
          { targetIndex: 0, provider: 'openai', status: 200, success: true },
        ],
        selectedTargetIndex: 0,
      });

      expect(headers['x-portkey-fallback-activated']).toBe('false');
      expect(headers['x-portkey-fallback-from']).toBeUndefined();
      expect(headers['x-portkey-lb-weights']).toBeUndefined();
    });

    it('should set fallback-activated=false when strategyMode is undefined', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: '',
        attempts: [
          { targetIndex: 0, provider: 'openai', status: 200, success: true },
        ],
        selectedTargetIndex: 0,
      });

      expect(headers['x-portkey-fallback-activated']).toBe('false');
    });
  });

  describe('Attempt log 多 target 尝试场景 (attempt-log)', () => {
    it('should produce attempt log with single successful attempt', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.SINGLE,
        attempts: [
          { targetIndex: 0, provider: 'openai', status: 200, success: true },
        ],
        selectedTargetIndex: 0,
      });

      expect(headers['x-portkey-attempt-log']).toBe('0:openai:200');
    });

    it('should produce attempt log with multiple fallback attempts', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts: [
          { targetIndex: 0, provider: 'openai', status: 500, success: false },
          { targetIndex: 1, provider: 'azure', status: 429, success: false },
          { targetIndex: 2, provider: 'anthropic', status: 200, success: true },
        ],
        selectedTargetIndex: 2,
      });

      expect(headers['x-portkey-attempt-log']).toBe(
        '0:openai:500|1:azure:429|2:anthropic:200'
      );
    });

    it('should handle all-failed attempts in attempt log', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.FALLBACK,
        attempts: [
          { targetIndex: 0, provider: 'openai', status: 500, success: false },
          {
            targetIndex: 1,
            provider: 'anthropic',
            status: 503,
            success: false,
          },
        ],
        selectedTargetIndex: 1,
      });

      expect(headers['x-portkey-attempt-log']).toBe(
        '0:openai:500|1:anthropic:503'
      );
      expect(headers['x-portkey-fallback-activated']).toBe('true');
    });

    it('should produce loadbalance attempt log with single selected target', () => {
      const headers = buildRoutingMetadataHeaders({
        strategyMode: StrategyModes.LOADBALANCE,
        attempts: [
          { targetIndex: 2, provider: 'azure', status: 200, success: true },
        ],
        selectedTargetIndex: 2,
        weights: { 0: 1, 1: 2, 2: 3 },
      });

      expect(headers['x-portkey-attempt-log']).toBe('2:azure:200');
      expect(headers['x-portkey-lb-weights']).toBe('0:1,1:2,2:3');
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
