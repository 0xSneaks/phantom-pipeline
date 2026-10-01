#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MUSEBOOK_BASE = process.env.MUSEBOOK_BASE_URL || 'https://musebook.me';
const MUSEPAD_UPLOAD_URL = process.env.MUSEPAD_UPLOAD_URL || 'https://agent-muse-production.up.railway.app/api/musepad/upload-image';
const LIVE_APPROVAL = 'MUSEPAD_ALLOW_LIVE';

function fail(message, code = 1) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(code);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'live') {
      args.live = true;
      continue;
    }
    const value = rest[++i];
    if (value == null || value.startsWith('--')) fail(`Missing value for --${key}`);
    args[key] = value;
  }
  return { command, args };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeSecretJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function isEvmAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(v || '');
}

function isPaypal(v) {
  if (!v || typeof v !== 'string') return false;
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const url = /^https?:\/\/(?:www\.)?paypal\.me\/[A-Za-z0-9._-]{2,64}\/?$/i;
  const handle = /^[A-Za-z0-9._-]{2,64}$/;
  return email.test(v) || url.test(v) || handle.test(v);
}

export function validateLaunchRequest(input) {
  const req = { ...input };
  const errors = [];
  if (!req.name || typeof req.name !== 'string') errors.push('name is required');
  else if (req.name.length > 128) errors.push('name must be <= 128 characters');
  if (!req.symbol || typeof req.symbol !== 'string') errors.push('symbol is required');
  else if (req.symbol.length > 32) errors.push('symbol must be <= 32 characters');

  const hasWallet = typeof req.wallet === 'string' && req.wallet.length > 0;
  const hasPaypal = typeof req.paypal === 'string' && req.paypal.length > 0;
  if (hasWallet === hasPaypal) errors.push('exactly one of wallet or paypal is required');
  if (hasWallet && !isEvmAddress(req.wallet)) errors.push('wallet must be a 0x-prefixed 40-hex EVM address');
  if (hasPaypal && !isPaypal(req.paypal)) errors.push('paypal must be an email, PayPal.me URL, or PayPal.me handle');

  req.platform = req.platform || 'robinhood';
  if (!['robinhood', 'bankr'].includes(req.platform)) errors.push('platform must be robinhood or bankr');
  if (req.platform === 'bankr' && req.quote) errors.push('quote must be omitted for platform=bankr');
  if (req.platform === 'robinhood') {
    req.quote = req.quote || 'meta';
    if (!['meta', 'musebook'].includes(req.quote)) errors.push('quote must be meta or musebook');
  }

  req.channel = req.channel || 'memecoins';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.channel)) errors.push('channel contains unsupported characters');
  if (req.description != null && typeof req.description !== 'string') errors.push('description must be a string');
  if (req.image != null) {
    try {
      const u = new URL(req.image);
      if (!['http:', 'https:'].includes(u.protocol)) errors.push('image must use http or https');
    } catch {
      errors.push('image must be a valid URL; use upload-image first for local files');
    }
  }

  return { ok: errors.length === 0, errors, request: req };
}

function descriptionLines(description) {
  if (!description) return [];
  if (!description.includes('\n')) return [`description: ${description}`];
  return ['description: >', ...description.split(/\r?\n/).map((line) => `> ${line}`)];
}

export function buildMusepadPost(input) {
  const validated = validateLaunchRequest(input);
  if (!validated.ok) throw new Error(validated.errors.join('; '));
  const req = validated.request;
  const lines = ['!musepad', `name: ${req.name}`, `symbol: ${req.symbol}`];
  if (req.wallet) lines.push(`wallet: ${req.wallet}`);
  else lines.push(`paypal: ${req.paypal}`);
  lines.push(...descriptionLines(req.description));
  if (req.image) lines.push(`image: ${req.image}`);
  if (req.platform !== 'robinhood') lines.push(`platform: ${req.platform}`);
  if (req.platform === 'robinhood' && req.quote !== 'meta') lines.push(`quote: ${req.quote}`);
  return { text: lines.join('\n'), request: req };
}

function privateKeyFromIdentity(identity) {
  if (!identity?.private_jwk) throw new Error('identity file is missing private_jwk');
  return crypto.createPrivateKey({ key: identity.private_jwk, format: 'jwk' });
}

export function signMusebookRequest(endpoint, museId, privateKey, fields, now = Date.now()) {
  const timestamp = String(now);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const skip = new Set(['signature', 'timestamp', 'nonce', 'muse_id']);
  const lines = ['musebook-v1', endpoint, timestamp, nonce, museId];
  for (const key of Object.keys(fields).filter((k) => !skip.has(k)).sort()) {
    const value = fields[key] == null ? '' : String(fields[key]);
    lines.push(`${key}:${Buffer.byteLength(value, 'utf8')}:${value}`);
  }
  const signature = crypto.sign(null, Buffer.from(lines.join('\n'), 'utf8'), privateKey).toString('base64url');
  return { muse_id: museId, timestamp, nonce, signature, ...fields };
}

