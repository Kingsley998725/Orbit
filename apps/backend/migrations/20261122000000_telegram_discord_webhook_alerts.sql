-- Support Discord webhook and Telegram bot destinations for delivery alerts.
-- migrate:up
ALTER TABLE webhook_alert_channels
    DROP CONSTRAINT IF EXISTS webhook_alert_channels_type_check;
ALTER TABLE webhook_alert_channels
    ADD CONSTRAINT webhook_alert_channels_type_check
    CHECK (type IN ('slack', 'pagerduty', 'email', 'discord', 'telegram'));

-- migrate:down
ALTER TABLE webhook_alert_channels
    DROP CONSTRAINT IF EXISTS webhook_alert_channels_type_check;
ALTER TABLE webhook_alert_channels
    ADD CONSTRAINT webhook_alert_channels_type_check
    CHECK (type IN ('slack', 'pagerduty', 'email'));
