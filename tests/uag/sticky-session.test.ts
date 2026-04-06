/**
 * UAG: Test sticky session service logic.
 * Verifies Redis-backed session affinity for loadbalance mode:
 * - Cache miss returns null
 * - Cache hit returns stored target index
 * - Set stores with TTL
 * - Clear removes mapping
 * - Redis errors degrade gracefully (return null, no throw)
 */

const mockGet = jest.fn();
const mockSetWithTtl = jest.fn();
const mockDelete = jest.fn();

jest.mock('../../src/shared/services/cache', () => ({
  getSessionCache: () => ({
    get: mockGet,
    setWithTtl: mockSetWithTtl,
    delete: mockDelete,
  }),
}));

import {
  getStickyTarget,
  setStickyTarget,
  clearStickyTarget,
} from '../../src/services/stickySession';

describe('sticky session service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null on cache miss', async () => {
    mockGet.mockResolvedValue(null);
    const result = await getStickyTarget('agent-1', 'user-123');
    expect(result).toBeNull();
    expect(mockGet).toHaveBeenCalledWith('agent-1:user-123', 'sticky');
  });

  it('returns cached target index on hit', async () => {
    mockGet.mockResolvedValue(2);
    const result = await getStickyTarget('agent-1', 'user-123');
    expect(result).toBe(2);
  });

  it('sets target with TTL', async () => {
    mockSetWithTtl.mockResolvedValue(undefined);
    await setStickyTarget('agent-1', 'user-123', 2, 3600);
    expect(mockSetWithTtl).toHaveBeenCalledWith(
      'agent-1:user-123',
      2,
      3600,
      'sticky'
    );
  });

  it('clears target mapping', async () => {
    mockDelete.mockResolvedValue(true);
    await clearStickyTarget('agent-1', 'user-123');
    expect(mockDelete).toHaveBeenCalledWith('agent-1:user-123', 'sticky');
  });

  it('degrades gracefully on Redis error (get)', async () => {
    mockGet.mockRejectedValue(new Error('Redis connection refused'));
    const result = await getStickyTarget('agent-1', 'user-123');
    expect(result).toBeNull();
  });

  it('degrades gracefully on Redis error (set)', async () => {
    mockSetWithTtl.mockRejectedValue(new Error('Redis connection refused'));
    // Should not throw
    await expect(
      setStickyTarget('agent-1', 'user-123', 2, 3600)
    ).resolves.toBeUndefined();
  });

  it('degrades gracefully on Redis error (clear)', async () => {
    mockDelete.mockRejectedValue(new Error('Redis connection refused'));
    // Should not throw
    await expect(
      clearStickyTarget('agent-1', 'user-123')
    ).resolves.toBeUndefined();
  });
});
