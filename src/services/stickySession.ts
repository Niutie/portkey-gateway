/**
 * @file UAG: Sticky session service for loadbalance mode.
 * Uses Redis (via sessionCache) to persist hash → target index mappings.
 * Gracefully degrades to random selection if Redis is unavailable.
 */
import { getSessionCache } from '../shared/services/cache';

const NAMESPACE = 'sticky';

function buildKey(agentConsumer: string, hashValue: string): string {
  return `${agentConsumer}:${hashValue}`;
}

/**
 * Look up cached target index for a sticky session key.
 * Returns null on cache miss or Redis failure (graceful degradation).
 */
export async function getStickyTarget(
  agentConsumer: string,
  hashValue: string
): Promise<number | null> {
  try {
    const cache = getSessionCache();
    const result = await cache.get<number>(
      buildKey(agentConsumer, hashValue),
      NAMESPACE
    );
    return result;
  } catch {
    // UAG: Redis unavailable — degrade to random selection
    return null;
  }
}

/**
 * Store target index for a sticky session key with TTL.
 * Silently swallows errors to avoid breaking the request chain.
 */
export async function setStickyTarget(
  agentConsumer: string,
  hashValue: string,
  targetIndex: number,
  ttlSeconds: number
): Promise<void> {
  try {
    const cache = getSessionCache();
    await cache.setWithTtl(
      buildKey(agentConsumer, hashValue),
      targetIndex,
      ttlSeconds,
      NAMESPACE
    );
  } catch {
    // UAG: Redis unavailable — skip caching, next request will re-select
  }
}

/**
 * Invalidate a sticky session mapping (e.g. on target failure).
 * Silently swallows errors.
 */
export async function clearStickyTarget(
  agentConsumer: string,
  hashValue: string
): Promise<void> {
  try {
    const cache = getSessionCache();
    await cache.delete(buildKey(agentConsumer, hashValue), NAMESPACE);
  } catch {
    // UAG: Redis unavailable — mapping will expire via TTL anyway
  }
}
