import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAddress,
  inWhitelist,
  truncateUtf8,
  sanitizeSubject,
  htmlToPlainText,
  sanitizeFilename,
  checkAuthResults,
} from '../src/security.js';

test('normalizeAddress: valid addresses', () => {
  assert.equal(normalizeAddress('Owner@QQ.com'), 'owner@qq.com');
  assert.equal(normalizeAddress('a.b+x@sub.domain.cn'), 'a.b+x@sub.domain.cn');
});

test('normalizeAddress: rejects display-name disguise (bypass attempt)', () => {
  assert.equal(normalizeAddress('"owner@qq.com" <evil@evil.com>'), null);
  assert.equal(normalizeAddress('owner@qq.com <evil@evil.com>'), null);
  assert.equal(normalizeAddress('<owner@qq.com>'), null);
});

test('normalizeAddress: rejects multi-address lists (anti-smuggling)', () => {
  assert.equal(normalizeAddress('a@qq.com,b@evil.com'), null);
  assert.equal(normalizeAddress('a@qq.com; b@evil.com'), null);
});

test('normalizeAddress: rejects CRLF and control characters (anti header injection)', () => {
  assert.equal(normalizeAddress('a@qq.com\r\nBcc: victim@x.com'), null);
  assert.equal(normalizeAddress('a@qq.com\n'), null);
  assert.equal(normalizeAddress('a@qq.com\x00'), null);
});

test('normalizeAddress: rejects miscellaneous invalid shapes', () => {
  assert.equal(normalizeAddress('mailto:a@qq.com'), null);
  assert.equal(normalizeAddress('a@qq.com '), null, 'surrounding whitespace rejected outright, not swallowed by trim');
  assert.equal(normalizeAddress('not-an-email'), null);
  assert.equal(normalizeAddress(123), null);
  assert.equal(normalizeAddress(''), null);
});

test('inWhitelist: exact equality, no substring/suffix matching', () => {
  const wl = ['owner@qq.com'];
  assert.equal(inWhitelist('owner@qq.com', wl), true);
  assert.equal(inWhitelist('xowner@qq.com.evil.com', wl), false);
  assert.equal(inWhitelist('owner@qq.com.evil.com', wl), false);
  assert.equal(inWhitelist(null, wl), false);
  assert.equal(inWhitelist('owner@qq.com', null), false);
});

test('truncateUtf8: never splits multi-byte characters', () => {
  const s = '€'.repeat(100); // 3 bytes each
  const out = truncateUtf8(s, 10);
  assert.ok(!out.includes('\uFFFD'), 'must not produce replacement characters');
  assert.ok(out.startsWith('€€€'), 'whole characters must be preserved');
  assert.ok(out.endsWith('[truncated]'));
});

test('truncateUtf8: returns input unchanged when under the limit', () => {
  assert.equal(truncateUtf8('hello', 100), 'hello');
  assert.equal(truncateUtf8('naïve café', 1024), 'naïve café');
});

test('truncateUtf8: exact-fit boundary', () => {
  const s = '€€€';
  assert.equal(truncateUtf8(s, 9), s); // 9 bytes = exactly 3 whole characters
});

test('sanitizeSubject: CRLF injection flattened', () => {
  const out = sanitizeSubject('hi\r\nBcc: victim@x.com\r\nFrom: fake@x.com');
  assert.ok(!out.includes('\r') && !out.includes('\n'), 'must be single-line so nodemailer does not treat it as multiple headers');
  const out2 = sanitizeSubject('x'.repeat(500));
  assert.ok(out2.length <= 201, 'overlong subjects are truncated');
});

test('htmlToPlainText: strips tags and drops script content', () => {
  const html = '<html><head><style>body{color:red}</style></head>' +
    '<body><p>normal content</p><script>alert(1)</script></body></html>';
  const out = htmlToPlainText(html);
  assert.ok(out.includes('normal content'));
  assert.ok(!out.includes('alert(1)'));
  assert.ok(!out.includes('<p>'));
});

test('sanitizeFilename: strips control characters and limits length', () => {
  assert.equal(sanitizeFilename('report\r\nfinal.pdf'), 'report_final.pdf', 'consecutive control chars collapse into one underscore');
  assert.equal(sanitizeFilename('a'.repeat(200)).length <= 64, true);
  assert.equal(sanitizeFilename(null), '(unnamed)');
});

test('checkAuthResults: three states', () => {
  assert.equal(checkAuthResults('spf=pass dkim=pass dmarc=pass'), true);
  assert.equal(checkAuthResults('dmarc=fail (p=none)'), false);
  assert.equal(checkAuthResults('dmarc=softfail'), false);
  assert.equal(checkAuthResults(null), null);
  assert.equal(checkAuthResults(['x', 'dmarc=pass']), true);
});
