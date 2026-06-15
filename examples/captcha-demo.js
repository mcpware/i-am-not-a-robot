'use strict';

/**
 * Programmatic example (no MCP client needed): connect to your own browser over
 * CDP, start a relay, print the phone URL, and wait for a human to solve the
 * in-page CAPTCHA with their finger. This is the same flow the MCP tools drive.
 *
 * Prereqs:
 *   1. Start Chrome with remote debugging + a page that has a reCAPTCHA:
 *        google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/hg-demo \
 *          https://www.google.com/recaptcha/api2/demo
 *   2. node examples/captcha-demo.js
 *
 * Env: CDP_URL (default http://localhost:9222), CDP_TARGET (URL substring).
 */

const { HumanRelay } = require('../src/relay.js');

(async () => {
  const relay = new HumanRelay();
  const { relayUrl, relayUrls, pageUrl } = await relay.start({
    cdpUrl: process.env.CDP_URL || 'http://localhost:9222',
    targetUrl: process.env.CDP_TARGET || 'recaptcha',
  });

  console.log('\nStreaming page:', pageUrl);
  console.log('\nOpen this on your phone and solve the CAPTCHA with your finger:\n  ' + relayUrl);
  if (relayUrls && relayUrls.length > 1) {
    console.log('  (if that one will not open, try: ' + relayUrls.slice(1).join('  ,  ') + ')');
  }
  console.log('\nWaiting up to 5 minutes for you to solve it...');

  const { passed } = await relay.awaitSolve({ timeoutMs: 5 * 60 * 1000 });
  console.log(passed
    ? '\n✓ Solved. The token is in the page and the agent would resume here.'
    : '\n✗ Timed out waiting for a human.');

  await relay.stop();
  process.exit(passed ? 0 : 1);
})().catch((e) => { console.error('example failed:', e); process.exit(1); });
