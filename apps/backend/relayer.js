// Fee-bump relayer: submits merchant pulls on the merchant's behalf and pays the network fees.
//
// The merchant never builds, funds or sequences a transaction. They sign only the Soroban
// authorization entry for pull_funds (the contract's merchant.require_auth()). The relayer
// places that entry in a transaction sourced from one of its channel accounts, wraps it in
// a FeeBumpTransaction whose fee source is the Orbit relayer account, and submits it.
//
// Because the merchant's signature covers the invocation and not the transaction, the
// relayer can rebuild and resubmit with a fresh sequence number on txBadSeq or
// TRY_AGAIN_LATER without asking the merchant to sign again.
const {
    Keypair, Account, Address, Operation, TransactionBuilder, Networks, BASE_FEE, xdr, hash,
    inspectAuthEntry, buildAuthorizationEntryPreimage, rpc,
} = require('@stellar/stellar-sdk');
const { RelayerError, isRelayerError } = require('./relayer-error');
const { policyFromEnv, validateSponsoredTransaction } = require('./sponsorship');

const DEFAULTS = {
    // Fee bump inclusion fee per operation, in stroops
    baseFee: Number(BASE_FEE),
    // Upper bound on the total fee the relayer will sponsor for a single pull
    maxFeeStroops: 5_000_000,
    dailyFeeLimitStroops: 50_000_000,
    maxAttempts: 3,
    retryDelayMs: 1000,
    queueTimeoutMs: 30000,
    // How long a prepared authorization stays signable (~5s per ledger)
    authValidityLedgers: 100,
    // Highest inclusion fee per operation the relayer will offer when sponsoring a
    // subscriber's transaction (#297), however congested the network is
    maxBaseFeeStroops: 10_000,
    txTimeoutSeconds: 60,
    pendingLedgersBeforeBump: 2,
    maxFeeBumps: 2,
};

const ADDRESS_CREDENTIAL_TYPES = ['address', 'addressV2'];

// Extracts the transaction result code, unwrapping the inner result of a fee bump
const resultCode = (txResult) => {
    const type = txResult?.result?.type;
    if (type === 'txFeeBumpInnerFailed' || type === 'txFeeBumpInnerSuccess') {
        return txResult.result.innerResultPair?.result?.result?.type ?? type;
    }
    return type ?? null;
};

const pullArgs = (user, merchant) => [new Address(user).toScVal(), new Address(merchant).toScVal()];

// The exact invocation a merchant must authorize: pull_funds(user, merchant) with no sub-calls
const pullInvocation = (contractId, user, merchant) => new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName: 'pull_funds',
        args: pullArgs(user, merchant),
    })),
    subInvocations: [],
});

// ==========================================
// SEQUENCE MANAGER
// ==========================================
// Caches the last used sequence number per source account. Reading the sequence from the
// ledger for every transaction would hand a stale number to the next transaction while an
// earlier one is still pending, so the cache only advances when a submission is accepted
// and is dropped (re-read from the ledger) after a txBadSeq.
class SequenceManager {
    constructor(server, redisClient = null) {
        this.server = server;
        this.redisClient = redisClient;
        this.sequences = new Map();
    }

    // Returns an Account whose next built transaction uses the next free sequence number
    async account(publicKey) {
        if (this.redisClient) {
            const sharedSequence = await this.redisClient.get(this.keyFor(publicKey));
            if (sharedSequence !== null) {
                this.sequences.set(publicKey, sharedSequence);
            } else {
                const onChain = await this.server.getAccount(publicKey);
                const sequence = onChain.sequenceNumber();
                await this.redisClient.set(this.keyFor(publicKey), sequence, 'PX', 24 * 60 * 60 * 1000, 'NX');
                const initializedSequence = await this.redisClient.get(this.keyFor(publicKey));
                this.sequences.set(publicKey, initializedSequence ?? sequence);
            }
        } else if (!this.sequences.has(publicKey)) {
            const onChain = await this.server.getAccount(publicKey);
            this.sequences.set(publicKey, onChain.sequenceNumber());
        }
        return new Account(publicKey, this.sequences.get(publicKey));
    }

    keyFor(publicKey) {
        return `orbit:stellar:sequence:${publicKey}`;
    }

    async commit(publicKey, usedSequence) {
        this.sequences.set(publicKey, usedSequence);
        if (this.redisClient) {
            await this.redisClient.set(this.keyFor(publicKey), usedSequence, 'PX', 24 * 60 * 60 * 1000);
        }
    }

