/**
 * UAG Guardrail Verdict Header 测试
 *
 * 验证 guardrail 执行后响应应包含：
 * - x-portkey-guardrail-verdict: 整体 verdict（pass/deny）
 * - x-portkey-guardrail-triggered: 触发的 guardrail ID 列表
 * - x-portkey-guardrail-action: 执行的动作（pass/deny/redact 等）
 *
 * 注意：Story 33.3 的 fork 源码修改定义了 header 注入逻辑。
 * 本测试验证 HooksManager 执行结果的数据结构，以及基于执行结果构建 header 的逻辑。
 *
 * 对应 UAG 修改（Story 33.3）：
 * - guardrail 执行链路注入 verdict/triggered/action 响应 header
 */

import { HooksManager, HookSpan } from '../../src/middlewares/hooks/index';
import {
  HookType,
  HookObject,
  HookResult,
  GuardrailCheckResult,
} from '../../src/middlewares/hooks/types';

// Mock plugins - path relative to where hooks/index.ts resolves '../../../plugins'
// From tests/uag/ the plugins dir is at ../../plugins
jest.mock('../../plugins', () => ({
  plugins: {
    testGuardrail: {
      checkContent: jest.fn(),
      redactPII: jest.fn(),
    },
    anotherGuardrail: {
      validateSafety: jest.fn(),
    },
  },
}));

/**
 * Helper: 从 HookResult 数组中提取 UAG guardrail header 值
 * 这是 Story 33.3 应实现的 header 构建逻辑的纯函数版本
 */
function buildGuardrailHeaders(
  hookResults: HookResult[]
): Record<string, string> {
  const guardrailResults = hookResults.filter(
    (r) => r.type === HookType.GUARDRAIL && !r.skipped
  );

  if (guardrailResults.length === 0) {
    return {};
  }

  const overallVerdict = guardrailResults.every((r) => r.verdict)
    ? 'pass'
    : 'deny';

  const triggeredIds = guardrailResults
    .filter((r) => !r.verdict)
    .map((r) => r.id)
    .join(',');

  // Determine action based on results
  let action = 'pass';
  if (!guardrailResults.every((r) => r.verdict)) {
    const hasRedact = guardrailResults.some((r) => r.transformed);
    const hasDeny = guardrailResults.some((r) => r.deny);
    action = hasDeny ? 'deny' : hasRedact ? 'redact' : 'deny';
  }

  const headers: Record<string, string> = {
    'x-portkey-guardrail-verdict': overallVerdict,
  };

  if (triggeredIds) {
    headers['x-portkey-guardrail-triggered'] = triggeredIds;
  }

  headers['x-portkey-guardrail-action'] = action;

  return headers;
}

