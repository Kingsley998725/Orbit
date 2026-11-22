const crypto = require('crypto');
const { z } = require('zod');

// Rolling window used for the per-endpoint failure rate (15 minutes).
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MERCHANT_ALERT_THROTTLE_MS = 15 * 60 * 1000;
// Opens an incident once this many outages happen back to back on one endpoint.
const CONSECUTIVE_FAILURE_THRESHOLD = 5;
const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';
const lastMerchantAlertAt = new Map();

const ALERT_CHANNEL_TYPES = ['slack', 'pagerduty', 'email', 'discord', 'telegram'];

const alertChannelSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('slack'),
        config: z.object({
            webhook_url: z.string().url().refine((u) => u.startsWith('https://hooks.slack.com/'), 'webhook_url must be a Slack Incoming Webhook URL'),
        }),
    }),
    z.object({
        type: z.literal('pagerduty'),
        config: z.object({
            routing_key: z.string().min(16, 'routing_key must be a PagerDuty Events API v2 integration key'),
        }),
    }),
    z.object({
        type: z.literal('email'),
        config: z.object({
            email: z.string().email('email must be a valid address'),
        }),
    }),
    z.object({
        type: z.literal('discord'),
        config: z.object({
            webhook_url: z.string().url().refine(
                (url) => /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url),
                'webhook_url must be a Discord webhook URL',
            ),
        }),
    }),
    z.object({
        type: z.literal('telegram'),
        config: z.object({
            chat_id: z.union([
                z.string().min(1).max(128),
                z.number().int().transform(String),
            ]),
        }),
    }),
]);

// An outage is a connection failure or any 5xx response. A 2xx is a success and
// is the only signal that resolves an incident. Other 4xx responses are neutral:
// they don't open incidents and don't reset the consecutive-failure counter.
const classifyStatus = (responseStatus) => {
    if (responseStatus === 0 || responseStatus >= 500) return 'outage';
    if (responseStatus >= 200 && responseStatus < 300) return 'success';
    return 'neutral';
};

/**
 * In-memory failure telemetry per merchant endpoint. The rolling failure rate is
 * computed over a 15-minute window. An incident opens after `threshold`
 * consecutive outages and resolves on the next 2xx response.
 *
 * State lives in this process, so each API instance tracks its own deliveries.
 */
const createIncidentTracker = ({
    windowMs = FAILURE_WINDOW_MS,
    threshold = CONSECUTIVE_FAILURE_THRESHOLD,
} = {}) => {
    const endpoints = new Map();

    const stateFor = (endpointId) => {
        if (!endpoints.has(endpointId)) {
            endpoints.set(endpointId, { attempts: [], consecutiveFailures: 0, incident: null });
        }
        return endpoints.get(endpointId);
    };

    const failureRateFor = (state, now) => {
        const recent = state.attempts.filter((a) => now - a.at <= windowMs);
        state.attempts = recent;
        if (recent.length === 0) return 0;
        const failures = recent.filter((a) => a.outcome === 'outage').length;
        return failures / recent.length;
    };

    /**
     * Records one delivery attempt. Returns the incident transition it caused,
     * `{ type: 'incident_opened' | 'incident_resolved', incident }`, or null.
     */
    const record = (endpointId, {
        url,
        eventType,
        responseStatus,
        deliveryId = null,
        now = Date.now(),
    }) => {
        const state = stateFor(endpointId);
        const outcome = classifyStatus(responseStatus);
        state.attempts.push({ at: now, outcome });

        if (outcome === 'outage') {
            state.consecutiveFailures += 1;
            if (state.consecutiveFailures >= threshold && !state.incident) {
                state.incident = {
                    id: crypto.randomUUID(),
                    endpointId,
                    url,
                    eventType,
                    errorCode: responseStatus,
                    deliveryId,
                    openedAt: new Date(now).toISOString(),
                    consecutiveFailures: state.consecutiveFailures,
                };
                return { type: 'incident_opened', incident: { ...state.incident, failureRate: failureRateFor(state, now) } };
            }
            return null;
        }

        if (outcome === 'success') {
            state.consecutiveFailures = 0;
            if (state.incident) {
                const resolved = { ...state.incident, resolvedAt: new Date(now).toISOString(), resolvedBy: { eventType, responseStatus } };
                state.incident = null;
                return { type: 'incident_resolved', incident: resolved };
            }
        }
        return null;
    };

    const snapshot = (endpointId, now = Date.now()) => {
        const state = endpoints.get(endpointId);
        if (!state) return { failureRate: 0, consecutiveFailures: 0, activeIncident: null };
        return {
            failureRate: failureRateFor(state, now),
            consecutiveFailures: state.consecutiveFailures,
            activeIncident: state.incident,
        };
    };

    return { record, snapshot };
};