    async invalidate(publicKey) {
        this.sequences.delete(publicKey);
        if (this.redisClient) await this.redisClient.del(this.keyFor(publicKey));
    }
}

const RELEASE_SEQUENCE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

class SourceAccountMutex {
    constructor(redisClient, { timeoutMs, lockTtlMs = 10 * 60 * 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
        this.redisClient = redisClient;
        this.timeoutMs = timeoutMs;
        this.lockTtlMs = lockTtlMs;
        this.sleep = sleep;
        this.localLocks = new Map();
    }

    async acquire(publicKey) {
        const releaseLocal = await this.acquireLocal(publicKey);
        if (!this.redisClient) return releaseLocal;

        const key = `orbit:stellar:sequence-lock:${publicKey}`;
        const token = crypto.randomUUID();
        const deadline = Date.now() + this.timeoutMs;
        try {
            while (Date.now() < deadline) {
                if (await this.redisClient.set(key, token, 'PX', this.lockTtlMs, 'NX') === 'OK') {
                    return () => {
                        this.redisClient.eval(RELEASE_SEQUENCE_LOCK_LUA, 1, key, token)
                            .catch((error) => console.error(`Failed to release sequence lock for ${publicKey}:`, error))
                            .finally(releaseLocal);
                    };
                }
                await this.sleep(25);
            }
            throw new RelayerError('relayer_busy', 503, 'Source account is busy, please retry later', { retryAfter: 5 });
        } catch (error) {
            releaseLocal();
            throw error;
        }
    }

    acquireLocal(publicKey) {
        const state = this.localLocks.get(publicKey);
        if (!state) {
            this.localLocks.set(publicKey, { waiters: [] });
            return Promise.resolve(() => this.releaseLocal(publicKey));
        }
        return new Promise((resolve) => state.waiters.push(resolve));
    }

    releaseLocal(publicKey) {
        const state = this.localLocks.get(publicKey);
        const next = state?.waiters.shift();
        if (next) next(() => this.releaseLocal(publicKey));
        else this.localLocks.delete(publicKey);
    }
}

// ==========================================
// CHANNEL POOL
// ==========================================
// Hands out channel accounts one relay at a time, so no two in-flight transactions share a
// source account. Callers beyond the pool size wait in FIFO order up to queueTimeoutMs.
class ChannelPool {
    constructor(keypairs, { queueTimeoutMs = DEFAULTS.queueTimeoutMs } = {}) {
        if (keypairs.length === 0) throw new Error('ChannelPool needs at least one channel account');
        this.idle = [...keypairs];
        this.waiters = [];
        this.queueTimeoutMs = queueTimeoutMs;
    }

    get queued() {
        return this.waiters.length;
    }

    acquire() {
        if (this.idle.length > 0) return Promise.resolve(this.idle.shift());

        return new Promise((resolve, reject) => {
            const waiter = { resolve };
            waiter.timer = setTimeout(() => {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                reject(new RelayerError('relayer_busy', 503, 'All relayer channels are busy, please retry later', { retryAfter: 5 }));
            }, this.queueTimeoutMs);
            this.waiters.push(waiter);
        });
    }

    release(keypair) {
        const waiter = this.waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(keypair);
        } else {
            this.idle.push(keypair);
        }
    }
}

// ==========================================
// FEE BUDGET (Supabase)
// ==========================================
// Daily per-merchant sponsorship budget. reserve_relayer_fee atomically books the maximum
// fee before submission; the booking is later corrected to the fee actually charged.
const createSupabaseFeeBudget = (getSupabase, { dailyLimitStroops = DEFAULTS.dailyFeeLimitStroops } = {}) => ({
    dailyLimitStroops,

    // Returns the UTC usage date the amount was booked against, or null if over budget
    async reserve(merchantId, amount) {
        const { data, error } = await getSupabase().rpc('reserve_relayer_fee', {
            p_merchant_id: merchantId,
            p_amount: amount,
            p_daily_limit: dailyLimitStroops,
        });
        if (error) throw error;
        return data ?? null;
    },

    async adjust(merchantId, usageDate, feeDelta, txDelta) {
        const { error } = await getSupabase().rpc('adjust_relayer_fee', {
            p_merchant_id: merchantId,
            p_usage_date: usageDate,
            p_fee_delta: feeDelta,
            p_tx_delta: txDelta,
        });
        if (error) throw error;
    },

    async usage(merchantId) {
        const usageDate = new Date().toISOString().slice(0, 10);
        const { data, error } = await getSupabase()
            .from('relayer_fee_usage')
            .select('fee_stroops, tx_count')
            .eq('merchant_id', merchantId)
            .eq('usage_date', usageDate)
            .maybeSingle();
        if (error) throw error;
        return { usageDate, feeStroops: Number(data?.fee_stroops ?? 0), txCount: data?.tx_count ?? 0 };
    },
});

