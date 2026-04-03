// UAG: Guardrail verdict header computation for audit trail (Story 33.3)
// Pure functions with zero side effects for easy testing.

import { AllHookResults, HookType } from '../../middlewares/hooks/types';

// UAG: Header keys exposed to Kong audit-collector
export const GUARDRAIL_HEADER_VERDICT = 'x-portkey-guardrail-verdict';
export const GUARDRAIL_HEADER_TRIGGERED = 'x-portkey-guardrail-triggered';
export const GUARDRAIL_HEADER_ACTION = 'x-portkey-guardrail-action';

// UAG: Maximum number of triggered plugin IDs to include (header size safety)
const MAX_TRIGGERED_IDS = 10;

export interface GuardrailHeaders {
  [GUARDRAIL_HEADER_VERDICT]: string;
  [GUARDRAIL_HEADER_TRIGGERED]: string;
  [GUARDRAIL_HEADER_ACTION]: string;
}

/**
 * UAG: Compute guardrail audit headers from hooks execution results.
 *
 * Returns null when no guardrail-type hooks were executed (no header pollution).
 * Otherwise returns 3 headers: verdict, triggered, action.
 */
export function computeGuardrailHeaders(
  hooksResult: AllHookResults,
  shouldDeny: boolean
): GuardrailHeaders | null {
  // UAG: Collect all non-skipped guardrail results
  const allResults = [
    ...hooksResult.beforeRequestHooksResult,
    ...hooksResult.afterRequestHooksResult,
  ].filter((r) => r.type === HookType.GUARDRAIL && !r.skipped);

  if (allResults.length === 0) return null;

  // UAG: Gather failed checks (verdict=false, not errored) from all guardrail results
  const failedChecks = allResults
    .flatMap((r) => r.checks || [])
    .filter((c) => !c.verdict && !c.error);

  // UAG: Build triggered IDs list, truncated to MAX_TRIGGERED_IDS for header size safety
  const triggeredIds = failedChecks
    .map((c) => c.id)
    .slice(0, MAX_TRIGGERED_IDS)
    .join(',');

  // UAG: Compute verdict: deny > partial > pass
  let verdict: string;
  if (shouldDeny) {
    verdict = 'deny';
  } else if (failedChecks.length > 0) {
    verdict = 'partial';
  } else {
    verdict = 'pass';
  }

  // UAG: Compute action: block > log > none
  let action: string;
  if (shouldDeny) {
    action = 'block';
  } else if (failedChecks.length > 0) {
    action = 'log';
  } else {
    action = 'none';
  }

  return {
    [GUARDRAIL_HEADER_VERDICT]: verdict,
    [GUARDRAIL_HEADER_TRIGGERED]: triggeredIds,
    [GUARDRAIL_HEADER_ACTION]: action,
  };
}
