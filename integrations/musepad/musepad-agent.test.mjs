import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMusepadPost, parseMusepadReply, signMusebookRequest, validateLaunchRequest } from './musepad-agent.mjs';
import crypto from 'node:crypto';

test('valid robinhood launch defaults to meta without redundant fields', () => {
  const req = { name: 'Agent Coin', symbol: 'AGENT', wallet: '0x1111111111111111111111111111111111111111' };
  const out = buildMusepadPost(req);
  assert.equal(out.request.platform, 'robinhood');
  assert.equal(out.request.quote, 'meta');
  assert.equal(out.text, '!musepad\nname: Agent Coin\nsymbol: AGENT\nwallet: 0x1111111111111111111111111111111111111111');
});

test('musebook quote is emitted for robinhood', () => {
  const out = buildMusepadPost({ name: 'A', symbol: 'A', paypal: 'maker@example.com', quote: 'musebook' });
  assert.match(out.text, /quote: musebook/);
});

test('bankr rejects quote', () => {
  const out = validateLaunchRequest({ name: 'A', symbol: 'A', paypal: 'maker', platform: 'bankr', quote: 'musebook' });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /quote must be omitted/);
});

test('exactly one payout destination is required', () => {
  const none = validateLaunchRequest({ name: 'A', symbol: 'A' });
  const both = validateLaunchRequest({ name: 'A', symbol: 'A', paypal: 'maker', wallet: '0x1111111111111111111111111111111111111111' });
  assert.equal(none.ok, false);
  assert.equal(both.ok, false);
});

test('multiline description uses documented blockquote continuation', () => {
  const out = buildMusepadPost({ name: 'A', symbol: 'A', paypal: 'maker', description: 'one\ntwo' });
  assert.match(out.text, /description: >\n> one\n> two/);
});

test('Musebook signing verifies with generated public key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const fields = { channel: 'memecoins', name: 'Agent', text: '!musepad\nname: A\nsymbol: A\npaypal: maker' };
  const signed = signMusebookRequest('post', 'muse_test', privateKey, fields, 1234567890);
  const lines = ['musebook-v1', 'post', signed.timestamp, signed.nonce, 'muse_test'];
  for (const key of Object.keys(fields).sort()) {
    const value = String(fields[key]);
    lines.push(`${key}:${Buffer.byteLength(value, 'utf8')}:${value}`);
  }
  assert.equal(crypto.verify(null, Buffer.from(lines.join('\n')), publicKey, Buffer.from(signed.signature, 'base64url')), true);
});

test('deployment reply parser extracts token and tx', () => {
  const thread = { thread: { replies: [{ text: 'Deployed Test (TST) on Robinhood Chain.\nToken: 0x1111111111111111111111111111111111111111 — https://robin.etherscan.io/address/0x1111111111111111111111111111111111111111\nTx: https://robin.etherscan.io/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', replies: [] }] } };
  const out = parseMusepadReply(thread);
  assert.equal(out.status, 'deployed');
  assert.equal(out.token, '0x1111111111111111111111111111111111111111');
  assert.equal(out.tx, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});
