import { describe, expect, it, vi } from 'vitest';
import {
  DLQ_BACKOFF_SCHEDULE_MS,
  MAX_DLQ_RETRIES,
  MAX_CONCURRENT_PER_HOST,
  calculateDlqBackoffDelay,
  getNextDlqRetryTimestamp,
  extractHost,
  HostRateLimiter,
  retryDeadLetterItem,
  scanAndRetryDeadLetters,
  createDlqRetryWorker,
} from '../webhook-dlq-retry';

describe('Webhook DLQ Exponential Backoff & Retry Worker (#348)', () => {
  describe('Exponential Backoff Pacing', () => {
    it('schedules retry attempts at increasing long-intervals: 1h, 4h, 12h, 24h', () => {
      // 1 hour for attempt 0 (first retry)
      expect(calculateDlqBackoffDelay(0)).toBe(1 * 60 * 60 * 1000);
      // 4 hours for attempt 1
      expect(calculateDlqBackoffDelay(1)).toBe(4 * 60 * 60 * 1000);
      // 12 hours for attempt 2
      expect(calculateDlqBackoffDelay(2)).toBe(12 * 60 * 60 * 1000);
      // 24 hours for attempt 3 and onwards
      expect(calculateDlqBackoffDelay(3)).toBe(24 * 60 * 60 * 1000);
      expect(calculateDlqBackoffDelay(4)).toBe(24 * 60 * 60 * 1000);
      expect(calculateDlqBackoffDelay(9)).toBe(24 * 60 * 60 * 1000);
    });

    it('computes exact ISO timestamp based on base time and retry index', () => {
      const baseTime = 1700000000000;
      const expectedTime = baseTime + (1 * 60 * 60 * 1000);
      expect(getNextDlqRetryTimestamp(0, baseTime)).toBe(new Date(expectedTime).toISOString());

      const expectedSecond = baseTime + (4 * 60 * 60 * 1000);
      expect(getNextDlqRetryTimestamp(1, baseTime)).toBe(new Date(expectedSecond).toISOString());
    });
  });

  describe('Host-Level Concurrency Throttling', () => {
    it('extracts normalized host correctly from URLs', () => {
      expect(extractHost('https://api.merchant.com/webhook')).toBe('api.merchant.com');
      expect(extractHost('http://webhook.org:8080/events')).toBe('webhook.org:8080');
      expect(extractHost('invalid-url')).toBe('unknown_host');
    });

    it('enforces maximum 5 concurrent requests per destination host', async () => {
      const limiter = new HostRateLimiter(5);
      const host = 'api.recovering-merchant.com';
      let activePeak = 0;
      let activeCurrently = 0;

      // Simulate 12 concurrent requests to the same host
      const tasks = Array.from({ length: 12 }, (_, i) => async () => {
        return limiter.run(host, async () => {
          activeCurrently++;
          activePeak = Math.max(activePeak, activeCurrently);
          // Simulate network latency
          await new Promise((resolve) => setTimeout(resolve, 20));
          activeCurrently--;
          return `result_${i}`;
        });
      });

      const results = await Promise.all(tasks.map((t) => t()));
      expect(results).toHaveLength(12);
      expect(activePeak).toBe(5);
      expect(limiter.getActiveCount(host)).toBe(0);
    });

    it('allows concurrent requests to different hosts independently without cross-blocking', async () => {
      const limiter = new HostRateLimiter(5);
      const hostA = 'host-a.com';
      const hostB = 'host-b.com';

      let runningA = 0;
      let runningB = 0;

      const pA = limiter.run(hostA, async () => {
        runningA++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        runningA--;
      });

      const pB = limiter.run(hostB, async () => {
        runningB++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        runningB--;
      });

      expect(limiter.getActiveCount(hostA)).toBe(1);
      expect(limiter.getActiveCount(hostB)).toBe(1);

      await Promise.all([pA, pB]);
      expect(limiter.getActiveCount(hostA)).toBe(0);
      expect(limiter.getActiveCount(hostB)).toBe(0);
    });
  });

  describe('Delivery Execution & Success Cleanup', () => {
    const mockSecret = 'whsec_0123456789abcdef0123456789abcdef';
    const mockDeadLetter = {
      id: 'dl-1111-2222-3333-4444',
      delivery_id: 'del-1111-2222',
      event_type: 'vault.pulled',
      payload: { user: 'GUSER...', amount: 100 },
      destination_url: 'https://merchant.example.com/webhooks',
      attempt_count: 5,
      retry_count: 0,
      failed_at: '2026-11-22T10:00:00.000Z',
      webhooks: {
        id: 'wh-123',
        url: 'https://merchant.example.com/webhooks',
        signing_secret: mockSecret,
      },
    };

    it('marks dead letter as recovered with latency upon HTTP 200 response', async () => {
      let updatedPayload = null;
      const mockSupabase = {
        from: vi.fn(() => ({
          update: vi.fn((data) => {
            updatedPayload = data;
            return {
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: { ...mockDeadLetter, ...data }, error: null })),
                })),
              })),
            };
          }),
        })),
      };

      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      });

      const simulatedNow = new Date('2026-11-22T11:00:00.000Z').getTime(); // 1 hour after failed_at
      const outcome = await retryDeadLetterItem(mockSupabase, mockDeadLetter, {
        fetchImpl,
        now: () => simulatedNow,
      });

      expect(outcome.status).toBe('recovered');
      expect(outcome.responseStatus).toBe(200);
      expect(outcome.recoveryLatencyMs).toBe(3600000); // 1 hour latency

      expect(updatedPayload).toMatchObject({
        status: 'recovered',
        replay_status: 'success',
        last_response_status: 200,
        retry_count: 1,
        next_retry_at: null,
      });
      expect(updatedPayload.recovery_latency_ms).toBe(3600000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('schedules next exponential retry upon delivery failure', async () => {
      let updatedPayload = null;
      const mockSupabase = {
        from: vi.fn(() => ({
          update: vi.fn((data) => {
            updatedPayload = data;
            return {
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: { ...mockDeadLetter, ...data }, error: null })),
                })),
              })),
            };
          }),
        })),
      };

      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      const simulatedNow = new Date('2026-11-22T11:00:00.000Z').getTime();
      const outcome = await retryDeadLetterItem(mockSupabase, mockDeadLetter, {
        fetchImpl,
        now: () => simulatedNow,
      });

      expect(outcome.status).toBe('failed');
      expect(outcome.responseStatus).toBe(503);
      expect(outcome.retryCount).toBe(1);

      // Next retry after 1 retry completed is scheduled with 4h backoff (index 1)
      const expectedNext = new Date(simulatedNow + (4 * 60 * 60 * 1000)).toISOString();
      expect(updatedPayload).toMatchObject({
        status: 'failed',
        replay_status: 'failed',
        last_response_status: 503,
        retry_count: 1,
        next_retry_at: expectedNext,
      });
    });

    it('marks dead letter as exhausted when max retries (10) are reached', async () => {
      let updatedPayload = null;
      const mockSupabase = {
        from: vi.fn(() => ({
          update: vi.fn((data) => {
            updatedPayload = data;
            return {
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: { ...mockDeadLetter, ...data }, error: null })),
                })),
              })),
            };
          }),
        })),
      };

      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const exhaustedCandidate = { ...mockDeadLetter, retry_count: 9 };
      const outcome = await retryDeadLetterItem(mockSupabase, exhaustedCandidate, {
        fetchImpl,
      });

      expect(outcome.status).toBe('exhausted');
      expect(outcome.retryCount).toBe(10);
      expect(updatedPayload).toMatchObject({
        status: 'exhausted',
        next_retry_at: null,
      });
    });
  });

  describe('DLQ Scanner and Worker', () => {
    it('scans eligible items and aggregates processing outcome', async () => {
      const items = [
        {
          id: 'item-1',
          event_type: 'event.a',
          destination_url: 'https://site-a.com/hook',
          payload: {},
          webhooks: { url: 'https://site-a.com/hook', signing_secret: 'whsec_111122223333444455556666' },
        },
        {
          id: 'item-2',
          event_type: 'event.b',
          destination_url: 'https://site-b.com/hook',
          payload: {},
          webhooks: { url: 'https://site-b.com/hook', signing_secret: 'whsec_111122223333444455556666' },
        },
      ];

      const mockSupabase = {
        from: vi.fn(() => {
          const chain = {
            select: vi.fn().mockReturnThis(),
            lt: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn(async () => ({ data: items, error: null })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: {}, error: null })),
                })),
              })),
            })),
          };
          return chain;
        }),
      };

      const fetchImpl = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'OK' }) // item-1 recovered
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Fail' }); // item-2 failed

      const summary = await scanAndRetryDeadLetters(mockSupabase, { fetchImpl });
      expect(summary.scanned).toBe(2);
      expect(summary.recovered).toBe(1);
      expect(summary.failed).toBe(1);
    });

    it('starts and stops recurring worker cleanly', () => {
      const mockSupabase = {};
      const worker = createDlqRetryWorker(mockSupabase, { intervalMs: 10000 });
      expect(typeof worker.runOnce).toBe('function');
      expect(typeof worker.stop).toBe('function');
      worker.stop();
    });
  });
});