const dlqInspectorUrl = (deliveryId, baseUrl = process.env.FRONTEND_URL || 'https://useorbit.xyz') => {
    const base = `${baseUrl.replace(/\/$/, '')}/dashboard?view=developers`;
    return deliveryId ? `${base}&delivery=${encodeURIComponent(deliveryId)}` : base;
};

const HTTP_STATUS_TEXT = Object.freeze({
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 400: 'Bad Request', 401: 'Unauthorized',
    403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout',
    409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
    504: 'Gateway Timeout',
});

const formatHttpStatus = (status) => {
    if (!status) return 'Connection failure';
    return `HTTP ${status} ${HTTP_STATUS_TEXT[status] || 'Error'}`;
};

const claimMerchantAlertSlot = async (merchantId, { throttleStore, now }) => {
    const key = `webhook-alert-throttle:${merchantId}`;
    if (throttleStore) {
        return throttleStore.set(key, '1', MERCHANT_ALERT_THROTTLE_MS, { onlyIfAbsent: true });
    }
    const lastSentAt = lastMerchantAlertAt.get(key);
    const currentTime = now();
    for (const [merchantKey, sentAt] of lastMerchantAlertAt) {
        if (currentTime - sentAt >= MERCHANT_ALERT_THROTTLE_MS) lastMerchantAlertAt.delete(merchantKey);
    }
    if (lastSentAt !== undefined && currentTime - lastSentAt < MERCHANT_ALERT_THROTTLE_MS) {
        return false;
    }
    lastMerchantAlertAt.set(key, currentTime);
    return true;
};

/**
 * Builds the channel-agnostic incident payload used by every dispatcher.
 */
const buildIncidentAlert = (transition, { frontendUrl } = {}) => {
    const { incident } = transition;
    const resolved = transition.type === 'incident_resolved';
    return {
        action: resolved ? 'resolved' : 'triggered',
        incident_id: incident.id,
        title: resolved
            ? `Webhook Delivery Restored: ${incident.url}`
            : `Webhook endpoint failing: ${incident.url}`,
        endpoint_url: incident.url,
        failed_event_type: incident.eventType,
        error_code: incident.errorCode,
        response_status: formatHttpStatus(incident.errorCode),
        consecutive_failures: incident.consecutiveFailures ?? null,
        failure_rate: incident.failureRate ?? null,
        opened_at: incident.openedAt,
        resolved_at: incident.resolvedAt ?? null,
        dlq_url: dlqInspectorUrl(incident.deliveryId, frontendUrl),
    };
};

