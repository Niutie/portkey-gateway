// UAG: Unit tests for guardrailHeaderService (Story 33.3)
import {
  computeGuardrailHeaders,
  GUARDRAIL_HEADER_VERDICT,
  GUARDRAIL_HEADER_TRIGGERED,
  GUARDRAIL_HEADER_ACTION,
} from '../../../../../src/handlers/services/guardrailHeaderService';
import {
  AllHookResults,
  HookType,
  GuardrailResult,
  GuardrailCheckResult,
} from '../../../../../src/middlewares/hooks/types';

// Helper to create a minimal GuardrailCheckResult
function makeCheck(
  id: string,
  verdict: boolean,
  error?: Error | null
): GuardrailCheckResult {
  return {
    id,
    verdict,
    error: error || null,
    execution_time: 10,
    created_at: new Date(),
  };
}

// Helper to create a minimal GuardrailResult
function makeGuardrailResult(
  id: string,
  checks: GuardrailCheckResult[],
  opts: { skipped?: boolean; deny?: boolean } = {}
): GuardrailResult {
  return {
    id,
    verdict: checks.every((c) => c.verdict),
    checks,
    type: HookType.GUARDRAIL,
    skipped: opts.skipped ?? false,
    deny: opts.deny ?? false,
    async: false,
    feedback: {},
    execution_time: 100,
    created_at: new Date(),
  };
}

// Helper to create empty AllHookResults
function emptyResults(): AllHookResults {
  return {
    beforeRequestHooksResult: [],
    afterRequestHooksResult: [],
  };
}

describe('guardrailHeaderService', () => {
  describe('computeGuardrailHeaders', () => {
    it('returns null when no guardrail hooks exist', () => {
      const result = computeGuardrailHeaders(emptyResults(), false);
      expect(result).toBeNull();
    });

    it('returns null when only non-guardrail hooks exist', () => {
      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [
          {
            ...makeGuardrailResult('mutator-1', []),
            type: HookType.MUTATOR,
          },
        ],
        afterRequestHooksResult: [],
      };
      const result = computeGuardrailHeaders(hooksResult, false);
      expect(result).toBeNull();
    });

    it('returns null when all guardrail hooks are skipped', () => {
      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [
          makeGuardrailResult(
            'guard-1',
            [makeCheck('default.regexMatch', true)],
            { skipped: true }
          ),
        ],
        afterRequestHooksResult: [],
      };
      const result = computeGuardrailHeaders(hooksResult, false);
      expect(result).toBeNull();
    });

    it('returns pass/none when all checks pass', () => {
      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [
          makeGuardrailResult('guard-1', [
            makeCheck('default.regexMatch', true),
            makeCheck('default.contains', true),
          ]),
        ],
        afterRequestHooksResult: [],
      };

      const result = computeGuardrailHeaders(hooksResult, false);

      expect(result).not.toBeNull();
      expect(result![GUARDRAIL_HEADER_VERDICT]).toBe('pass');
      expect(result![GUARDRAIL_HEADER_TRIGGERED]).toBe('');
      expect(result![GUARDRAIL_HEADER_ACTION]).toBe('none');
    });

    it('returns deny/block when shouldDeny is true', () => {
      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [],
        afterRequestHooksResult: [
          makeGuardrailResult('guard-1', [
            makeCheck('default.regexMatch', false),
          ]),
        ],
      };

      const result = computeGuardrailHeaders(hooksResult, true);

      expect(result).not.toBeNull();
      expect(result![GUARDRAIL_HEADER_VERDICT]).toBe('deny');
      expect(result![GUARDRAIL_HEADER_TRIGGERED]).toBe('default.regexMatch');
      expect(result![GUARDRAIL_HEADER_ACTION]).toBe('block');
    });

    it('returns partial/log when checks fail but shouldDeny is false', () => {
      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [
          makeGuardrailResult('guard-1', [
            makeCheck('default.regexMatch', false),
            makeCheck('default.contains', true),
          ]),
        ],
        afterRequestHooksResult: [],
      };

      const result = computeGuardrailHeaders(hooksResult, false);

      expect(result).not.toBeNull();
      expect(result![GUARDRAIL_HEADER_VERDICT]).toBe('partial');
      expect(result![GUARDRAIL_HEADER_TRIGGERED]).toBe('default.regexMatch');
      expect(result![GUARDRAIL_HEADER_ACTION]).toBe('log');
    });

    it('includes multiple failed check IDs comma-separated', () => {
      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [
          makeGuardrailResult('guard-1', [
            makeCheck('default.regexMatch', false),
            makeCheck('default.contains', false),
            makeCheck('default.pii', true),
          ]),
        ],
        afterRequestHooksResult: [],
      };

      const result = computeGuardrailHeaders(hooksResult, false);

      expect(result![GUARDRAIL_HEADER_TRIGGERED]).toBe(
        'default.regexMatch,default.contains'
      );
    });

    it('excludes errored checks from triggered list', () => {
      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [
          makeGuardrailResult('guard-1', [
            makeCheck('default.regexMatch', false, new Error('timeout')),
            makeCheck('default.contains', false),
          ]),
        ],
        afterRequestHooksResult: [],
      };

      const result = computeGuardrailHeaders(hooksResult, false);

      // Only default.contains should be in triggered (regexMatch has error)
      expect(result![GUARDRAIL_HEADER_TRIGGERED]).toBe('default.contains');
    });

    it('truncates triggered IDs to 10 entries', () => {
      const checks: GuardrailCheckResult[] = [];
      for (let i = 0; i < 15; i++) {
        checks.push(makeCheck(`default.check${i}`, false));
      }

      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [makeGuardrailResult('guard-1', checks)],
        afterRequestHooksResult: [],
      };

      const result = computeGuardrailHeaders(hooksResult, false);
      const ids = result![GUARDRAIL_HEADER_TRIGGERED].split(',');
      expect(ids.length).toBe(10);
    });

    it('combines before and after request hook results', () => {
      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [
          makeGuardrailResult('guard-before', [
            makeCheck('default.regexMatch', false),
          ]),
        ],
        afterRequestHooksResult: [
          makeGuardrailResult('guard-after', [
            makeCheck('default.contains', false),
          ]),
        ],
      };

      const result = computeGuardrailHeaders(hooksResult, false);

      expect(result![GUARDRAIL_HEADER_VERDICT]).toBe('partial');
      expect(result![GUARDRAIL_HEADER_TRIGGERED]).toBe(
        'default.regexMatch,default.contains'
      );
    });

    it('returns deny verdict even when some checks pass', () => {
      const hooksResult: AllHookResults = {
        beforeRequestHooksResult: [
          makeGuardrailResult('guard-1', [
            makeCheck('default.regexMatch', true),
            makeCheck('default.pii', false),
          ]),
        ],
        afterRequestHooksResult: [],
      };

      const result = computeGuardrailHeaders(hooksResult, true);

      expect(result![GUARDRAIL_HEADER_VERDICT]).toBe('deny');
      expect(result![GUARDRAIL_HEADER_ACTION]).toBe('block');
      expect(result![GUARDRAIL_HEADER_TRIGGERED]).toBe('default.pii');
    });
  });
});