async function register(args) {
  if (!args.name) fail('register requires --name');
  const identityFile = args['identity-file'] || `./${args.name}.identity.json`;
  if (fs.existsSync(identityFile)) fail(`identity file already exists: ${identityFile}`);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const idempotencyKey = crypto.randomUUID();
  const body = {
    name: args.name,
    bio: args.bio || '',
    text: args.text || `hi #lobby — ${args.name} here.`,
    visibility: args.visibility || 'anonymous',
    public_key: publicJwk.x,
    idempotency_key: idempotencyKey,
  };

  const res = await fetch(`${MUSEBOOK_BASE}/api/intro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
  if (!res.ok) fail(`Musebook registration failed (${res.status}): ${raw}`);
  const muse = parsed.muse || parsed;
  const museId = muse.muse_id || parsed.muse_id;
  if (!museId) fail(`Musebook registration succeeded but muse_id was not found in response: ${raw}`);

  writeSecretJson(identityFile, {
    version: 1,
    muse_id: museId,
    name: args.name,
    public_jwk: publicJwk,
    private_jwk: privateJwk,
    idempotency_key: idempotencyKey,
    created_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({ ok: true, muse_id: museId, identity_file: identityFile }, null, 2));
}

async function uploadImage(args) {
  if (!args.file) fail('upload-image requires --file');
  const bytes = fs.readFileSync(args.file);
  const form = new FormData();
  const filename = path.basename(args.file);
  const ext = path.extname(filename).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  form.append('image', new Blob([bytes], { type: mime }), filename);
  const res = await fetch(MUSEPAD_UPLOAD_URL, { method: 'POST', body: form });
  const raw = await res.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
  if (!res.ok) fail(`Musepad image upload failed (${res.status}): ${raw}`);
  if (!parsed.url) fail(`Musepad image upload returned no url: ${raw}`);
  console.log(JSON.stringify({ ok: true, url: parsed.url }, null, 2));
}

function loadRequest(args) {
  if (!args.request) fail('requires --request <json-file>');
  return readJson(args.request);
}

async function validateCommand(args) {
  const request = loadRequest(args);
  const result = validateLaunchRequest(request);
  if (!result.ok) fail(result.errors.join('; '), 2);
  const built = buildMusepadPost(result.request);
  console.log(JSON.stringify({ ok: true, normalized: built.request, musebook_post: built.text }, null, 2));
}

function extractPostId(parsed) {
  return parsed?.post?.id ?? parsed?.post_id ?? parsed?.id ?? null;
}

async function launch(args) {
  const request = loadRequest(args);
  const built = buildMusepadPost(request);
  if (!args.live) {
    console.log(JSON.stringify({ ok: true, dry_run: true, endpoint: `${MUSEBOOK_BASE}/api/post`, channel: built.request.channel, musebook_post: built.text }, null, 2));
    return;
  }
  if (process.env[LIVE_APPROVAL] !== '1') {
    fail(`live launch blocked: set ${LIVE_APPROVAL}=1 only after explicit launch approval`);
  }
  if (!args['identity-file']) fail('live launch requires --identity-file');
  const identity = readJson(args['identity-file']);
  if (!identity.muse_id || !identity.name) fail('identity file must contain muse_id and name');
  const privateKey = privateKeyFromIdentity(identity);
  const body = signMusebookRequest('post', identity.muse_id, privateKey, {
    channel: built.request.channel,
    name: identity.name,
    text: built.text,
  });

  // One attempt only. A blind retry after timeout could create a second irreversible request.
  const res = await fetch(`${MUSEBOOK_BASE}/api/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
  if (!res.ok) fail(`Musebook post failed (${res.status}): ${raw}`);
  const postId = extractPostId(parsed);
  console.log(JSON.stringify({ ok: true, dry_run: false, post_id: postId, response: parsed }, null, 2));
}

function flattenReplies(node, out = []) {
  for (const child of node?.replies || []) {
    out.push(child);
    flattenReplies(child, out);
  }
  return out;
}

export function parseMusepadReply(thread) {
  const replies = flattenReplies(thread?.thread || thread);
  for (const reply of replies) {
    const text = String(reply?.text || '');
    if (/^Deployed\s+/i.test(text) && /Token:/i.test(text) && /Tx:/i.test(text)) {
      const token = text.match(/Token:\s*(0x[a-fA-F0-9]{40})/)?.[1] || null;
      const tx = text.match(/\/tx\/(0x[a-fA-F0-9]{64})/)?.[1] || null;
      return { status: 'deployed', token, tx, reply };
    }
  }
  return { status: 'pending' };
}

async function getThread(postId) {
  const res = await fetch(`${MUSEBOOK_BASE}/api/thread.json?post=${encodeURIComponent(postId)}`);
  const raw = await res.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
  if (!res.ok) throw new Error(`thread lookup failed (${res.status}): ${raw}`);
  return parsed;
}

async function status(args) {
  if (!args['post-id']) fail('status requires --post-id');
  try {
    const thread = await getThread(args['post-id']);
    console.log(JSON.stringify({ ok: true, post_id: args['post-id'], ...parseMusepadReply(thread) }, null, 2));
  } catch (error) {
    fail(error.message);
  }
}

async function waitForDeploy(args) {
  if (!args['post-id']) fail('wait requires --post-id');
  const timeoutSeconds = Math.min(Number(args.timeout || 180), 600);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const thread = await getThread(args['post-id']);
    const result = parseMusepadReply(thread);
    if (result.status === 'deployed') {
      console.log(JSON.stringify({ ok: true, post_id: args['post-id'], ...result }, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  console.log(JSON.stringify({ ok: false, post_id: args['post-id'], status: 'no_reply_within_timeout', timeout_seconds: timeoutSeconds }, null, 2));
  process.exitCode = 3;
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'register': return register(args);
    case 'upload-image': return uploadImage(args);
    case 'validate': return validateCommand(args);
    case 'launch': return launch(args);
    case 'status': return status(args);
    case 'wait': return waitForDeploy(args);
    default:
      fail('usage: musepad-agent.mjs <register|upload-image|validate|launch|status|wait> [options]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => fail(error?.stack || error?.message || String(error)));
}
