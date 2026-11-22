import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DETECTION_TIMEOUT_MS,
  DETECTED_BADGE_LABEL,
  detectInstalledWallets,
  findProviderKeys,
  getDetectedWalletChoices,
  getQuickConnectWallet,
  prioritizeWalletChoices,
} from '../src/walletDetection.js';

function createClock() {
  let now = 0;
  let nextId = 0;
  const jobs = new Map();
  return {
    schedule(fn, delay) {
      const id = ++nextId;
      jobs.set(id, { at: now + delay, fn });
      return id;
    },
    cancel(id) { jobs.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...jobs.entries()]
          .filter(([, job]) => job.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, job] = due;
        jobs.delete(id);
        now = job.at;
        job.fn();
      }
      now = target;
    },
    get pending() { return jobs.size; },
  };
}

const detect = (windowRef, walletIds, clock) => detectInstalledWallets({
  windowRef,
  walletIds,
  schedule: clock.schedule,
  cancel: clock.cancel,
});

test('detects Freighter from window.freighterApi within the budget', async () => {
  const clock = createClock();
  const windowRef = { freighterApi: { isConnected: () => false } };
  const pending = detect(windowRef, ['freighter', 'xbull'], clock);
  assert.equal(clock.pending, 2);
  clock.advance(DETECTION_TIMEOUT_MS);
  const result = await pending;
  assert.deepEqual(result.detectedIds, ['freighter']);
  assert.deepEqual(result.providers, { freighter: 'freighterApi' });
  assert.equal(clock.pending, 0);
});

test('detects xBull through both the legacy and SDK globals', async () => {
  for (const key of ['xbull', 'xBullSDK', 'xBull']) {
    const clock = createClock();
    const result = await detect({ [key]: {} }, ['xbull'], clock);
    assert.deepEqual(result.detectedIds, ['xbull'], `expected ${key} to be detected`);
    assert.deepEqual(result.providers, { xbull: key });
  }
});

test('picks up providers injected asynchronously within the detection budget', async () => {
  const clock = createClock();
  const windowRef = {};
  const pending = detect(windowRef, ['freighter'], clock);
  windowRef.freighterApi = { requestAccess: () => {} };
  clock.advance(DETECTION_TIMEOUT_MS / 2);
  assert.deepEqual((await pending).detectedIds, ['freighter']);

  assert.equal(clock.pending, 0);
});

test('resolves with an empty list only after the 300ms budget when nothing is installed', async () => {
  const clock = createClock();
  let settled = false;
  const pending = detect({}, ['freighter', 'xbull'], clock).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  clock.advance(DETECTION_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false);
  clock.advance(1);
  assert.deepEqual((await pending).detectedIds, []);
  assert.equal(clock.pending, 0);
});

test('ignores null, primitive, and throwing provider globals', async () => {
  const windowRef = {};
  Object.defineProperty(windowRef, 'freighterApi', { get() { throw new Error('blocked'); } });
  windowRef.xbull = null;
  windowRef.xBullSDK = 'not-a-provider';
  assert.deepEqual(findProviderKeys(['freighter', 'xbull', 'unknown'], windowRef), {});
  const clock = createClock();
  const pending = detect(windowRef, ['freighter', 'xbull'], clock);
  clock.advance(DETECTION_TIMEOUT_MS);
  assert.deepEqual((await pending).detectedIds, []);
});

test('falls back cleanly without a window or wallet ids (SSR/no extensions)', async () => {
  const clock = createClock();
  assert.deepEqual((await detect(undefined, ['freighter'], clock)).detectedIds, []);
  assert.deepEqual((await detect({}, [], clock)).detectedIds, []);
  assert.equal(clock.pending, 0);
});

test('only probes allowed ids and reports stable detected-first ordering', async () => {
  const windowRef = { freighterApi: {}, xbull: {} };
  const clock = createClock();
  const pending = detect(windowRef, ['albedo', 'xbull', 'freighter'], clock);
  clock.advance(DETECTION_TIMEOUT_MS);
  const result = await pending;
  assert.deepEqual(result.detectedIds, ['xbull', 'freighter']);
  const choices = [
    ['freighter', 'Freighter'],
    ['albedo', 'Albedo'],
    ['xbull', 'xBull'],
    ['hana', 'Hana'],
  ];
  assert.deepEqual(
    prioritizeWalletChoices(choices, result.detectedIds).map(([id]) => id),
    ['freighter', 'xbull', 'albedo', 'hana'],
  );
  assert.deepEqual(
    getDetectedWalletChoices(choices, result.detectedIds).map(([id]) => id),
    ['freighter', 'xbull'],
  );
});

test('streams a detected provider immediately without waiting for the full budget', async () => {
  const clock = createClock();
  const updates = [];
  const pending = detectInstalledWallets({
    windowRef: { freighterApi: {} },
    walletIds: ['freighter', 'xbull'],
    timeoutMs: DETECTION_TIMEOUT_MS,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onDetected: (snapshot) => updates.push(snapshot.detectedIds),
  });
  assert.deepEqual(updates, [['freighter']]);
  clock.advance(DETECTION_TIMEOUT_MS);
  await pending;
  assert.deepEqual(updates, [['freighter']]);
});

test('streams a late-injected provider on the first poll that finds it', async () => {
  const clock = createClock();
  const updates = [];
  const windowRef = {};
  const pending = detectInstalledWallets({
    windowRef,
    walletIds: ['xbull'],
    timeoutMs: DETECTION_TIMEOUT_MS,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onDetected: (snapshot) => updates.push(snapshot.detectedIds),
  });
  assert.deepEqual(updates, []);
  windowRef.xBullSDK = {};
  clock.advance(25);
  assert.deepEqual(updates, [['xbull']]);
  await pending;
});

test('offers the one-click CTA only when exactly one visible wallet is detected', () => {
  const choices = [['freighter', 'Freighter'], ['albedo', 'Albedo']];
  assert.equal(DETECTED_BADGE_LABEL, 'Installed');
  assert.deepEqual(getQuickConnectWallet(choices, ['freighter']), ['freighter', 'Freighter']);
  assert.equal(getQuickConnectWallet(choices, []), null);
  assert.equal(getQuickConnectWallet(choices, ['freighter', 'albedo']), null);
  assert.equal(getQuickConnectWallet(choices, ['hana']), null);
});
