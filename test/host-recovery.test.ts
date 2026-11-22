import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostSignalClient } from '../src/host-signal-client';
import { HostLifecycle } from '../src/host-lifecycle';
import { generateHostPairingKey } from '../src/pairing-key';
import type { StoredHostKey } from '../src/pairing-key-store';
import type { VaultAdapter } from '../src/protocol';

// The two behaviours this release exists for: a host with no lease must ask for one instead of waiting
// out the renewal cadence, and a refused frame must leave a record instead of vanishing.

const VAULT_ID = 'b1a0f81c-208b-4ecf-b49e-9bb95aa94382';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code?: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly protocol?: string) { FakeSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(frame: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const adapter = {
  listNotes: async () => [],
  readMarkdown: async () => ({ markdown: '', hash: '' }),
} as unknown as VaultAdapter;

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function build({ lease = true, ask = () => {} }: { lease?: boolean; ask?: () => void } = {}) {
  FakeSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  const generated = await generateHostPairingKey();
  const key: StoredHostKey = { vaultId: VAULT_ID, privateKey: generated.privateKey,
    publicJwk: generated.publicJwk };
  const host = new HostLifecycle();
  host.start();
  const leaseNow = () => (lease ? { expiresAtMs: Date.now() + 600_000, entitlementRevision: 0 } : null);
  const client = new HostSignalClient(VAULT_ID, host.sessionId!, key, host, adapter, leaseNow,
    undefined, null, ask);
  return { client, host };
}

test('a host with no lease asks for one instead of waiting out the renewal cadence', async () => {
  let asked = 0;
  const { client } = await build({ lease: false, ask: () => { asked += 1; } });
  client.start();
  // The supervisor is the path that notices; either it or start() must ask, and only once a minute.
  await until(() => asked >= 1, 'a presence renewal request');
  assert.equal(FakeSocket.instances.length, 0, 'no socket may open without a lease');
  assert.match(client.debugTail().join('\n'), /connect deferred: no lease/);
  assert.equal(client.relayState(), 'closed');
});

test('the renewal request is not repeated on every tick', async () => {
  let asked = 0;
  const { client } = await build({ lease: false, ask: () => { asked += 1; } });
  client.start();
  await until(() => asked >= 1, 'the first request');
  client.kick(true);
  client.kick(true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(asked, 1, 'a second ask inside the minute would be a request per tick');
});

test('a refused frame is recorded with its reason and the state it was judged in', async () => {
  const { client } = await build({ lease: true });
  client.start();
  await until(() => FakeSocket.instances.length === 1, 'the signalling socket');
  const socket = FakeSocket.instances[0];
  socket.open();
  await until(() => socket.sent.length > 0, 'the auth frame');

  // An epoch the host is not serving is refused by the request boundary; the record must name it.
  socket.deliver({ type: 'offer', epoch: 99, data: 'v=0\r\n' });
  await until(() => client.debugTail().some(line => /frame dropped/.test(line)), 'the drop record');
  const line = client.debugTail().find(entry => /frame dropped/.test(entry)) ?? '';
  assert.match(line, /type=offer/);
  assert.match(line, /reason=stale-epoch|reason=no-lease/);
  assert.match(line, /serving=/);
  assert.match(line, /socket=open/);
  assert.match(line, /lease=valid/);
  assert.equal(client.lastDropRecord()?.startsWith('type=offer'), true);
  // Nothing about the vault may be in it.
  assert.doesNotMatch(line, /notes\/|\.md|vaultId/i);
});

test('the relay state follows the socket, not the lease', async () => {
  const { client } = await build({ lease: true });
  assert.equal(client.relayState(), 'off');
  client.start();
  await until(() => FakeSocket.instances.length === 1, 'the signalling socket');
  assert.equal(client.relayState(), 'connecting');
  FakeSocket.instances[0].open();
  assert.equal(client.relayState(), 'connected');
  FakeSocket.instances[0].close(1006, '');
  await until(() => client.relayState() === 'closed', 'the closed state');
});

test('a silent socket is treated as dead, because OPEN is not a connection', async () => {
  const { client } = await build({ lease: true });
  client.start();
  await until(() => FakeSocket.instances.length === 1, 'the signalling socket');
  const socket = FakeSocket.instances[0];
  socket.open();
  await until(() => socket.sent.length > 0, 'the auth frame');

  // The relay's keepalive is the only thing that makes silence meaningful; two rounds without one is a
  // path that carries nothing while `readyState` still reads OPEN.
  (client as unknown as { lastHeardAt: number }).lastHeardAt = Date.now() - 90_000;
  (client as unknown as { supervise: () => void }).supervise();

  await until(() => socket.readyState === 3, 'the silent socket to be closed');
  // A retry is scheduled rather than awaited: the delay is the bounded backoff, and the point of the
  // test is that the supervisor no longer returns early on a socket object.
  assert.notEqual((client as unknown as { reconnectTimer: unknown }).reconnectTimer, null);
  assert.match(client.debugTail().join('\n'), /socket silent/);
});

test('the keepalive is answered and never served as a signal frame', async () => {
  const { client } = await build({ lease: true });
  client.start();
  await until(() => FakeSocket.instances.length === 1, 'the signalling socket');
  const socket = FakeSocket.instances[0];
  socket.open();
  await until(() => socket.sent.length > 0, 'the auth frame');

  socket.deliver({ type: 'ping' });
  await until(() => socket.sent.some(frame => /"pong"/.test(frame)), 'the pong reply');
  assert.doesNotMatch(client.debugTail().join('\n'), /frame dropped/);
});