describe('UAG: Guardrail verdict header 数据结构 (AC #6)', () => {
  let hooksManager: HooksManager;

  beforeEach(() => {
    hooksManager = new HooksManager();
  });

  describe('HooksManager executeHooks returns structured results', () => {
    it('should return verdict and results from guardrail hook execution', async () => {
      const { plugins } = require('../../plugins');
      plugins.testGuardrail.checkContent.mockResolvedValue({
        verdict: true,
        data: { score: 0.95 },
      });

      const span = hooksManager.createSpan(
        { messages: [{ role: 'user', content: 'Hello' }] },
        {},
        'openai',
        false,
        [
          {
            type: HookType.GUARDRAIL,
            id: 'guardrail-1',
            checks: [{ id: 'testGuardrail.checkContent', parameters: {} }],
            deny: false,
            eventType: 'beforeRequestHook' as const,
          },
        ],
        [],
        null,
        'chatComplete',
        {}
      );

      const { results, shouldDeny } = await hooksManager.executeHooks(
        span.id,
        ['syncBeforeRequestHook'],
        { env: {} }
      );

      expect(results).toHaveLength(1);
      expect(results[0].verdict).toBe(true);
      expect(results[0].type).toBe(HookType.GUARDRAIL);
      expect(shouldDeny).toBe(false);
    });

    it('should set shouldDeny when guardrail with deny flag fails', async () => {
      const { plugins } = require('../../plugins');
      plugins.testGuardrail.checkContent.mockResolvedValue({
        verdict: false,
        data: { reason: 'harmful content' },
      });

      const span = hooksManager.createSpan(
        { messages: [{ role: 'user', content: 'bad content' }] },
        {},
        'openai',
        false,
        [
          {
            type: HookType.GUARDRAIL,
            id: 'guardrail-deny',
            checks: [{ id: 'testGuardrail.checkContent', parameters: {} }],
            deny: true,
            eventType: 'beforeRequestHook' as const,
          },
        ],
        [],
        null,
        'chatComplete',
        {}
      );

      const { results, shouldDeny } = await hooksManager.executeHooks(
        span.id,
        ['syncBeforeRequestHook'],
        { env: {} }
      );

      expect(shouldDeny).toBe(true);
      expect(results[0].verdict).toBe(false);
      expect(results[0].deny).toBe(true);
    });
  });

  describe('Pass verdict scenario (AC #6)', () => {
    it('should produce pass verdict headers when all guardrails pass', () => {
      const hookResults: HookResult[] = [
        {
          verdict: true,
          id: 'content-filter',
          checks: [
            {
              verdict: true,
              id: 'testGuardrail.checkContent',
              execution_time: 100,
              created_at: new Date(),
              data: null,
            },
          ],
          feedback: null as any,
          async: false,
          deny: false,
          execution_time: 100,
          skipped: false,
          type: HookType.GUARDRAIL,
          created_at: new Date(),
        },
      ];

      const headers = buildGuardrailHeaders(hookResults);

      expect(headers['x-portkey-guardrail-verdict']).toBe('pass');
      expect(headers['x-portkey-guardrail-action']).toBe('pass');
      expect(headers['x-portkey-guardrail-triggered']).toBeUndefined();
    });
  });

  describe('Deny verdict scenario (AC #6)', () => {
    it('should produce deny verdict headers when a guardrail fails with deny', () => {
      const hookResults: HookResult[] = [
        {
          verdict: false,
          id: 'safety-check',
          checks: [
            {
              verdict: false,
              id: 'testGuardrail.checkContent',
              execution_time: 50,
              created_at: new Date(),
              data: null,
            },
          ],
          feedback: null as any,
          async: false,
          deny: true,
          execution_time: 50,
          skipped: false,
          type: HookType.GUARDRAIL,
          created_at: new Date(),
        },
      ];

      const headers = buildGuardrailHeaders(hookResults);

      expect(headers['x-portkey-guardrail-verdict']).toBe('deny');
      expect(headers['x-portkey-guardrail-triggered']).toBe('safety-check');
      expect(headers['x-portkey-guardrail-action']).toBe('deny');
    });
  });

  describe('Redact verdict scenario (AC #6)', () => {
    it('should produce redact action headers when guardrail transforms content', () => {
      const hookResults: HookResult[] = [
        {
          verdict: false,
          id: 'pii-redactor',
          checks: [
            {
              verdict: false,
              id: 'testGuardrail.redactPII',
              execution_time: 80,
              created_at: new Date(),
              data: null,
              transformed: true,
            },
          ],
          transformed: true,
          feedback: null as any,
          async: false,
          deny: false,
          execution_time: 80,
          skipped: false,
          type: HookType.GUARDRAIL,
          created_at: new Date(),
        },
      ];

      const headers = buildGuardrailHeaders(hookResults);

      expect(headers['x-portkey-guardrail-verdict']).toBe('deny');
      expect(headers['x-portkey-guardrail-triggered']).toBe('pii-redactor');
      expect(headers['x-portkey-guardrail-action']).toBe('redact');
    });
  });

  describe('Multiple guardrail plugins triggered (AC #6 多插件场景)', () => {
    it('should list multiple triggered guardrail IDs', () => {
      const hookResults: HookResult[] = [
        {
          verdict: true,
          id: 'content-filter',
          checks: [
            {
              verdict: true,
              id: 'testGuardrail.checkContent',
              execution_time: 100,
              created_at: new Date(),
              data: null,
            },
          ],
          feedback: null as any,
          async: false,
          deny: false,
          execution_time: 100,
          skipped: false,
          type: HookType.GUARDRAIL,
          created_at: new Date(),
        },
        {
          verdict: false,
          id: 'safety-check',
          checks: [
            {
              verdict: false,
              id: 'anotherGuardrail.validateSafety',
              execution_time: 60,
              created_at: new Date(),
              data: null,
            },
          ],
          feedback: null as any,
          async: false,
          deny: true,
          execution_time: 60,
          skipped: false,
          type: HookType.GUARDRAIL,
          created_at: new Date(),
        },
        {
          verdict: false,
          id: 'pii-redactor',
          checks: [
            {
              verdict: false,
              id: 'testGuardrail.redactPII',
              execution_time: 80,
              created_at: new Date(),
              data: null,
            },
          ],
          feedback: null as any,
          async: false,
          deny: true,
          execution_time: 80,
          skipped: false,
          type: HookType.GUARDRAIL,
          created_at: new Date(),
        },
      ];

      const headers = buildGuardrailHeaders(hookResults);

      expect(headers['x-portkey-guardrail-verdict']).toBe('deny');
      expect(headers['x-portkey-guardrail-triggered']).toBe(
        'safety-check,pii-redactor'
      );
      expect(headers['x-portkey-guardrail-action']).toBe('deny');
    });

    it('should return empty headers when no guardrail hooks executed', () => {
      const hookResults: HookResult[] = [];
      const headers = buildGuardrailHeaders(hookResults);
      expect(headers).toEqual({});
    });

    it('should skip skipped guardrail results', () => {
      const hookResults: HookResult[] = [
        {
          verdict: true,
          id: 'skipped-guard',
          checks: [],
          feedback: null as any,
          async: false,
          deny: false,
          execution_time: 0,
          skipped: true,
          type: HookType.GUARDRAIL,
          created_at: new Date(),
        },
      ];

      const headers = buildGuardrailHeaders(hookResults);
      expect(headers).toEqual({});
    });
  });
});
