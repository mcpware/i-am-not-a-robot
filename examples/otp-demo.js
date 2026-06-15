'use strict';

/**
 * Example: an agent connects to YOUR OWN running Chrome (Playwright over CDP),
 * does its thing, and when it hits a step only you can do, it pauses and texts
 * your phone. You tap one answer; the agent resumes.
 *
 * Prereqs:
 *   1. npm i playwright-core
 *   2. Start Chrome with debugging:
 *        google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/hg-demo https://example.org
 *   3. ntfy: install the ntfy app on your phone and subscribe to a topic,
 *      then set NTFY_TOPIC below (or leave it unset to just print the link).
 *
 *   node examples/otp-demo.js
 */

const { chromium } = require('playwright-core');
const { humanGate } = require('../src/index.js');

const NTFY_TOPIC = process.env.NTFY_TOPIC || null; // e.g. 'nicole-agent-7f3a'

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];

  // ... the agent has driven the page to a point where it needs a human ...
  // e.g. a login form is asking for a one-time code sent to your phone.

  const otp = await humanGate(page, {
    prompt: 'Login needs the OTP that was just texted to you. Type it.',
    expect: 'text',
    capture: 'viewport',
    notify: NTFY_TOPIC ? { topic: NTFY_TOPIC, title: 'Agent needs your OTP' } : undefined,
    timeoutMs: 5 * 60 * 1000,
  });

  console.log('Agent received OTP from human:', otp);
  // await page.fill('#otp', otp);  // ... and the agent carries on.

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