const postJson = async (fetchImpl, url, body, headers = {}) => {
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} from alert destination`);
    return res;
};

const formatSlack = (alert) => {
    const headline = alert.action === 'resolved'
        ? ':white_check_mark: *Webhook Delivery Restored*'
        : ':rotating_light: *Webhook endpoint failing*';
    return {
        text: `${alert.title}`,
        blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `${headline}\n*Endpoint:* ${alert.endpoint_url}\n*Failed event:* ${alert.failed_event_type}\n*Latest response:* ${alert.response_status}` } },
            { type: 'section', text: { type: 'mrkdwn', text: `<${alert.dlq_url}|Inspect in the dead-letter queue>` } },
        ],
    };
};

const dispatchers = {
    slack: async (channel, alert, { fetchImpl }) => {
        await postJson(fetchImpl, channel.config.webhook_url, formatSlack(alert));
    },
    pagerduty: async (channel, alert, { fetchImpl }) => {
        const resolved = alert.action === 'resolved';
        await postJson(fetchImpl, PAGERDUTY_EVENTS_URL, {
            routing_key: channel.config.routing_key,
            event_action: resolved ? 'resolve' : 'trigger',
            // The incident id is stable across trigger and resolve, so PagerDuty
            // closes the same alert instead of opening a new one.
            dedup_key: alert.incident_id,
            payload: resolved ? undefined : {
                summary: alert.title,
                source: alert.endpoint_url,
                severity: 'error',
                component: 'webhooks',
                class: alert.failed_event_type,
                custom_details: {
                    endpoint_url: alert.endpoint_url,
                    failed_event_type: alert.failed_event_type,
                    error_code: alert.error_code,
                    response_status: alert.response_status,
                    dlq_url: alert.dlq_url,
                },
            },
        });
    },
    discord: async (channel, alert, { fetchImpl }) => {
        await postJson(fetchImpl, channel.config.webhook_url, {
            embeds: [{
                title: alert.action === 'resolved' ? 'Webhook delivery restored' : 'Webhook delivery alert',
                color: alert.action === 'resolved' ? 0x2ecc71 : 0xe74c3c,
                fields: [
                    { name: 'Event type', value: alert.failed_event_type || 'unknown', inline: true },
                    { name: 'Latest response', value: alert.response_status || formatHttpStatus(alert.error_code), inline: true },
                    { name: 'Target URL', value: alert.endpoint_url || 'unknown' },
                ],
                url: alert.dlq_url,
                timestamp: alert.opened_at,
            }],
        });
    },
    telegram: async (channel, alert, { fetchImpl, telegramBotToken }) => {
        if (!telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
        const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
        const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[char]);
        await postJson(fetchImpl, url, {
            chat_id: channel.config.chat_id,
            parse_mode: 'HTML',
            text: [
                `<b>${alert.action === 'resolved' ? 'Webhook delivery restored' : 'Webhook delivery alert'}</b>`,
                `<b>Event:</b> ${escapeHtml(alert.failed_event_type || 'unknown')}`,
                `<b>Target:</b> ${escapeHtml(alert.endpoint_url || 'unknown')}`,
                `<b>Latest response:</b> ${escapeHtml(alert.response_status || formatHttpStatus(alert.error_code))}`,
            ].join('\n'),
            reply_markup: {
                inline_keyboard: [[{ text: 'Replay in dashboard', url: alert.dlq_url }]],
            },
        });
    },
    email: async (channel, alert, { fetchImpl, emailRelayUrl }) => {
        if (!emailRelayUrl) throw new Error('ALERT_EMAIL_RELAY_URL is not configured');
        await postJson(fetchImpl, emailRelayUrl, {
            to: channel.config.email,
            subject: alert.title,
            text: [
                `Endpoint: ${alert.endpoint_url}`,
                `Failed event: ${alert.failed_event_type}`,
                `Latest response: ${alert.response_status}`,
                `Dead-letter queue: ${alert.dlq_url}`,
            ].join('\n'),
        });
    },
};

/**
 * Sends one incident alert to a single channel. Failures are reported in the
 * result, not thrown, so one broken channel doesn't block the others.
 */
const dispatchIncidentAlert = async (channel, alert, {
    fetchImpl = globalThis.fetch,
    emailRelayUrl = process.env.ALERT_EMAIL_RELAY_URL,
    telegramBotToken = process.env.TELEGRAM_BOT_TOKEN,
} = {}) => {
    const send = dispatchers[channel.type];
    if (!send) return { channel_id: channel.id, ok: false, error: `unsupported channel type ${channel.type}` };
    try {
        await send(channel, alert, { fetchImpl, emailRelayUrl, telegramBotToken });
        return { channel_id: channel.id, ok: true };
    } catch (err) {
        return { channel_id: channel.id, ok: false, error: err.message };
    }
};

/**
 * Creates the observer that `webhooks.js` calls after every delivery attempt.
 * It feeds the tracker and, on an incident transition, fans the alert out to the
 * merchant's configured channels.
 */
const createDeliveryAlertObserver = (getSupabase, {
    tracker = createIncidentTracker(),
    fetchImpl = globalThis.fetch,
    emailRelayUrl,
    telegramBotToken,
    frontendUrl,
    now = () => Date.now(),
    throttleStore,
} = {}) => async ({ merchantId, webhook, eventType, responseStatus, deliveryId, deadLettered = false }) => {
    const transition = tracker.record(webhook.id, {
        url: webhook.url,
        eventType,
        responseStatus,
        deliveryId,
        now: now(),
    });
    if (!transition && !deadLettered) return [];

    const supabase = getSupabase();
    if (!supabase || !merchantId) return [];

    const { data: channels, error } = await supabase
        .from('webhook_alert_channels')
        .select('*')
        .eq('merchant_id', merchantId)
        .eq('active', true);
    if (error) throw error;
    if (!channels?.length) return [];
    const shouldSend = await claimMerchantAlertSlot(merchantId, { throttleStore, now });
    if (!shouldSend) return [];

    const alertTransition = transition || {
        type: 'incident_opened',
        incident: {
            id: crypto.randomUUID(),
            url: webhook.url,
            eventType,
            errorCode: responseStatus,
            deliveryId,
            openedAt: new Date(now()).toISOString(),
        },
    };
    const alert = buildIncidentAlert(alertTransition, { frontendUrl });
    return Promise.all(channels.map((channel) => dispatchIncidentAlert(
        channel, alert, { fetchImpl, emailRelayUrl, telegramBotToken },
    )));
};

const registerWebhookAlertRoutes = (app, getSupabase, authenticateMerchant) => {
    app.get('/webhook-alert-channels', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const { data, error } = await supabase
            .from('webhook_alert_channels')
            .select('id, type, config, active, created_at')
            .eq('merchant_id', req.merchant.id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ channels: data || [] });
    });

    app.post('/webhook-alert-channels', authenticateMerchant, async (req, res) => {
        const parsed = alertChannelSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const { data, error } = await supabase
            .from('webhook_alert_channels')
            .insert([{ merchant_id: req.merchant.id, type: parsed.data.type, config: parsed.data.config, active: true }])
            .select('id, type, config, active, created_at')
            .single();
        if (error) return res.status(500).json({ error: error.message });
        res.status(201).json({ channel: data });
    });

    app.delete('/webhook-alert-channels/:id', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const { error } = await supabase
            .from('webhook_alert_channels')
            .delete()
            .eq('id', req.params.id)
            .eq('merchant_id', req.merchant.id);
        if (error) return res.status(500).json({ error: error.message });
        res.status(204).end();
    });
};


/**
 * Creates the notifier that webhooks.js calls when a circuit breaker trips to PAUSED
 * for a merchant's webhook endpoint (#289). It resolves the merchant from the URL,
 * then fans the alert out to their configured alert channels.
 */
const createEndpointAlertNotifier = (getSupabase, {
  fetchImpl = globalThis.fetch,
  emailRelayUrl,
  telegramBotToken,
  frontendUrl,
  throttleStore,
} = {}) => async ({ url, lastStatusCode }) => {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data: webhooks, error: whErr } = await supabase
    .from('webhooks')
    .select('id, merchant_id')
    .eq('url', url)
    .eq('active', true)
    .limit(1);
  if (whErr) throw whErr;
  if (!webhooks?.length) return [];

  const { merchant_id: merchantId } = webhooks[0];
  const { data: channels, error: chErr } = await supabase
    .from('webhook_alert_channels')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('active', true);
  if (chErr) throw chErr;
  if (!channels?.length) return [];
  if (!await claimMerchantAlertSlot(merchantId, { throttleStore, now: Date.now })) return [];

  const alert = {
    action: 'triggered',
    incident_id: crypto.randomUUID(),
    title: `Webhook endpoint circuit breaker tripped: ${url}`,
    endpoint_url: url,
    failed_event_type: 'webhook.endpoint',
    error_code: lastStatusCode,
    response_status: formatHttpStatus(lastStatusCode),
    consecutive_failures: null,
    failure_rate: null,
    opened_at: new Date().toISOString(),
    resolved_at: null,
    dlq_url: dlqInspectorUrl(null, frontendUrl),
  };

  return Promise.all(
    channels.map((channel) =>
      dispatchIncidentAlert(channel, alert, { fetchImpl, emailRelayUrl, telegramBotToken }),
    ),
  );
};

module.exports = {
    FAILURE_WINDOW_MS,
    MERCHANT_ALERT_THROTTLE_MS,
    CONSECUTIVE_FAILURE_THRESHOLD,
    ALERT_CHANNEL_TYPES,
    alertChannelSchema,
    classifyStatus,
    createIncidentTracker,
    dlqInspectorUrl,
    buildIncidentAlert,
    dispatchIncidentAlert,
    createDeliveryAlertObserver,
    createEndpointAlertNotifier,
    registerWebhookAlertRoutes,
};
