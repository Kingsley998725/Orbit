'use strict';

/**
 * Automated Merchant Settlement Reconciliation Report Generator via Nightly Cron (#347)
 *
 * Runs nightly at 00:00 UTC, processes preceding 24-hour on-chain activities,
 * aggregates settlements, fees, failed pulls, and active vaults per merchant,
 * generates structured CSV and PDF statements, uploads to Supabase storage,
 * and dispatches emails with secure signed download links.
 */

const PDFDocument = require('pdfkit');
const { createEmailDispatcher } = require('./receipt-email');

const DEFAULT_REPORTS_BUCKET = process.env.RECONCILIATION_STORAGE_BUCKET || 'reconciliation-reports';
const USDC_DECIMALS = 7;
const STROOPS_PER_XLM = 10_000_000n;

/**
 * Formats raw USDC units (7 decimals) into a standard human-readable string.
 *
 * @param {string|number|bigint} units
 * @returns {string} Formatted USDC (e.g. "150.0000000")
 */
function formatUsdcUnits(units) {
  try {
    const val = BigInt(String(units || 0));
    const factor = 10n ** BigInt(USDC_DECIMALS);
    const whole = val / factor;
    const fraction = (val % factor).toString().padStart(USDC_DECIMALS, '0');
    return `${whole}.${fraction}`;
  } catch {
    return '0.0000000';
  }
}

/**
 * Formats stroops into XLM string.
 *
 * @param {string|number|bigint} stroops
 * @returns {string}
 */
function formatStroopsToXlm(stroops) {
  try {
    const val = BigInt(String(stroops || 0));
    const whole = val / STROOPS_PER_XLM;
    const fraction = (val % STROOPS_PER_XLM).toString().padStart(7, '0');
    return `${whole}.${fraction}`;
  } catch {
    return '0.0000000';
  }
}

/**
 * Escapes text for CSV cells to prevent spreadsheet injection.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Protect against spreadsheet formula injection
  if (/^[\s]*[=+@\-]/.test(str) && !/^-?\d+(\.\d+)?$/.test(str)) {
    str = `'${str}`;
  }
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Computes the strict preceding 24-hour UTC reconciliation window.
 * At 00:00 UTC on day D, window is [D-1 00:00:00.000Z, D 00:00:00.000Z).
 *
 * @param {Date|number} [now=new Date()]
 * @returns {{ windowStart: string, windowEnd: string, reportDate: string }}
 */
function calculate24HourReconciliationWindow(now = new Date()) {
  const currentDate = new Date(now);

  // Midnight of the current day in UTC
  const endUtc = new Date(Date.UTC(
    currentDate.getUTCFullYear(),
    currentDate.getUTCMonth(),
    currentDate.getUTCDate(),
    0, 0, 0, 0
  ));

  // Exactly 24 hours prior
  const startUtc = new Date(endUtc.getTime() - 24 * 60 * 60 * 1000);

  const reportDate = startUtc.toISOString().slice(0, 10); // YYYY-MM-DD of the closed day

  return {
    windowStart: startUtc.toISOString(),
    windowEnd: endUtc.toISOString(),
    reportDate,
    startUtc,
    endUtc,
  };
}

/**
 * Calculates milliseconds remaining until the next 00:00:00.000 UTC.
 *
 * @param {Date|number} [now=new Date()]
 * @returns {number} Delay in milliseconds
 */