// ==========================================
// RELAYER
// ==========================================
const createRelayer = ({
    server,
    sponsor,
    channels = [sponsor],
    contractId,
    networkPassphrase = Networks.TESTNET,
    budget,
    logger = console,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    feeEstimator = null,
    sponsorshipPolicy = null,
    redisClient = null,
    options = {},
}) => {
    const opts = { ...DEFAULTS, ...options };
    const pool = new ChannelPool(channels, { queueTimeoutMs: opts.queueTimeoutMs });
    const sequences = new SequenceManager(server, redisClient);
    const sourceAccountMutex = new SourceAccountMutex(redisClient, {
        timeoutMs: opts.queueTimeoutMs,
        lockTtlMs: opts.distributedSequenceLockTtlMs,
        sleep,
    });

    const buildInner = (account, user, merchant, auth) =>
        new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
            .addOperation(Operation.invokeContractFunction({
                contract: contractId,
                function: 'pull_funds',
                args: pullArgs(user, merchant),
                auth,
            }))
            .setTimeout(opts.txTimeoutSeconds)
            .build();

    // Simulates the pull and returns the merchant's unsigned authorization entry
    const preparePullAuthorization = async ({ user, merchant }) => {
        // Simulation ignores the sequence number, so the sponsor account needs no lookup
        const tx = buildInner(new Account(sponsor.publicKey(), '0'), user, merchant, []);
        const sim = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(sim)) {
            throw new RelayerError('simulation_failed', 422, `Pull cannot be executed: ${sim.error}`);
        }

        const entry = (sim.result?.auth ?? []).find((candidate) => inspectAuthEntry(candidate).address === merchant);
        if (!entry) throw new RelayerError('simulation_failed', 422, 'Simulation did not request a merchant authorization');

        return {
            authEntryXdr: entry.toXdr('base64'),
            validUntilLedger: sim.latestLedger + opts.authValidityLedgers,
        };
    };

    // Parses a signed authorization entry and checks it authorizes exactly this pull for this merchant
    const verifyPullAuthorization = async ({ entryXdr, user, merchant }) => {
        let entry;
        try {
            entry = xdr.SorobanAuthorizationEntry.fromXdr(entryXdr, 'base64');
        } catch {
            throw new RelayerError('invalid_authorization', 400, 'signed_auth_entry_xdr is not a valid Soroban authorization entry');
        }

        const info = inspectAuthEntry(entry);
        const expected = pullInvocation(contractId, user, merchant);
        if (!ADDRESS_CREDENTIAL_TYPES.includes(info.credentialType) || info.address !== merchant
            || entry.rootInvocation.toXdr('base64') !== expected.toXdr('base64')) {
            throw new RelayerError('invalid_authorization', 400, "Authorization does not match this subscription's pull");
        }

        const { sequence: latestLedger } = await server.getLatestLedger();
        if (info.signatureExpirationLedger <= latestLedger) {
            throw new RelayerError('authorization_expired', 400, 'Authorization has expired, prepare the pull again');
        }

        const payload = hash(buildAuthorizationEntryPreimage(entry, info.signatureExpirationLedger, networkPassphrase).toXdr());
        const merchantKey = Keypair.fromPublicKey(merchant);
        const signed = info.signers.some((signer) => (signer.signatures ?? []).some(({ publicKey, signature }) =>
            publicKey === merchant && merchantKey.verify(payload, signature)));
        if (!signed) {
            throw new RelayerError('invalid_signature', 401, 'A valid merchant wallet signature is required');
        }
        return entry;
    };

    const adjustBudget = async (merchantId, reservation, feeDelta, txDelta) => {
        try {
            await budget.adjust(merchantId, reservation.usageDate, feeDelta, txDelta);
        } catch (err) {
            // Not fatal: the booking stays at the reserved maximum, which errs on the safe side
            logger.error('Error adjusting relayer fee budget:', err);
        }
    };

    // Submits the pull as a sponsored fee bump and waits for confirmation via `confirm(server, hash)`
    const relayPull = async ({ merchantId, entry, user, merchant, confirm, onSubmitted }) => {
        const channel = await pool.acquire();
        let reservation = null;
        let submitted = null;
        let releaseSourceAccount;

        try {
            releaseSourceAccount = await sourceAccountMutex.acquire(channel.publicKey());
            for (let attempt = 1; ; attempt += 1) {
                const account = await sequences.account(channel.publicKey());
                let prepared;
                try {
                    prepared = await server.prepareTransaction(buildInner(account, user, merchant, [entry]));
                } catch (err) {
                    throw new RelayerError('simulation_failed', 422, `Pull cannot be executed: ${err.message}`);
                }
                prepared.sign(channel);

                const initialBaseFee = feeEstimator ? await feeEstimator.estimate({ priority: 'high' }) : opts.baseFee;
                const feeBump = TransactionBuilder.buildFeeBumpTransaction(sponsor, String(initialBaseFee), prepared, networkPassphrase);
                feeBump.sign(sponsor);
                let activeFeeBump = feeBump;
                let fee = Number(activeFeeBump.fee);
                if (fee > opts.maxFeeStroops) {
                    throw new RelayerError('fee_cap_exceeded', 422, `Pull fee of ${fee} stroops exceeds the relayer cap of ${opts.maxFeeStroops}`);
                }

                // Book the fee before spending it; a retry whose fee grew books the difference
                const shortfall = fee - (reservation?.amount ?? 0);
                if (shortfall > 0) {
                    const usageDate = await budget.reserve(merchantId, shortfall);
                    if (!usageDate) {
                        throw new RelayerError('daily_budget_exceeded', 429, 'Daily gas sponsorship budget exceeded for this merchant', { retryAfter: 3600 });
                    }
                    reservation = { usageDate: reservation?.usageDate ?? usageDate, amount: fee };
                }

                let response;
                try {
                    response = await server.sendTransaction(activeFeeBump);
                } catch (err) {
                    // Unknown whether it was accepted: re-read the sequence next time and keep the booking
                    await sequences.invalidate(channel.publicKey());
                    reservation = null;
                    throw err;
                }

                if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
                    submitted = { hash: response.hash, attempts: attempt, innerTransaction: prepared, fee };
                    await sequences.commit(channel.publicKey(), prepared.sequence);
                    if (onSubmitted) await onSubmitted({ txHash: submitted.hash, attempts: attempt });
                    break;
                }

                const code = response.status === 'ERROR' ? resultCode(response.errorResult) : null;
                if (response.status !== 'TRY_AGAIN_LATER' && code !== 'txBadSeq') {
                    throw new RelayerError('submission_rejected', 502, `Relayer submission rejected: ${code ?? response.status}`);
                }
                if (code === 'txBadSeq') await sequences.invalidate(channel.publicKey());
                logger.warn(`Relayer retrying pull after ${code ?? response.status} (attempt ${attempt}/${opts.maxAttempts})`);

                if (attempt >= opts.maxAttempts) {
                    throw new RelayerError('relayer_busy', 503, 'Relayer could not submit the pull, please retry later', { retryAfter: 5 });
                }
                await sleep(opts.retryDelayMs * attempt);
            }

            releaseSourceAccount?.();
            releaseSourceAccount = null;
            const firstLedger = (await server.getLatestLedger()).sequence;
            let confirmation = await confirm(server, submitted.hash);
            // Fee escalation replaces only the outer fee-paying envelope. The exact signed
            // inner source/sequence is reused, so Stellar can settle the pull at most once.
            let bumps = 0;
            while (confirmation.status === 'NOT_FOUND' && bumps < opts.maxFeeBumps) {
                const currentLedger = (await server.getLatestLedger()).sequence;
                const pendingLedgers = currentLedger - firstLedger;
                if (pendingLedgers < opts.pendingLedgersBeforeBump) break;
                bumps += 1;
                const baseFee = feeEstimator ? await feeEstimator.estimate({ priority: 'high', pendingLedgers }) : Math.min(opts.maxFeeStroops, opts.baseFee * (2 ** bumps));
                const replacement = TransactionBuilder.buildFeeBumpTransaction(sponsor, String(baseFee), submitted.innerTransaction, networkPassphrase);
                replacement.sign(sponsor);
                const replacementFee = Number(replacement.fee);
                if (replacementFee <= submitted.fee || replacementFee > opts.maxFeeStroops) break;
                const shortfall = replacementFee - reservation.amount;
                if (shortfall > 0) {
                    const usageDate = await budget.reserve(merchantId, shortfall);
                    if (!usageDate) throw new RelayerError('daily_budget_exceeded', 429, 'Daily gas sponsorship budget exceeded for this merchant', { retryAfter: 3600 });
                    reservation.amount = replacementFee;
                }
                const bumped = await server.sendTransaction(replacement);
                if (!['PENDING', 'DUPLICATE', 'SUCCESS'].includes(bumped.status)) break;
                submitted.fee = replacementFee;
                fee = replacementFee;
                submitted.hash = bumped.hash || submitted.hash;
                submitted.attempts += 1;
                confirmation = await confirm(server, submitted.hash);
            }
            const charged = confirmation.resultXdr?.feeCharged;
            const feeCharged = charged === undefined || charged === null ? null : Number(charged);
            // Settle the booking to the actual fee; an unconfirmed transaction keeps the maximum
            await adjustBudget(merchantId, reservation, feeCharged === null ? 0 : feeCharged - reservation.amount, 1);

            return { status: confirmation.status, txHash: submitted.hash, feeCharged, attempts: submitted.attempts };
        } catch (err) {
            if (reservation && !submitted) await adjustBudget(merchantId, reservation, -reservation.amount, 0);
            throw err;
        } finally {
            releaseSourceAccount?.();
            pool.release(channel);
        }
    };

    const budgetStatus = async (merchantId) => {
        const { usageDate, feeStroops, txCount } = await budget.usage(merchantId);
        return {
            usage_date: usageDate,
            daily_limit_stroops: budget.dailyLimitStroops,
            used_stroops: feeStroops,
            remaining_stroops: Math.max(0, budget.dailyLimitStroops - feeStroops),
            sponsored_transactions: txCount,
        };
    };

    /**
     * Sponsors a subscriber-signed transaction (#297): checks it against the sponsorship
     * policy, simulates it, wraps it in a fee bump paid by the sponsor within the fee caps,
     * books the fee against the merchant's daily budget, submits it and waits for the
     * result. Nothing is signed or spent until every check has passed.
     *
     * `resolveMerchant(walletAddress)` returns the registered merchant `{ id }` for the
     * vault's recipient, or null; unknown recipients are refused.
     */
    const sponsorUserTransaction = async ({ txXdr, resolveMerchant, confirm }) => {
        if (!sponsorshipPolicy) {
            throw new RelayerError('sponsorship_unavailable', 503, 'Transaction sponsorship is not configured');
        }
        let innerTx;
        try {
            innerTx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
        } catch {
            throw new RelayerError('invalid_transaction', 400, 'signed_tx_xdr is not a valid transaction envelope');
        }

        const { merchant: merchantAddress } = validateSponsoredTransaction(innerTx, sponsorshipPolicy);
        const merchant = await resolveMerchant(merchantAddress);
        if (!merchant) {
            throw new RelayerError('recipient_not_allowed', 403, `Vault recipient ${merchantAddress} is not a registered Orbit merchant`);
        }

        // A transaction that would fail still costs the sponsor its fee, so never submit one
        const sim = await server.simulateTransaction(innerTx);
        if (rpc.Api.isSimulationError(sim)) {
            throw new RelayerError('simulation_failed', 422, `Transaction cannot be executed: ${sim.error}`);
        }

        // The caller never chooses the fee. The relayer offers its own estimate, clamped to
        // the base fee cap, and refuses outright if the total would exceed the fee cap.
        const estimate = feeEstimator ? await feeEstimator.estimate({ priority: 'high' }) : opts.baseFee;
        const baseFee = Math.max(Number(BASE_FEE), Math.min(Number(estimate), opts.maxBaseFeeStroops));
        const feeBump = TransactionBuilder.buildFeeBumpTransaction(sponsor, String(baseFee), innerTx, networkPassphrase);
        const fee = Number(feeBump.fee);
        if (fee > opts.maxFeeStroops) {
            throw new RelayerError('fee_cap_exceeded', 422, `Sponsorship fee of ${fee} stroops exceeds the relayer cap of ${opts.maxFeeStroops}`);
        }

        const usageDate = await budget.reserve(merchant.id, fee);
        if (!usageDate) {
            throw new RelayerError('daily_budget_exceeded', 429, 'Daily gas sponsorship budget exceeded for this merchant', { retryAfter: 3600 });
        }
        const reservation = { usageDate, amount: fee };

        feeBump.sign(sponsor);
        let response;
        try {
            response = await server.sendTransaction(feeBump);
        } catch (err) {
            // Unknown whether it was accepted: keep the booking at the maximum
            throw new RelayerError('submission_failed', 502, `Could not submit the sponsored transaction: ${err.message}`);
        }
        if (response.status !== 'PENDING' && response.status !== 'DUPLICATE') {
            await adjustBudget(merchant.id, reservation, -fee, 0);
            if (response.status === 'TRY_AGAIN_LATER') {
                throw new RelayerError('relayer_busy', 503, 'The network asked to retry later', { retryAfter: 5 });
            }
            const code = response.status === 'ERROR' ? resultCode(response.errorResult) : null;
            throw new RelayerError('submission_rejected', 502, `Sponsored transaction rejected: ${code ?? response.status}`);
        }

        const confirmation = await confirm(server, response.hash);
        const charged = confirmation.resultXdr?.feeCharged;
        const feeCharged = charged === undefined || charged === null ? null : Number(charged);
        await adjustBudget(merchant.id, reservation, feeCharged === null ? 0 : feeCharged - fee, 1);
        logger.info?.(`Sponsored transaction ${response.hash} for merchant ${merchant.id}: ${confirmation.status}, fee ${feeCharged ?? fee} stroops`);

        return {
            status: confirmation.status,
            txHash: response.hash,
            feeCharged,
            maxFee: fee,
            merchantId: merchant.id,
        };
    };

    return {
        sponsorAddress: sponsor.publicKey(),
        sponsorKeypair: sponsor,
        pool,
        sequences,
        preparePullAuthorization,
        verifyPullAuthorization,
        relayPull,
        budgetStatus,
        sponsorUserTransaction,
    };
};

