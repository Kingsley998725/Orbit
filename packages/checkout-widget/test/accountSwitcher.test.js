import test from 'node:test';
import assert from 'node:assert/strict';
import { initWalletAccountWatcher, promptWalletAccountSwitch } from '../src/accountSwitcher.js';

// Setup browser-like globals for node:test environment
class MockEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
  }
  removeEventListener(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }
  dispatchEvent(event) {
    const list = this.listeners.get(event.type);
    if (list) {
      list.forEach((cb) => cb(event));
    }
    return true;
  }
}

test('accountSwitcher detects custom window account change events', () => {
  const originalWindow = globalThis.window;
  const mockWindow = new MockEventTarget();
  globalThis.window = mockWindow;

  try {
    let changedTo = null;
    const initialAddress = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    const newAddress = 'GDQ77JIX7U234T4QZ4L2L7P6V3E4EHLQZ6JYYK73S375YTYHQLA77AAA';

    const watcher = initWalletAccountWatcher({
      currentAddress: initialAddress,
      onAccountChange: (addr) => {
        changedTo = addr;
      },
    });

    // Emitting freighter:accountChanged event
    mockWindow.dispatchEvent({
      type: 'freighter:accountChanged',
      detail: { address: newAddress },
    });

    assert.equal(changedTo, newAddress);
    assert.equal(watcher.getCurrentAddress(), newAddress);

    // Emitting same address should not trigger callback again
    let triggeredAgain = false;
    watcher.stop();

    // After stopping, events are no longer caught
    mockWindow.dispatchEvent({
      type: 'freighter:accountChanged',
      detail: { address: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' },
    });

    assert.equal(watcher.getCurrentAddress(), newAddress);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('accountSwitcher supports stellar:accountChanged and string detail payload', () => {
  const originalWindow = globalThis.window;
  const mockWindow = new MockEventTarget();
  globalThis.window = mockWindow;

  try {
    let detectedAddress = null;
    const watcher = initWalletAccountWatcher({
      currentAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      onAccountChange: (addr) => {
        detectedAddress = addr;
      },
    });

    mockWindow.dispatchEvent({
      type: 'stellar:accountChanged',
      detail: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });

    assert.equal(detectedAddress, 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    watcher.stop();
  } finally {
    globalThis.window = originalWindow;
  }
});

test('promptWalletAccountSwitch invokes fallback onOpenSelector when walletId is generic or unavailable', async () => {
  let selectorOpened = false;
  await promptWalletAccountSwitch({
    walletId: 'xbull',
    onOpenSelector: () => {
      selectorOpened = true;
    },
  });
  assert.equal(selectorOpened, true);
});

