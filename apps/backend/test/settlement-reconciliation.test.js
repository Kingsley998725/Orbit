import { describe, expect, it, vi } from 'vitest';
import {
  formatUsdcUnits,
  formatStroopsToXlm,
  calculate24HourReconciliationWindow,
  calculateMsUntilNextMidnightUtc,
  aggregateMerchantSettlements,
  generateReconciliationCsv,
  generateReconciliationPdf,
  storeAndDispatchReconciliationReport,
  runNightlyReconciliationJob,
  startReconciliationCron,
} from '../settlement-reconciliation';

describe('Nightly Settlement Reconciliation Report Generator (#347)', () => {
  describe('Timezone & 24-Hour UTC Window Calculation', () => {
    it('calculates the exact preceding 24-hour UTC window at 00:00 UTC', () => {
      // Midnight Nov 22, 2026 UTC
      const date = new Date('2026-11-22T00:00:00.000Z');
      const window = calculate24HourReconciliationWindow(date);

      expect(window.reportDate).toBe('2026-11-21');
      expect(window.windowStart).toBe('2026-11-21T00:00:00.000Z');
      expect(window.windowEnd).toBe('2026-11-22T00:00:00.000Z');
    });

    it('handles month and year boundaries cleanly in UTC', () => {
      // Midnight Jan 1, 2027 UTC
      const newYear = new Date('2027-01-01T00:00:00.000Z');
      const window = calculate24HourReconciliationWindow(newYear);

      expect(window.reportDate).toBe('2026-12-31');
      expect(window.windowStart).toBe('2026-12-31T00:00:00.000Z');
      expect(window.windowEnd).toBe('2027-01-01T00:00:00.000Z');
    });

    it('calculates milliseconds until next midnight UTC accurately', () => {
      // 23:00 UTC (1 hour before midnight)
      const date = new Date('2026-11-22T23:00:00.000Z');
      const ms = calculateMsUntilNextMidnightUtc(date);
      expect(ms).toBe(60 * 60 * 1000);
    });

    it('formats raw 7-decimal USDC units and stroops correctly', () => {
      expect(formatUsdcUnits('1500000000')).toBe('150.0000000');
      expect(formatUsdcUnits('29500000')).toBe('2.9500000');
      expect(formatUsdcUnits(0)).toBe('0.0000000');

      expect(formatStroopsToXlm('10000000')).toBe('1.0000000');
      expect(formatStroopsToXlm('5000000')).toBe('0.5000000');
    });
  });

  describe('Settlement Aggregator Calculation', () => {
    it('aggregates Gross Settled USDC, network fees, failed pulls, and active vault balance', async () => {
      const merchantId = 'merchant-uuid-1';
      const window = {
        windowStart: '2026-11-21T00:00:00.000Z',
        windowEnd: '2026-11-22T00:00:00.000Z',
      };

      const mockSettledTxns = [
        {
          id: 'tx-1',
          merchant_id: merchantId,
          amount_usdc_units: '500000000', // 50 USDC
          fee_paid_stroops: '100',
          status: 'settled',
          settled_at: '2026-11-21T04:00:00.000Z',
        },
        {
          id: 'tx-2',
          merchant_id: merchantId,
          amount_usdc_units: '1000000000', // 100 USDC
          fee_paid_stroops: '250',
          status: 'settled',
          settled_at: '2026-11-21T18:30:00.000Z',
        },
      ];

      const mockFailedTxns = [
        {
          id: 'tx-fail-1',
          merchant_id: merchantId,
          status: 'failed',
          created_at: '2026-11-21T12:00:00.000Z',
        },
      ];

      const mockActiveSubs = [
        { id: 'sub-1', status: 'active', plans: { usdc_amount: '2000000000' } }, // 200 USDC
        { id: 'sub-2', status: 'active', plans: { usdc_amount: '3000000000' } }, // 300 USDC
      ];

      const mockSupabase = {
        from: vi.fn((table) => {
          if (table === 'payment_transactions') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn((field1, val1) => ({
                  eq: vi.fn((field2, val2) => {
                    const isSettled = val2 === 'settled';
                    return {
                      gte: vi.fn(() => ({
                        lt: vi.fn(() => {
                          if (isSettled) {
                            return {
                              order: vi.fn(async () => ({ data: mockSettledTxns, error: null })),
                            };
                          }
                          return Promise.resolve({ data: mockFailedTxns, error: null });
                        }),
                      })),
                    };
                  }),
                })),
              })),
            };
          }
          if (table === 'subscriptions') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(async () => ({ data: mockActiveSubs, error: null })),
                })),
              })),
            };
          }
          return { select: vi.fn() };
        }),
      };

      const summary = await aggregateMerchantSettlements(mockSupabase, merchantId, window);

      // Gross settled: 50 + 100 = 150 USDC (1500000000 units)
      expect(summary.grossSettledUnits).toBe('1500000000');
      expect(summary.grossSettledUsdc).toBe('150.0000000');

      // Network fees: 100 + 250 = 350 stroops
      expect(summary.networkFeesStroops).toBe('350');

      // Failed pull count: 1
      expect(summary.failedPullCount).toBe(1);

      // Active vault balance: 200 + 300 = 500 USDC
      expect(summary.activeVaultCount).toBe(2);
      expect(summary.activeVaultBalanceUsdc).toBe('500.0000000');
    });
  });

  describe('Report Generation (CSV & PDF)', () => {
    const merchant = {
      id: 'm-1234',
      name: 'Acme SaaS Corp',
      wallet_address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    };
    const window = {
      reportDate: '2026-11-21',
      windowStart: '2026-11-21T00:00:00.000Z',
      windowEnd: '2026-11-22T00:00:00.000Z',
    };
    const summary = {
      grossSettledUsdc: '150.0000000',
      grossSettledUnits: '1500000000',
      networkFeesStroops: '350',
      networkFeesXlm: '0.0000350',
      failedPullCount: 1,
      activeVaultCount: 2,
      activeVaultBalanceUsdc: '500.0000000',
    };
    const transactions = [
      {
        id: 'tx-1',
        subscription_id: 'sub-1',
        customer_wallet_address: 'GUSER1111111111111111111111111111111111111111111111111111',
        amount_usdc_units: '1500000000',
        fee_paid_stroops: '350',
        status: 'settled',
        tx_hash: 'hash-abc',
        settled_at: '2026-11-21T10:00:00.000Z',
      },
    ];

    it('generates structured CSV with headers, summary metrics, and itemized rows', () => {
      const csv = generateReconciliationCsv({ merchant, window, summary, transactions });

      expect(csv).toContain('Orbit Protocol - Daily Merchant Settlement Reconciliation Report');
      expect(csv).toContain('Acme SaaS Corp');
      expect(csv).toContain('Gross Settled USDC,150.0000000');
      expect(csv).toContain('Network Fees Paid (Stroops),350');
      expect(csv).toContain('Failed Pull Count,1');
      expect(csv).toContain('Active Vault Total Balance (USDC),500.0000000');
      expect(csv).toContain('tx-1');
      expect(csv).toContain('hash-abc');
    });

    it('generates non-empty valid PDF statement document', async () => {
      const pdfBuffer = await generateReconciliationPdf({ merchant, window, summary, transactions });

      expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
      expect(pdfBuffer.length).toBeGreaterThan(100);
      // PDF documents start with %PDF
      expect(pdfBuffer.toString('utf8', 0, 4)).toBe('%PDF');
    });
  });

  describe('Storage Upload & Email Dispatch', () => {
    it('uploads CSV and PDF to storage, generates signed URLs, and sends email', async () => {
      const merchant = {
        id: 'm-1234',
        name: 'Acme SaaS Corp',
        email: 'billing@acme.example.com',
      };
      const window = {
        reportDate: '2026-11-21',
        windowStart: '2026-11-21T00:00:00.000Z',
        windowEnd: '2026-11-22T00:00:00.000Z',
      };
      const summary = {
        grossSettledUsdc: '100.0000000',
        networkFeesXlm: '0.0000100',
        networkFeesStroops: '100',
        failedPullCount: 0,
        activeVaultCount: 1,
        activeVaultBalanceUsdc: '100.0000000',
      };

      const uploads = [];
      const mockSupabase = {
        storage: {
          from: vi.fn(() => ({
            upload: vi.fn(async (path, buffer) => {
              uploads.push({ path, length: buffer.length });
              return { data: { path }, error: null };
            }),
            createSignedUrl: vi.fn(async (path) => ({
              data: { signedUrl: `https://storage.supabase.co/signed/${path}?token=xyz` },
              error: null,
            })),
          })),
        },
      };

      const mockEmailDispatcher = {
        send: vi.fn().mockResolvedValue({ id: 'msg-123', status: 'sent' }),
      };

      const outcome = await storeAndDispatchReconciliationReport(mockSupabase, {
        merchant,
        window,
        summary,
        transactions: [],
        emailDispatcher: mockEmailDispatcher,
      });

      expect(uploads).toHaveLength(2); // CSV and PDF
      expect(outcome.csvSignedUrl).toContain('signed/merchants/m-1234/2026-11-21/reconciliation-2026-11-21.csv');
      expect(outcome.pdfSignedUrl).toContain('signed/merchants/m-1234/2026-11-21/reconciliation-2026-11-21.pdf');

      expect(mockEmailDispatcher.send).toHaveBeenCalledTimes(1);
      const emailArgs = mockEmailDispatcher.send.mock.calls[0][0];
      expect(emailArgs.to).toBe('billing@acme.example.com');
      expect(emailArgs.subject).toContain('2026-11-21');
      expect(emailArgs.html).toContain('100.0000000 USDC');
    });

    it('runs nightly reconciliation job across registered merchants', async () => {
      const mockMerchants = [
        { id: 'm-1', name: 'Alpha SaaS', email: 'alpha@example.com' },
      ];

      const mockSupabase = {
        from: vi.fn((table) => {
          if (table === 'merchants') {
            return {
              select: vi.fn(async () => ({ data: mockMerchants, error: null })),
            };
          }
          if (table === 'payment_transactions') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    gte: vi.fn(() => ({
                      lt: vi.fn(() => ({
                        order: vi.fn(async () => ({ data: [], error: null })),
                      })),
                    })),
                  })),
                })),
              })),
            };
          }
          if (table === 'subscriptions') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(async () => ({ data: [], error: null })),
                })),
              })),
            };
          }
          return {};
        }),
      };

      const result = await runNightlyReconciliationJob(mockSupabase, {
        now: new Date('2026-11-22T00:00:00.000Z'),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(result.merchantsProcessed).toBe(1);
      expect(result.results[0].success).toBe(true);
    });

    it('starts and stops reconciliation cron cleanly', () => {
      const mockSupabase = {};
      const cron = startReconciliationCron(mockSupabase);
      expect(typeof cron.runOnce).toBe('function');
      expect(typeof cron.stop).toBe('function');
      cron.stop();
    });
  });
});

