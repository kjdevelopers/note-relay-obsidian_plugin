import assert from 'node:assert/strict';
import test from 'node:test';
import { SITE_ORIGIN, SUPPORT_PAGE_URL } from '../src/endpoints';

/**
 * The support action is a link, and a link is the one place a plugin can send a member somewhere they
 * did not choose. It must be the product's own site, over https, and it must not carry anything: the
 * diagnostics travel by clipboard and by the member's own paste, never in a URL.
 */
test('the support link is the product site over https and carries nothing', () => {
  assert.equal(SITE_ORIGIN, 'https://noterelay.io');
  assert.equal(SUPPORT_PAGE_URL, 'https://noterelay.io/support');
  const url = new URL(SUPPORT_PAGE_URL);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.search, '', 'no query string: a diagnostic field here would land in history');
  assert.equal(url.hash, '');
});
