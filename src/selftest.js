'use strict';

/**
 * End-to-end self test — no browser, no phone, no ntfy required.
 *
 * Uses a fake page whose screenshot() returns a 1x1 PNG, runs humanGate, then
 * simulates the human by POSTing an answer to the relay URL (captured via
 * onReady). Verifies both 'text' and 'approve' modes round-trip correctly.
 *
 *   node src/selftest.js
 */

const assert = require('assert');
const { humanGate } = require('./index.js');

// Smallest valid PNG (1x1 transparent), base64-decoded.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const fakePage = {
  async screenshot() {
    return ONE_PX_PNG;
  },
};

async function postAnswer(url, value) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ answer: value }).toString(),
  });
  assert.strictEqual(res.status, 200, 'POST should return 200');
}

async function run() {
  // --- Case 1: text mode (e.g. an OTP) ---
  {
    let captured;
    const gate = humanGate(fakePage, {
      prompt: 'Enter the 6-digit OTP',
      expect: 'text',
      host: '127.0.0.1',
      log: false,
      onReady: (url) => {
        captured = url;
      },
    });
    // give the server a tick to start, then act as the human
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(captured && captured.includes('/g/'), 'should expose a relay URL');
    await postAnswer(captured, '482913');
    const answer = await gate;
    assert.strictEqual(answer, '482913', 'text answer should round-trip trimmed');
    console.log('PASS  text mode  ->', JSON.stringify(answer));
  }

  // --- Case 2: approve mode ---
  {
    let captured;
    const gate = humanGate(fakePage, {
      prompt: 'Approve this purchase?',
      expect: 'approve',
      host: '127.0.0.1',
      log: false,
      onReady: (url) => {
        captured = url;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    await postAnswer(captured, 'approve');
    const ok = await gate;
    assert.strictEqual(ok, true, 'approve should resolve to boolean true');
    console.log('PASS  approve mode ->', ok);
  }

  // --- Case 3: bad token is rejected (one-time-token guard) ---
  {
    let captured;
    const gate = humanGate(fakePage, {
      prompt: 'guard test',
      host: '127.0.0.1',
      log: false,
      onReady: (url) => {
        captured = url;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const base = captured.replace(/\/g\/.*$/, '');
    const bad = await fetch(`${base}/g/deadbeef`);
    assert.strictEqual(bad.status, 404, 'wrong token must 404');
    await postAnswer(captured, 'done'); // unblock the real gate so the process exits
    await gate;
    console.log('PASS  token guard -> 404 on bad token');
  }

  console.log('\nALL SELFTESTS PASSED');
}

run().catch((err) => {
  console.error('SELFTEST FAILED:', err);
  process.exit(1);
});
