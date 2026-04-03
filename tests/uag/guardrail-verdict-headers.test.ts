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
  AllHookResults,
  GuardrailCheckResult,
} from '../../src/middlewares/hooks/types';
import {
  computeGuardrailHeaders,
  GUARDRAIL_HEADER_VERDICT,
  GUARDRAIL_HEADER_TRIGGERED,
  GUARDRAIL_HEADER_ACTION,
} from '../../src/handlers/services/guardrailHeaderService';

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
 * Helper: 将 HookResult[] 包装为 AllHookResults 并调用实际的 computeGuardrailHeaders
 */
function buildGuardrailHeaders(
  hookResults: HookResult[],
  shouldDeny: boolean = false
): Record<string, string> {
  const allResults: AllHookResults = {
    beforeRequestHooksResult: hookResults,
    afterRequestHooksResult: [],
  };
  const result = computeGuardrailHeaders(allResults, shouldDeny);
  return result ?? {};
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

      expect(headers[GUARDRAIL_HEADER_VERDICT]).toBe('pass');
      expect(headers[GUARDRAIL_HEADER_ACTION]).toBe('none');
      expect(headers[GUARDRAIL_HEADER_TRIGGERED]).toBe('');
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

      // shouldDeny=true because the guardrail has deny: true and verdict: false
      const headers = buildGuardrailHeaders(hookResults, true);

      expect(headers[GUARDRAIL_HEADER_VERDICT]).toBe('deny');
      expect(headers[GUARDRAIL_HEADER_TRIGGERED]).toBe(
        'testGuardrail.checkContent'
      );
      expect(headers[GUARDRAIL_HEADER_ACTION]).toBe('block');
    });
  });

  describe('Partial verdict scenario — checks fail but no deny (AC #6)', () => {
    it('should produce partial/log headers when guardrail fails without deny flag', () => {
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
            },
          ],
          feedback: null as any,
          async: false,
          deny: false,
          execution_time: 80,
          skipped: false,
          type: HookType.GUARDRAIL,
          created_at: new Date(),
        },
      ];

      // shouldDeny=false because deny flag is false
      const headers = buildGuardrailHeaders(hookResults, false);

      expect(headers[GUARDRAIL_HEADER_VERDICT]).toBe('partial');
      expect(headers[GUARDRAIL_HEADER_TRIGGERED]).toBe(
        'testGuardrail.redactPII'
      );
      expect(headers[GUARDRAIL_HEADER_ACTION]).toBe('log');
    });
  });

  describe('Multiple guardrail plugins triggered (AC #6 多插件场景)', () => {
    it('should list multiple triggered check IDs from failed guardrails', () => {
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

      // shouldDeny=true because deny-flagged guardrails failed
      const headers = buildGuardrailHeaders(hookResults, true);

      expect(headers[GUARDRAIL_HEADER_VERDICT]).toBe('deny');
      // computeGuardrailHeaders collects failed check IDs (not guardrail result IDs)
      expect(headers[GUARDRAIL_HEADER_TRIGGERED]).toBe(
        'anotherGuardrail.validateSafety,testGuardrail.redactPII'
      );
      expect(headers[GUARDRAIL_HEADER_ACTION]).toBe('block');
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
