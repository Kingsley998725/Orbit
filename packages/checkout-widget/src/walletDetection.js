export const DETECTION_TIMEOUT_MS = 300;
export const DETECTED_BADGE_LABEL = "Installed";

const POLL_INTERVAL_MS = 25;

export const WALLET_PROVIDER_KEYS = Object.freeze({
  freighter: ["freighterApi", "freighter"],
  xbull: ["xbull", "xBullSDK", "xBull"],
  albedo: ["albedo", "albedoWallet"],
  lobstr: ["lobstr", "lobstrWallet"],
  hana: ["hanaWallet", "hana"],
});

function isProvider(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function readGlobal(windowRef, key) {
  try {
    return isProvider(windowRef[key]) ? key : null;
  } catch {
    return null;
  }
}

export function findProviderKeys(walletIds, windowRef) {
  const providers = {};
  if (!windowRef || typeof windowRef !== "object") return providers;
  const ids = Array.isArray(walletIds) ? walletIds : [];
  for (const id of ids) {
    if (typeof id !== "string" || providers[id]) continue;
    for (const key of WALLET_PROVIDER_KEYS[id] || []) {
      const match = readGlobal(windowRef, key);
      if (match) {
        providers[id] = match;
        break;
      }
    }
  }
  return providers;
}

export function detectInstalledWallets({
  walletIds = [],
  windowRef = typeof window === "undefined" ? undefined : window,
  timeoutMs = DETECTION_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
  onDetected,
} = {}) {
  const ids = [...new Set(Array.isArray(walletIds) ? walletIds.filter((id) => typeof id === "string") : [])];
  const providers = findProviderKeys(ids, windowRef);
  const detectedIds = () => ids.filter((id) => providers[id]);
  const snapshot = () => ({ detectedIds: detectedIds(), providers: { ...providers } });
  const notify = () => {
    if (detectedIds().length > 0) onDetected?.(snapshot());
  };

  notify();
  if (!windowRef || ids.length === 0 || detectedIds().length === ids.length) {
    return Promise.resolve(snapshot());
  }

  const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : DETECTION_TIMEOUT_MS;
  const interval = Math.max(1, Number.isFinite(pollIntervalMs) ? pollIntervalMs : POLL_INTERVAL_MS);

  return new Promise((resolve) => {
    let settled = false;
    let deadlineTimer;
    let pollTimer;

    const complete = () => {
      if (settled) return;
      settled = true;
      cancel(deadlineTimer);
      cancel(pollTimer);
      resolve(snapshot());
    };

    const probe = () => {
      const before = detectedIds().length;
      Object.assign(
        providers,
        findProviderKeys(ids.filter((id) => !providers[id]), windowRef),
      );
      if (detectedIds().length > before) notify();
      if (detectedIds().length === ids.length) complete();
    };

    const tick = () => {
      probe();
      if (!settled) pollTimer = schedule(tick, Math.min(interval, budget));
    };

    deadlineTimer = schedule(complete, budget);
    pollTimer = schedule(tick, Math.min(interval, budget));
  });
}

/** Detected-first ordering that keeps the original order inside each group. */
export function prioritizeWalletChoices(choices, detectedIds = []) {
  const detected = new Set(detectedIds);
  return [
    ...choices.filter(([id]) => detected.has(id)),
    ...choices.filter(([id]) => !detected.has(id)),
  ];
}

export function getDetectedWalletChoices(choices, detectedIds = []) {
  const detected = new Set(detectedIds);
  return choices.filter(([id]) => detected.has(id));
}

/** The one-click CTA is only offered for exactly one detected, visible wallet. */
export function getQuickConnectWallet(choices, detectedIds = []) {
  const matches = getDetectedWalletChoices(choices, detectedIds);
  return matches.length === 1 ? matches[0] : null;
}
