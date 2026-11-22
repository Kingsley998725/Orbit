import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReferralCode, parseReferralCode } from '../src/referral.js';

test('referral code sanitization prevents script injection and malicious input', () => {
  // Normal valid codes
  assert.equal(sanitizeReferralCode('partner_2026'), 'partner_2026');
  assert.equal(sanitizeReferralCode('AFF-100'), 'AFF-100');
  assert.equal(sanitizeReferralCode('team.orbit'), 'team.orbit');

  // Trimming whitespace
  assert.equal(sanitizeReferralCode('   spring-sale   '), 'spring-sale');

  // Script injection / HTML tag attempts
  assert.equal(sanitizeReferralCode('<script>alert("xss")</script>'), 'alertxss');
  assert.equal(sanitizeReferralCode('<img src=x onerror=alert(1)>'), null); // illegal chars stripped -> empty/invalid

  // Dangerous characters stripped
  assert.equal(sanitizeReferralCode('code;DROP TABLE users;--'), 'codeDROPTABLEusers--');
  assert.equal(sanitizeReferralCode('ref"onmouseover="alert(1)'), 'refonmouseoveralert1');

  // Invalid types or empty input
  assert.equal(sanitizeReferralCode(null), null);
  assert.equal(sanitizeReferralCode(undefined), null);
  assert.equal(sanitizeReferralCode(''), null);
  assert.equal(sanitizeReferralCode('    '), null);
  assert.equal(sanitizeReferralCode(12345), null);

  // Length capping (max 64 chars)
  const longCode = 'a'.repeat(100);
  const sanitizedLong = sanitizeReferralCode(longCode);
  assert.equal(sanitizedLong.length, 64);
  assert.equal(sanitizedLong, 'a'.repeat(64));
});

test('parseReferralCode resolves explicit prop before URL parameter', () => {
  const result = parseReferralCode({
    propCode: 'vip_creator',
    search: '?ref=url_creator',
  });
  assert.equal(result, 'vip_creator');
});

test('parseReferralCode autodetects ?ref=... parameter from URL search', () => {
  const result = parseReferralCode({
    search: '?ref=affiliate_alpha',
  });
  assert.equal(result, 'affiliate_alpha');
});

test('parseReferralCode autodetects ?aff=... parameter when ?ref is absent', () => {
  const result = parseReferralCode({
    search: '?other=123&aff=affiliate_beta&source=twitter',
  });
  assert.equal(result, 'affiliate_beta');
});

test('parseReferralCode prefers ?ref over ?aff if both exist in URL', () => {
  const result = parseReferralCode({
    search: '?aff=second_choice&ref=first_choice',
  });
  assert.equal(result, 'first_choice');
});

test('parseReferralCode falls back cleanly when no referral parameters are present', () => {
  assert.equal(parseReferralCode({ search: '' }), null);
  assert.equal(parseReferralCode({ search: '?foo=bar&baz=qux' }), null);
  assert.equal(parseReferralCode({}), null);
});

test('parseReferralCode sanitizes extracted URL parameter cleanly', () => {
  const result = parseReferralCode({
    search: '?ref=%3Cscript%3Eevil%3C%2Fscript%3Evalid_code',
  });
  assert.equal(result, 'evilvalid_code');
});