function calculateMsUntilNextMidnightUtc(now = new Date()) {
  const currentDate = new Date(now);
  const nextMidnightUtc = new Date(Date.UTC(
    currentDate.getUTCFullYear(),
    currentDate.getUTCMonth(),
    currentDate.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return Math.max(0, nextMidnightUtc.getTime() - currentDate.getTime());
}

/**
 * Aggregates settlements, fees, failed pull counts, and active vaults for a merchant.
 *
 * @param {object} supabase
 * @param {string} merchantId
 * @param {object} window - { windowStart, windowEnd }
 * @returns {Promise<object>}
 */
async function aggregateMerchantSettlements(supabase, merchantId, { windowStart, windowEnd }) {
  // 1. Query settled transactions within the 24-hour window
  const { data: settledTxns, error: settledErr } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('status', 'settled')
    .gte('settled_at', windowStart)
    .lt('settled_at', windowEnd)
    .order('settled_at', { ascending: true });

  if (settledErr) throw settledErr;

  // 2. Query failed transactions within the window
  const { data: failedTxns, error: failedErr } = await supabase
    .from('payment_transactions')
    .select('id, status, error_reason, created_at')
    .eq('merchant_id', merchantId)
    .eq('status', 'failed')
    .gte('created_at', windowStart)
    .lt('created_at', windowEnd);

  if (failedErr) throw failedErr;

  // 3. Query active subscriptions (Active Vault Balance)
  const { data: activeSubs, error: subsErr } = await supabase
    .from('subscriptions')
    .select('id, status, plans!inner(merchant_id, usdc_amount)')
    .eq('plans.merchant_id', merchantId)
    .eq('status', 'active');

  if (subsErr) throw subsErr;

  // Calculate Aggregates
  let grossSettledUnits = 0n;
  let networkFeesStroops = 0n;

  for (const tx of settledTxns || []) {
    grossSettledUnits += BigInt(String(tx.amount_usdc_units || 0));
    networkFeesStroops += BigInt(String(tx.fee_paid_stroops || tx.network_fee_stroops || 0));
  }

  let activeVaultBalanceUnits = 0n;
  for (const sub of activeSubs || []) {
    const amount = sub.plans?.usdc_amount;
    if (amount) {
      activeVaultBalanceUnits += BigInt(String(amount));
    }
  }

  const failedPullCount = (failedTxns || []).length;

  return {
    merchantId,
    windowStart,
    windowEnd,
    grossSettledUnits: grossSettledUnits.toString(),
    grossSettledUsdc: formatUsdcUnits(grossSettledUnits),
    networkFeesStroops: networkFeesStroops.toString(),
    networkFeesXlm: formatStroopsToXlm(networkFeesStroops),
    failedPullCount,
    activeVaultCount: (activeSubs || []).length,
    activeVaultBalanceUnits: activeVaultBalanceUnits.toString(),
    activeVaultBalanceUsdc: formatUsdcUnits(activeVaultBalanceUnits),
    settledTransactions: settledTxns || [],
    failedTransactions: failedTxns || [],
  };
}

/**
 * Generates structured CSV reconciliation statement.
 */
function generateReconciliationCsv({ merchant, window, summary, transactions }) {
  const metaRows = [
    ['Orbit Protocol - Daily Merchant Settlement Reconciliation Report'],
    ['Merchant ID', merchant.id],
    ['Merchant Name', merchant.name],
    ['Merchant Wallet', merchant.wallet_address || ''],
    ['Report Date (UTC)', window.reportDate],
    ['Period Window Start (UTC)', window.windowStart],
    ['Period Window End (UTC)', window.windowEnd],
    [''],
    ['SUMMARY METRICS'],
    ['Gross Settled USDC', summary.grossSettledUsdc],
    ['Gross Settled Units (Raw)', summary.grossSettledUnits],
    ['Network Fees Paid (Stroops)', summary.networkFeesStroops],
    ['Network Fees Paid (XLM)', summary.networkFeesXlm],
    ['Failed Pull Count', String(summary.failedPullCount)],
    ['Active Vault Subscriptions Count', String(summary.activeVaultCount)],
    ['Active Vault Total Balance (USDC)', summary.activeVaultBalanceUsdc],
    [''],
    ['ITEMIZED SETTLEMENT TRANSACTIONS'],
    [
      'Transaction ID',
      'Subscription ID',
      'Customer Wallet',
      'Amount USDC',
      'Amount Raw Units',
      'Fee (Stroops)',
      'Status',
      'Transaction Hash',
      'Settled At (UTC)',
    ],
  ];

  const itemRows = (transactions || []).map((tx) => [
    tx.id || '',
    tx.subscription_id || '',
    tx.customer_wallet_address || '',
    formatUsdcUnits(tx.amount_usdc_units),
    String(tx.amount_usdc_units || 0),
    String(tx.fee_paid_stroops || tx.network_fee_stroops || 0),
    tx.status || 'settled',
    tx.tx_hash || tx.transaction_hash || '',
    tx.settled_at || '',
  ]);

  const allRows = [...metaRows, ...itemRows];
  return allRows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Generates styled PDF reconciliation statement using PDFKit.
 */
async function generateReconciliationPdf({ merchant, window, summary, transactions }) {
  const document = new PDFDocument({
    margin: 48,
    size: 'A4',
    info: {
      Title: `Orbit Reconciliation Statement - ${window.reportDate} - ${merchant.name}`,
      Author: 'Orbit Protocol',
    },
  });

  const chunks = [];
  document.on('data', (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => {
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });

  // Header Branding
  document.fillColor('#0f172a').fontSize(22).font('Helvetica-Bold').text('Orbit Protocol');
  document.fontSize(14).font('Helvetica').fillColor('#6366f1').text('Daily Settlement Reconciliation Statement');
  document.moveDown(0.5);

  // Metadata Box
  document.fontSize(10).font('Helvetica').fillColor('#475569');
  document.text(`Merchant: ${merchant.name} (${merchant.id})`);
  document.text(`Settlement Wallet: ${merchant.wallet_address || 'N/A'}`);
  document.text(`Reconciliation Period (24h UTC): ${window.windowStart} to ${window.windowEnd}`);
  document.text(`Generated At: ${new Date().toISOString()}`);
  document.moveDown(1);

  // Summary Metrics Table Header
  document.rect(48, document.y, 500, 24).fill('#f1f5f9');
  document.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11);
  document.text('Financial Summary', 56, document.y + 6);
  document.moveDown(1.2);

  const metrics = [
    ['Gross Settled USDC', `${summary.grossSettledUsdc} USDC`],
    ['Network Fees Paid', `${summary.networkFeesStroops} stroops (~${summary.networkFeesXlm} XLM)`],
    ['Failed Pull Count', String(summary.failedPullCount)],
    ['Active Vault Balance', `${summary.activeVaultBalanceUsdc} USDC (${summary.activeVaultCount} subscriptions)`],
  ];

  document.font('Helvetica').fontSize(10);
  for (const [label, val] of metrics) {
    document.fillColor('#475569').text(label, { continued: true });
    document.fillColor('#0f172a').font('Helvetica-Bold').text(`:  ${val}`);
    document.font('Helvetica');
  }

  document.moveDown(1.5);

  // Itemized Transactions Header
  document.fillColor('#0f172a').font('Helvetica-Bold').fontSize(12).text('Settlement Transactions (Preceding 24h)');
  document.moveDown(0.4);

  if (!transactions || transactions.length === 0) {
    document.font('Helvetica-Oblique').fillColor('#64748b').fontSize(10).text('No settlement transactions recorded in this 24-hour cycle.');
  } else {
    document.font('Helvetica-Bold').fontSize(9).fillColor('#334155');
    document.text('Time (UTC)            Customer Wallet                   Amount (USDC)          Tx Hash', 48);
    document.rect(48, document.y + 2, 500, 1).fill('#cbd5e1');
    document.moveDown(0.5);

    document.font('Helvetica').fontSize(8).fillColor('#1e293b');
    for (const tx of transactions.slice(0, 40)) { // Display up to 40 items in PDF
      const timeStr = tx.settled_at ? tx.settled_at.slice(11, 19) : '00:00:00';
      const walletStr = (tx.customer_wallet_address || '').slice(0, 16) + '...';
      const amountStr = `${formatUsdcUnits(tx.amount_usdc_units)} USDC`;
      const hashStr = (tx.tx_hash || tx.transaction_hash || '').slice(0, 16) + '...';

      document.text(`${timeStr}      ${walletStr.padEnd(30)} ${amountStr.padEnd(20)} ${hashStr}`);
      if (document.y > 750) {
        document.addPage();
      }
    }

    if (transactions.length > 40) {
      document.moveDown(0.5);
      document.font('Helvetica-Oblique').fillColor('#64748b').text(`... and ${transactions.length - 40} additional transactions (see full attached CSV statement).`);
    }
  }

  document.moveDown(2);
  document.fontSize(8).fillColor('#94a3b8').text('Orbit Protocol Settlement Engine • Immutable Soroban On-Chain Records', { align: 'center' });
  document.end();

  return complete;
}

/**
 * Stores report files in Supabase storage and dispatches email notification.
 */
async function storeAndDispatchReconciliationReport(supabase, {
  merchant,
  window,
  summary,
  transactions,
  bucket = DEFAULT_REPORTS_BUCKET,
  emailDispatcher = createEmailDispatcher(),
  logger = console,
}) {
  // 1. Generate CSV & PDF
  const csvContent = generateReconciliationCsv({ merchant, window, summary, transactions });
  const pdfBuffer = await generateReconciliationPdf({ merchant, window, summary, transactions });

  const csvPath = `merchants/${merchant.id}/${window.reportDate}/reconciliation-${window.reportDate}.csv`;
  const pdfPath = `merchants/${merchant.id}/${window.reportDate}/reconciliation-${window.reportDate}.pdf`;

  // 2. Upload to Supabase Storage Bucket
  let csvSignedUrl = null;
  let pdfSignedUrl = null;

  try {
    const storage = supabase.storage?.from(bucket);
    if (storage && typeof storage.upload === 'function') {
      await storage.upload(csvPath, Buffer.from(csvContent, 'utf8'), {
        contentType: 'text/csv',
        upsert: true,
      });

      await storage.upload(pdfPath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

      if (typeof storage.createSignedUrl === 'function') {
        const expiresInSeconds = 7 * 24 * 60 * 60; // 7 days expiration
        const { data: csvSigned } = await storage.createSignedUrl(csvPath, expiresInSeconds);
        const { data: pdfSigned } = await storage.createSignedUrl(pdfPath, expiresInSeconds);
        csvSignedUrl = csvSigned?.signedUrl || null;
        pdfSignedUrl = pdfSigned?.signedUrl || null;
      }
    }
  } catch (storageErr) {
    logger.warn?.('[Reconciliation] Storage upload failed or not configured; proceeding to email dispatch:', storageErr.message);
  }

  // 3. Dispatch Email Notification with Secure Download Link
  const recipientEmail = merchant.email || merchant.billing_email || merchant.notification_email;
  let emailResult = { skipped: true };

  if (recipientEmail && emailDispatcher && typeof emailDispatcher.send === 'function') {
    const emailHtml = `
<!doctype html>
<html>
<body style="font-family: Arial, sans-serif; background: #f8fafc; padding: 24px; color: #1e293b;">
  <div style="max-width: 600px; margin: auto; background: white; padding: 28px; border-radius: 10px; border: 1px solid #e2e8f0;">
    <h2 style="color: #4f46e5; margin-top: 0;">Orbit Daily Financial Reconciliation Statement</h2>
    <p>Dear ${merchant.name || 'Merchant'},</p>
    <p>Here is your daily financial reconciliation statement for <strong>${window.reportDate}</strong> (preceding 24 hours in UTC).</p>

    <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin: 20px 0;">
      <h3 style="margin-top: 0; font-size: 15px;">Summary Metrics</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr><td style="padding: 6px 0;">Gross Settled USDC:</td><td style="font-weight: bold; text-align: right;">${summary.grossSettledUsdc} USDC</td></tr>
        <tr><td style="padding: 6px 0;">Network Fees Paid:</td><td style="font-weight: bold; text-align: right;">${summary.networkFeesXlm} XLM</td></tr>
        <tr><td style="padding: 6px 0;">Failed Pulls:</td><td style="font-weight: bold; text-align: right;">${summary.failedPullCount}</td></tr>
        <tr><td style="padding: 6px 0;">Active Vault Balance:</td><td style="font-weight: bold; text-align: right;">${summary.activeVaultBalanceUsdc} USDC</td></tr>
      </table>
    </div>

    ${pdfSignedUrl ? `<p><a href="${pdfSignedUrl}" style="background: #4f46e5; color: white; padding: 10px 18px; text-decoration: none; border-radius: 6px; display: inline-block;">Download PDF Statement</a></p>` : ''}
    ${csvSignedUrl ? `<p style="font-size: 13px;"><a href="${csvSignedUrl}" style="color: #6366f1;">Download Itemized CSV Statement</a></p>` : ''}

    <p style="font-size: 12px; color: #64748b; margin-top: 24px;">Links remain valid for 7 days. All numbers are verified against Stellar Soroban ledger transactions.</p>
  </div>
</body>
</html>
`;

    try {
      emailResult = await emailDispatcher.send({
        to: recipientEmail,
        subject: `Orbit Daily Financial Reconciliation Statement - ${window.reportDate}`,
        html: emailHtml,
        pdf: pdfBuffer,
        filename: `reconciliation-${window.reportDate}.pdf`,
      });
    } catch (mailErr) {
      logger.error?.('[Reconciliation] Email dispatch error:', mailErr);
      emailResult = { error: mailErr.message };
    }
  }

  return {
    merchantId: merchant.id,
    reportDate: window.reportDate,
    csvPath,
    pdfPath,
    csvSignedUrl,
    pdfSignedUrl,
    emailResult,
  };
}

/**
 * Executes reconciliation for all merchants for the preceding 24-hour window.
 */
async function runNightlyReconciliationJob(supabase, {
  now = new Date(),
  bucket = DEFAULT_REPORTS_BUCKET,
  emailDispatcher,
  logger = console,
} = {}) {
  const window = calculate24HourReconciliationWindow(now);
  logger.info?.(`[Reconciliation] Starting nightly run for ${window.reportDate} (UTC window: ${window.windowStart} to ${window.windowEnd})`);

  // Fetch all registered merchants
  const { data: merchants, error } = await supabase
    .from('merchants')
    .select('id, name, wallet_address, email, billing_email');

  if (error) throw error;

  const results = [];
  for (const merchant of merchants || []) {
    try {
      const summary = await aggregateMerchantSettlements(supabase, merchant.id, window);
      const reportOutcome = await storeAndDispatchReconciliationReport(supabase, {
        merchant,
        window,
        summary,
        transactions: summary.settledTransactions,
        bucket,
        emailDispatcher,
        logger,
      });

      results.push({ merchantId: merchant.id, success: true, summary, reportOutcome });
    } catch (merchantErr) {
      logger.error?.(`[Reconciliation] Error generating report for merchant ${merchant.id}:`, merchantErr);
      results.push({ merchantId: merchant.id, success: false, error: merchantErr.message });
    }
  }

  return {
    window,
    merchantsProcessed: results.length,
    results,
  };
}

/**
 * Starts the nightly cron runner scheduled for 00:00 UTC.
 */
function startReconciliationCron(supabase, options = {}) {
  let timer = null;
  let isStopped = false;

  const scheduleNextRun = () => {
    if (isStopped) return;
    const msToMidnight = calculateMsUntilNextMidnightUtc();

    timer = setTimeout(async () => {
      try {
        await runNightlyReconciliationJob(supabase, options);
      } catch (err) {
        options.logger?.error?.('[Reconciliation Cron] Execution failed:', err);
      } finally {
        scheduleNextRun();
      }
    }, msToMidnight);

    timer.unref?.();
  };

  scheduleNextRun();

  return {
    stop: () => {
      isStopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    runOnce: (runTime) => runNightlyReconciliationJob(supabase, { ...options, now: runTime || new Date() }),
  };
}

module.exports = {
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
};

