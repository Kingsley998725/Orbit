/**
 * Interactive Customer Wallet Switch Prompt and Multi-Account Selector (#352)
 *
 * Provides real-time account change observation (Freighter WatchWalletChanges,
 * window account change events) and handles in-widget account switching with
 * immediate balance re-query and authorization state reset.
 */

import freighterApi from '@stellar/freighter-api';

const WatchWalletChanges =
  freighterApi?.WatchWalletChanges ||
  freighterApi?.default?.WatchWalletChanges;

const requestAccess =
  freighterApi?.requestAccess ||
  freighterApi?.default?.requestAccess;

/**
 * Initializes listeners for wallet account changes.
 * Monitors Freighter extension events as well as window events for other wallets (xBull, Albedo, etc.).
 *
 * @param {object} options
 * @param {Function} options.onAccountChange - Callback invoked when a new address is detected
 * @param {Function} [options.onNetworkChange] - Callback invoked when network changes
 * @param {string} [options.currentAddress] - Currently active address to prevent redundant notifications
 * @param {number} [options.timeout=2000] - Polling interval for WatchWalletChanges in ms
 * @returns {object} Controller with `stop()` method to tear down all listeners
 */
export function initWalletAccountWatcher({
  onAccountChange,
  onNetworkChange,
  currentAddress = '',
  timeout = 2000,
} = {}) {
  let activeAddress = currentAddress;
  let watcherInstance = null;
  let isStopped = false;

  // 1. Freighter WatchWalletChanges listener
  try {
    if (typeof window !== 'undefined' && typeof WatchWalletChanges === 'function') {
      watcherInstance = new WatchWalletChanges(timeout);
      watcherInstance.watch(({ address: newAddress, networkPassphrase }) => {
        if (isStopped) return;
        if (newAddress && newAddress !== activeAddress) {
          activeAddress = newAddress;
          onAccountChange?.(newAddress);
        }
        if (networkPassphrase) {
          onNetworkChange?.(networkPassphrase);
        }
      });
    }
  } catch {
    // Watcher not supported in non-browser or extensionless environments
  }

  // 2. Custom window event listeners (used by modern wallets, xBull, and unit tests)
  const handleCustomEvent = (event) => {
    if (isStopped) return;
    const newAddress =
      event?.detail?.address ||
      event?.detail?.publicKey ||
      (typeof event?.detail === 'string' ? event.detail : null);

    if (newAddress && typeof newAddress === 'string' && newAddress !== activeAddress) {
      activeAddress = newAddress;
      onAccountChange?.(newAddress);
    }
  };

  const windowEvents = [
    'freighter:accountChanged',
    'stellar:accountChanged',
    'orbit:switch_account',
    'wallet:accountChanged',
  ];

  if (typeof window !== 'undefined') {
    windowEvents.forEach((eventName) => {
      window.addEventListener(eventName, handleCustomEvent);
    });
  }

  return {
    getCurrentAddress: () => activeAddress,
    setCurrentAddress: (addr) => {
      activeAddress = addr;
    },
    stop: () => {
      isStopped = true;
      if (watcherInstance && typeof watcherInstance.stop === 'function') {
        watcherInstance.stop();
        watcherInstance = null;
      }
      if (typeof window !== 'undefined') {
        windowEvents.forEach((eventName) => {
          window.removeEventListener(eventName, handleCustomEvent);
        });
      }
    },
  };
}

/**
 * Triggers interactive wallet account switch prompt.
 * Prompts Freighter or the active wallet extension to re-request access / pick an account.
 *
 * @param {object} options
 * @param {string} [options.walletId] - Identifier of connected wallet (e.g. 'freighter')
 * @param {Function} [options.onSuccess] - Callback with newly selected address
 * @param {Function} [options.onError] - Callback with error message
 * @param {Function} [options.onOpenSelector] - Fallback to open wallet/account selector modal
 * @returns {Promise<string|null>} Selected address or null
 */
export async function promptWalletAccountSwitch({
  walletId,
  onSuccess,
  onError,
  onOpenSelector,
} = {}) {
  try {
    if (typeof window !== 'undefined' && (walletId === 'freighter' || !walletId)) {
      // Re-trigger Freighter access prompt to allow selecting an alternative account
      if (typeof requestAccess === 'function') {
        const access = await requestAccess();
        const newAddress = access?.address || access;
        if (newAddress && typeof newAddress === 'string') {
          onSuccess?.(newAddress);
          return newAddress;
        }
      }
    }

    // If wallet has no direct switch API or user wants to switch wallet
    if (onOpenSelector) {
      onOpenSelector();
    }
    return null;
  } catch (err) {
    const msg = err?.message || 'Account switch was cancelled or failed.';
    onError?.(msg);
    return null;
  }
}
