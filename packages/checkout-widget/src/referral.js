/**
 * Referral Tracking & Attribution Module (#351)
 *
 * Captures, sanitizes, and extracts promotional referral codes
 * from component props or URL search parameters (?ref=... or ?aff=...).
 */

// Maximum allowed referral code length
const MAX_REFERRAL_CODE_LENGTH = 64;

// Allowed character set for sanitized referral codes: alphanumeric, hyphens, underscores, dots
const SAFE_CODE_REGEX = /^[a-zA-Z0-9_\-.]{1,64}$/;

/**
 * Sanitizes a raw referral code to prevent script injection (XSS)
 * and ensure database/URL safety.
 *
 * @param {unknown} raw - Raw input string or value
 * @returns {string|null} Sanitized referral code or null if invalid/empty
 */
export function sanitizeReferralCode(raw) {
  if (typeof raw !== 'string') return null;

  // Trim whitespace
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Attempt safe URL decode if percent-encoded
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed).trim();
  } catch {
    // Retain trimmed if URI decode fails
  }

  // Remove dangerous script / HTML characters and non-whitelisted characters
  const cleaned = decoded
    .replace(/<[^>]*>/g, '') // Strip HTML tags
    .replace(/[^\w\-.]/g, '') // Keep only \w (a-z, A-Z, 0-9, _), hyphens, and dots
    .slice(0, MAX_REFERRAL_CODE_LENGTH);

  if (!cleaned || !SAFE_CODE_REGEX.test(cleaned)) {
    return null;
  }

  return cleaned;
}

/**
 * Extracts and resolves an active referral code.
 * Prop value takes priority over URL parameters.
 * If prop is omitted, autodetects from ?ref=... or ?aff=... query parameters.
 *
 * @param {object} options
 * @param {string} [options.propCode] - Explicit referralCode prop
 * @param {string} [options.search] - URL search query string (defaults to window.location.search)
 * @returns {string|null} Resolved and sanitized referral code, or null
 */
export function parseReferralCode({ propCode, search } = {}) {
  // 1. Explicit prop has highest precedence
  if (propCode) {
    const sanitizedProp = sanitizeReferralCode(propCode);
    if (sanitizedProp) return sanitizedProp;
  }

  // 2. Autodetect from URL search parameters (?ref=... or ?aff=...)
  const searchString =
    search !== undefined
      ? search
      : typeof window !== 'undefined' && window.location
        ? window.location.search
        : '';

  if (!searchString) return null;

  try {
    const params = new URLSearchParams(searchString);
    const candidate = params.get('ref') || params.get('aff') || null;
    return sanitizeReferralCode(candidate);
  } catch {
    return null;
  }
}