// Builds the relayer from RELAYER_* env vars; returns null when no relayer key is configured
const createRelayerFromEnv = ({ server, getSupabase, feeEstimator, redisClient = null, env = process.env }) => {
    if (!env.RELAYER_SECRET_KEY || !env.ORBIT_CONTRACT_ID) return null;

    const envNumber = (name) => (env[name] ? Number(env[name]) : undefined);
    const options = Object.fromEntries(Object.entries({
        baseFee: envNumber('RELAYER_BASE_FEE'),
        maxFeeStroops: envNumber('RELAYER_MAX_FEE_STROOPS'),
        maxAttempts: envNumber('RELAYER_MAX_ATTEMPTS'),
        queueTimeoutMs: envNumber('RELAYER_QUEUE_TIMEOUT_MS'),
        authValidityLedgers: envNumber('RELAYER_AUTH_VALIDITY_LEDGERS'),
        maxBaseFeeStroops: envNumber('RELAYER_MAX_BASE_FEE_STROOPS'),
        distributedSequenceLockTtlMs: envNumber('RELAYER_SEQUENCE_LOCK_TTL_MS'),
    }).filter(([, value]) => value !== undefined));

    const sponsor = Keypair.fromSecret(env.RELAYER_SECRET_KEY);
    const channelSecrets = (env.RELAYER_CHANNEL_SECRET_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const channels = channelSecrets.length > 0 ? channelSecrets.map((s) => Keypair.fromSecret(s)) : [sponsor];
    const networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;

    return createRelayer({
        server,
        sponsor,
        channels,
        contractId: env.ORBIT_CONTRACT_ID,
        networkPassphrase,
        // Every relayer account is excluded as a source or signer of sponsored transactions
        sponsorshipPolicy: policyFromEnv({
            env,
            relayerAccounts: [sponsor, ...channels].map((kp) => kp.publicKey()),
            networkPassphrase,
        }),
        budget: createSupabaseFeeBudget(getSupabase, {
            dailyLimitStroops: envNumber('RELAYER_DAILY_FEE_LIMIT_STROOPS') ?? DEFAULTS.dailyFeeLimitStroops,
        }),
        feeEstimator,
        redisClient,
        options,
    });
};

module.exports = {
    RelayerError,
    isRelayerError,
    SequenceManager,
    ChannelPool,
    createRelayer,
    createRelayerFromEnv,
    createSupabaseFeeBudget,
    pullInvocation,
    resultCode,
};
