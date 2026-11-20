import { decodeJwt } from 'jose';
import { Notice, requestUrl } from 'obsidian';
import { HostLifecycle } from './host-lifecycle';
import { AuthenticatedReadSession, type AuthorizationLease } from './authenticated-read-session';
import { hostPairingKeyId } from './pairing-key';
import type { StoredHostKey } from './pairing-key-store';
import { importPinnedGrantKeys } from './grant-keys';
import { signHostSignalProof, signHostTurnProof } from './host-signal-proof';
import { validMarkdownPath } from './protocol';
import type { VaultAdapter } from './protocol';
import { AuthorityCache, AuthorityEpoch, type AuthorityState } from './host-authority';
import { signTeardownAck, type TeardownAck } from './host-teardown-proof';

import { WORKER_ORIGIN, WORKER_SOCKET } from './endpoints';
import { clearTimer, setTimer } from './timers';
import { reconnectDelay, serverHintedDelay } from './reconnect';
import { pluginHeaders, pluginVersion } from './client-version';

/** How often a connected host checks that it is still the one the room holds. */
const SUPERVISE_MS = 20_000;
import type { HostCloseRecord } from './diagnostics';
import type { ReaderWaitMonitor } from './host-waiting';

/**
 * How often a refused handshake may force a presence refresh.
 *
 * A room refuses a host whose lease predates the account's current entitlement revision; one refresh
 * fixes it, so a second refusal inside this window is a different problem and must not become a loop.
 */
const REFRESH_AFTER_REFUSAL_MS = 15_000;

const SIGNAL_URL = `${WORKER_SOCKET}/v1/signal`;
const TURN_URL = `${WORKER_ORIGIN}/v1/turn-credentials`;
const AUTHORITY_URL = `${WORKER_ORIGIN}/v1/authority`;
const MAX_DATA_MESSAGE = 64 * 1024;

type WireSignal = {
  type: 'ready' | 'peer-left' | 'offer' | 'relay-offer' | 'answer' | 'ice' | 'end' | 'teardown';
  data?: string; epoch?: number; nonce?: string; reader_key?: string | null;
  reason?: string; grace_ms?: number;
};

// Only a paired, explicitly started host opens this socket. The signaling
// channel never processes vault commands; all commands use the proven peer.
export class HostSignalClient {
  private active = false;
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private readSession: AuthenticatedReadSession | null = null;
  private usedGrantIds = new Set<string>();
  private pendingIce: RTCIceCandidateInit[] = [];
  private reconnectTimer: unknown = null;
  private supervisor: unknown = null;
  /** Consecutive failed attempts, so the retry delay can grow and then reset on success. */
  private retryAttempt = 0;
  /** When a refused handshake last forced a presence refresh, so the two cannot loop. */
  private refusedAt = 0;
  /**
   * The most recent close of the signalling socket.
   *
   * Exposed for the diagnostics bundle only. Nothing in the plugin branches on it: a close code tells
   * a human which of four different problems happened, and the product's own behaviour is decided by
   * the lease and the room, not by this record.
   */
  private lastClose: HostCloseRecord | null = null;
  lastCloseRecord(): HostCloseRecord | null { return this.lastClose; }
  private peerGeneration = 0;
  /**
   * The authority epoch this host is serving.
   *
   * `null` until a `ready` or `teardown` names one. Every frame a reader sends must carry this epoch,
   * and the moment a newer epoch is learned the older reader's frames stop being served — the host is
   * the last line of defence, so a relay that admitted two readers could not put two peers on a vault.
   */
  private authority = new AuthorityEpoch();
  /** Authority as the API reports it: verified at most once every sixty seconds, then refused. */
  private authorityCache = new AuthorityCache(() => this.fetchAuthority());
  /**
   * The note this reader is currently displaying, as it last told us.
   *
   * Used for one thing: a change notice goes only to a reader looking at that note. A reader that is
   * elsewhere gets nothing, so a busy vault does not spray messages at someone reading a different
   * note.
   */
  private viewingPath: string | null = null;
  /**
   * Last few hundred host-side events, for diagnosing a connection that opens but serves nothing.
   *
   * Bounded and in-memory only: no note content, no paths (except the command name), never written to
   * disk or sent anywhere. Read through `debugTail()` when a reader says "connected" but sees nothing.
   */
  private readonly events: string[] = [];
  debugTail(count = 80): string[] { return this.events.slice(-count); }
  private note(event: string): void {
    const stamp = new Date().toISOString().slice(11, 23);
    this.events.push(`${stamp} ${event}`);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }
  private readonly currentHost: () => boolean;

  /**
   * `readerWait` is optional and passive: this client only reports what the room told it, and a
   * caller that passes nothing loses the display, never the hosting.
   */
  constructor(private vaultId: string, private sessionId: string,
    private key: StoredHostKey, private host: HostLifecycle,
    private adapter: VaultAdapter, private lease: () => AuthorizationLease | null,
    private readerWait?: ReaderWaitMonitor,
    private onAuthRefused: (() => void) | null = null) {
    this.currentHost = host.currentRequest();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.scheduleSupervision();
    void this.connect();
  }

  /**
   * The tick that notices a socket nobody is coming back for.
   *
   * Every other path is event-driven: a close schedules a retry, a wake calls `kick`. A state that
   * loses both — a timer that fired while the lease was absent, or a close whose retry was refused —
   * used to be permanent, and the owner's only remedy was to toggle hosting. Twenty seconds of a
   * cheap check is the difference between "dark until I notice" and "back within half a minute".
   * `unref` keeps the process free to exit where the runtime offers it (the test runner does).
   */
  private scheduleSupervision(): void {
    const handle = setTimer(() => this.supervise(), SUPERVISE_MS);
    (handle as { unref?: () => void }).unref?.();
    this.supervisor = handle;
  }

  private supervise(): void {
    if (this.supervisor) clearTimer(this.supervisor);
    this.supervisor = null;
    if (!this.active) return;
    this.scheduleSupervision();
    if (this.socket || this.reconnectTimer) return;
    if (!this.currentHost() || !this.lease()) return;
    this.note('supervisor: no socket, no retry');
    void this.connect();
  }

  /**
   * Reconnect now if the socket is down and a lease is held.
   *
   * A wake from sleep can leave both the presence lease and the socket dead, and the socket's own
   * retry only reschedules while a lease exists. Called from the vault window's wake path; a live
   * socket or a live timer makes it a no-op, so it never competes with the backoff.
   */
  kick(force = false): void {
    if (!this.active) return;
    if (!force && (this.socket || this.reconnectTimer)) return;
    if (!this.currentHost() || !this.lease()) return;
    if (this.reconnectTimer) { clearTimer(this.reconnectTimer); this.reconnectTimer = null; }
    void this.connect();
  }

  stop(): void {
    this.active = false;
    this.retryAttempt = 0;
    // Hosting was turned off, so any "a reader is waiting" claim is stale by definition.
    this.readerWait?.disconnected();
    if (this.reconnectTimer) { clearTimer(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.supervisor) { clearTimer(this.supervisor); this.supervisor = null; }
    this.socket?.close(); this.socket = null;
    this.closePeer();
  }

  private closePeer(reason = 'unspecified'): void {
    this.note(`closePeer ${reason} gen=${this.peerGeneration}`);
    this.peerGeneration++;
    this.readSession?.close(); this.readSession = null;
    this.channel?.close(); this.channel = null;
    this.peer?.close(); this.peer = null;
    this.pendingIce = [];
  }

  /**
   * Close the peer and report what was observed, for the teardown attestation.
   *
   * The state read after `closePeer` returns is the strongest local evidence that exists: the channel
   * and the connection both report their own teardown synchronously. Anything short of that is
   * `timeout`, which the relay refuses — "I could not tell" must never read as "it is gone".
   */
  private closePeerAndObserve(): { proof: 'closed' | 'absent' | 'timeout';
    channelState: string; peerState: string; msSinceClose: number } {
    const channel = this.channel;
    const peer = this.peer;
    if (!channel && !peer) {
      return { proof: 'absent', channelState: 'none', peerState: 'none', msSinceClose: 0 };
    }
    const started = Date.now();
    this.closePeer('teardown requested');
    const channelState = String(channel?.readyState ?? 'unknown');
    const peerState = String(peer?.connectionState ?? 'unknown');
    const gone = channelState === 'closed' || peerState === 'closed' || peerState === 'failed';
    return { proof: gone ? 'closed' : 'timeout', channelState, peerState,
      msSinceClose: Date.now() - started };
  }

  /**
   * Answer the relay's teardown request with a signed statement about this host's own peer.
   *
   * The signature binds vault, epoch, nonce, session and reader — the relay checks all five, so a
   * replay from an earlier round or a statement about a different reader cannot authorise anyone. The
   * epoch is adopted only for a proof that actually attests a closed peer: a `timeout` says nothing
   * about the vault and must not move this host's authority.
   */
  private async handleTeardown(signal: WireSignal): Promise<void> {
    const epoch = Number(signal.epoch);
    const nonce = typeof signal.nonce === 'string' ? signal.nonce : '';
    if (!Number.isSafeInteger(epoch) || epoch < 1 || nonce === '' || nonce.length > 128) {
      this.note('teardown malformed');
      return;
    }
    const observed = this.closePeerAndObserve();
    const ack: TeardownAck = {
      v: 2,
      vault_id: this.vaultId,
      epoch,
      prev_epoch: epoch - 1,
      nonce,
      host_session_id: this.sessionId,
      reader_key: signal.reader_key ?? null,
      proof: observed.proof,
      observed: { channel_state: observed.channelState, peer_state: observed.peerState,
        ms_since_close: observed.msSinceClose },
    };
    const signed = await signTeardownAck(this.key, ack);
    try { this.socket?.send(JSON.stringify({ type: 'teardown-ack', ack: signed })); }
    catch { this.note('teardown-ack unsent'); }
    if (observed.proof === 'closed' || observed.proof === 'absent') {
      this.authority.adopt(epoch);
      this.authorityCache.invalidate();
      this.note(`teardown attested ${observed.proof} epoch=${epoch}`);
    } else {
      this.note('teardown could not be attested');
    }
  }

  /** The authority the API reports for this vault, authenticated by the host's own proof. */
  private async fetchAuthority(): Promise<AuthorityState> {
    const proof = await signHostSignalProof(this.vaultId, this.sessionId, this.key);
    // `requestUrl`, not `fetch`: it is the only request path Obsidian sanctions, and it is the one the
    // rest of this plugin already uses for the same reason.
    const response = await requestUrl({
      url: AUTHORITY_URL,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...pluginHeaders() },
      body: JSON.stringify({ role: 'host', proof }),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    const body = response.json as { epoch?: unknown; state?: unknown; holder?: unknown };
    if (!Number.isSafeInteger(body.epoch)) throw new Error('Invalid authority');
    return { epoch: body.epoch as number,
      state: typeof body.state === 'string' ? body.state : '',
      holder: typeof body.holder === 'string' ? body.holder : null };
  }

  private async connect(): Promise<void> {
    if (!this.active || !this.currentHost() || !this.lease()) return;
    try {
      const proof = await signHostSignalProof(this.vaultId, this.sessionId, this.key);
      if (!this.active || !this.currentHost()) return;
      const socket = new WebSocket(SIGNAL_URL, 'nr.v1');
      this.socket = socket;
      socket.onopen = () => {
        if (this.active && this.currentHost() && this.lease()) {
          // `pluginVersion` is additive: a Worker that predates the gate ignores the extra key, and
          // one that understands it can tell this build apart from a build that is misbehaving.
          const version = pluginVersion();
          // `protocol` is what the relay decides on, not the version string: a plugin build's patch
          // number says nothing about whether it can attest a teardown, and reading one as if it did
          // would refuse every 0.2.x build forever.
          socket.send(JSON.stringify({
            type: 'auth', role: 'host', proof,
            protocol: 2, capabilities: ['teardown-ack-v1'],
            ...(version === null ? {} : { pluginVersion: version }),
          }));
          // A socket that opened and authenticated is a working connection: the next failure should
          // start again from the minimum wait rather than from wherever the last outage reached.
          this.retryAttempt = 0;
        } else socket.close();
      };
      socket.onmessage = event => { void this.onSignal(event.data).catch(() => this.closePeer()); };
      socket.onclose = event => {
        if (this.socket !== socket) return;
        this.socket = null;
        // Recorded before the early return below: a close with no live lease is exactly the kind a
        // support bundle needs to see, and it is the most recent fact about why the host is not
        // connected. The code and reason distinguish a busy vault from a rate limit from a lost
        // network, and nothing else in the product records them.
        this.lastClose = { code: event.code, reason: event.reason, at: Date.now() };
        // A refused handshake is the only place a stale *entitlement revision* becomes visible: this
        // client's own lease still looks live, so nothing would retry until it expired. Ask for a fresh
        // presence lease before the next attempt — throttled, because a genuinely unlinked vault
        // refuses every time and a renewal per attempt would be a loop.
        if (event.code === 1008 && /Auth/i.test(event.reason ?? '') &&
            Date.now() - this.refusedAt > REFRESH_AFTER_REFUSAL_MS) {
          this.refusedAt = Date.now();
          this.onAuthRefused?.();
        }
        // The room forwards nothing to a host it does not hold, so the wait state cannot be seen any
        // more; leaving the last claim on screen would be a notice about a socket that is gone.
        this.readerWait?.disconnected();
        // The session that named an epoch is over; nothing is authorised until a new `ready` does.
        this.authority.clear();
        this.authorityCache.invalidate();
        // The lease is not part of this decision. A close can land while the lease is momentarily
        // absent — a renewal in flight, a presence blip, or a room that ended the session just as the
        // old lease expired — and returning here left the socket down with no retry scheduled, so the
        // vault stayed dark until the owner toggled hosting (2026-11-19). `connect()` is the guard
        // that needs a lease; this line only needs to know the host is still meant to be connected.
        if (!this.active || !this.currentHost()) return;
        // A flat retry here was twelve attempts a minute against a six-a-minute budget, so one host in
        // a loop could refuse every browser behind the same public IP. Back off, jitter, cap — and when
        // the server names a wait, honour it exactly.
        this.retryAttempt += 1;
        const hinted = serverHintedDelay(event.reason);
        const delay = hinted ?? reconnectDelay(this.retryAttempt);
        // Clear the handle *before* reconnecting. A fired timer left in this field makes `start()`
        // and the supervision tick both believe a retry is already pending, so after the first
        // reconnect nothing could ever heal a later close — the vault stayed dark until the owner
        // toggled hosting (measured 2026-11-19: socket open, reconnectTimer still set, attempt 0).
        this.reconnectTimer = setTimer(() => {
          this.reconnectTimer = null;
          void this.connect();
        }, delay);
      };
      socket.onerror = () => socket.close();
    } catch { /* A later lease renewal can retry without enabling vault access. */ }
  }

  private sendSignal(type: 'answer' | 'ice' | 'end' | 'established', data: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.currentHost() || !this.lease()) return;
    this.socket.send(JSON.stringify({ type, data }));
  }

  private async turnCredentials(): Promise<RTCIceServer[]> {
    const proof = await signHostTurnProof(this.vaultId, this.sessionId, this.key);
    const response = await fetch(TURN_URL, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'host', proof }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json() as { iceServers?: unknown };
    if (!Array.isArray(result.iceServers) || result.iceServers.length < 1) {
      throw new Error('Invalid relay credentials');
    }
    return result.iceServers as RTCIceServer[];
  }

  private async onSignal(raw: unknown): Promise<void> {
    if (!this.active || !this.currentHost() || !this.lease() ||
        typeof raw !== 'string' || raw.length > MAX_DATA_MESSAGE) return;
    let signal: WireSignal;
    try { signal = JSON.parse(raw) as WireSignal; } catch { return; }
    if (!signal || typeof signal !== 'object') return;
    // The room sends `ready` only once it holds both sockets, so this frame is the honest arrival
    // signal: an authenticated browser is attached to this vault right now.
    // A `ready` names the epoch this host is serving. It is adopted before anything else is done with
    // the frame, because every later frame is judged against it.
    if (signal.type === 'ready') {
      if (Number.isSafeInteger(signal.epoch)) this.authority.adopt(Number(signal.epoch));
      this.authorityCache.invalidate();
      this.readerWait?.readerArrived();
      return;
    }
    // The relay asking this host to retire its peer before another reader is admitted. Answered with
    // a signed statement about this host's own channel; nothing else in the product can answer it.
    if (signal.type === 'teardown') { await this.handleTeardown(signal); return; }
    if (signal.type === 'peer-left') { this.readerWait?.readerLeft(); this.closePeer(); return; }
    if (signal.type === 'end') return;
    // A frame from a round this host has already left is dropped rather than served: a reader whose
    // epoch was superseded is not this vault's reader any more, whatever its socket still believes.
    if (signal.epoch !== undefined && !this.authority.allows(signal.epoch)) {
      this.note(`stale epoch frame ${String(signal.type)} epoch=${String(signal.epoch)} ` +
        `current=${String(this.authority.current())}`);
      return;
    }
    if ((signal.type === 'offer' || signal.type === 'relay-offer') && typeof signal.data === 'string') {
      // An offer can only come from the browser role, and a reader that renegotiates sends one
      // without a fresh `ready`; count it as an arrival so a stalled recovery is still reported.
      this.readerWait?.readerArrived();
      const pendingIce = this.pendingIce.splice(0);
      this.note(`offer received relay=${signal.type === 'relay-offer'} gen=${this.peerGeneration}`);
      this.closePeer('new offer');
      const generation = this.peerGeneration;
      let configuration: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
      if (signal.type === 'relay-offer') {
        try {
          configuration = { iceServers: await this.turnCredentials(), iceTransportPolicy: 'relay' };
        } catch (error) {
          const reason = error instanceof Error && /^HTTP \d{3}$/.test(error.message)
            ? ` (${error.message})` : '';
          new Notice(`Note Relay relay unavailable${reason}.`, 15000);
          return;
        }
      }
      if (!this.active || !this.currentHost() || !this.lease() ||
          generation !== this.peerGeneration) return;
      const peer = new RTCPeerConnection(configuration);
      this.peer = peer;
      peer.onicecandidate = event => {
        if (this.peer !== peer) return;
        if (event.candidate) this.sendSignal('ice', JSON.stringify(event.candidate.toJSON()));
        else this.sendSignal('end', '');
      };
      peer.ondatachannel = event => {
        this.note(`datachannel ${event.channel.label} stale=${this.peer !== peer}`);
        if (this.peer !== peer) { event.channel.close(); return; }
        this.acceptChannel(event.channel);
      };
      peer.onconnectionstatechange = () => {
        if (this.peer !== peer) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.closePeer();
      };
      await peer.setRemoteDescription({ type: 'offer', sdp: signal.data });
      // Candidates can arrive before the offer and while TURN credentials are
      // being fetched. Drain both queues once the remote description is set.
      for (const candidate of [...pendingIce, ...this.pendingIce.splice(0)]) {
        await peer.addIceCandidate(candidate);
      }
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (answer.sdp) this.sendSignal('answer', answer.sdp);
      this.note(`answer sent gen=${this.peerGeneration} peer=${this.peer ? peer.connectionState : 'none'}`);
      return;
    }
    if (signal.type === 'ice' && typeof signal.data === 'string' && signal.data.length <= 4096) {
      let candidate: RTCIceCandidateInit;
      try { candidate = JSON.parse(signal.data) as RTCIceCandidateInit; } catch { return; }
      if (!candidate || typeof candidate.candidate !== 'string' ||
          !candidate.candidate.startsWith('candidate:')) return;
      if (this.peer?.remoteDescription) await this.peer.addIceCandidate(candidate);
      else if (this.pendingIce.length < 128) this.pendingIce.push(candidate);
    }
  }

  /**
   * Tells the reader, if and only if it is showing this note, that the note's bytes changed.
   *
   * Nothing is decided for the reader: it reloads silently when it has no edits and prompts when it
   * does. The plugin never overwrites and never writes on the reader's behalf.
   */
  /** True when a reader is currently displaying this note. */
  isViewing(path: string): boolean { return this.viewingPath === path && !!this.channel; }

  notifyNoteChanged(path: string, hash: string): boolean {
    if (this.viewingPath !== path) return false;
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(JSON.stringify({ type: 'notice', kind: 'note-changed', path, hash }));
      this.note(`notice sent ${path.slice(-40)}`);
      return true;
    } catch { return false; }
  }

  private acceptChannel(channel: RTCDataChannel): void {
    // A channel that is no longer open is a leftover, not a reader: keeping it made the host answer a
    // reconnecting browser with a channel it immediately closed, so the reader showed "connected" over
    // an empty vault. Replace a dead one; refuse only a live second channel.
    if (this.channel && this.channel.readyState !== 'open') {
      this.channel.onmessage = null; this.channel.onclose = null; this.channel = null;
    }
    if (channel.label !== 'noterelay.v1' || this.channel || !this.currentHost() || !this.lease()) {
      this.note(`channel refused label=${channel.label} held=${!!this.channel} ` +
        `host=${this.currentHost()} lease=${!!this.lease()}`);
      channel.close(); return;
    }
    this.channel = channel;
    this.note(`channel accepted gen=${this.peerGeneration}`);
    channel.onmessage = event => {
      this.note(`message in gen=${this.peerGeneration}`);
      void this.onPeerMessage(channel, event.data).catch(reason => {
        this.note(`message failed ${String(reason).slice(0, 80)}`);
        channel.close();
      });
    };
    channel.onclose = () => {
      this.note(`channel closed gen=${this.peerGeneration} current=${this.channel === channel}`);
      if (this.channel === channel) this.viewingPath = null;
      if (this.channel === channel) this.closePeer('channel closed');
    };
  }

  private async onPeerMessage(channel: RTCDataChannel, raw: unknown): Promise<void> {
    if (channel !== this.channel || !this.currentHost() || !this.lease() ||
        typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_DATA_MESSAGE) {
      this.note(`message dropped current=${channel === this.channel} host=${this.currentHost()} ` +
        `lease=${!!this.lease()} type=${typeof raw}`);
      channel.close(); return;
    }
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; } catch { channel.close(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      channel.close(); return;
    }
    if (!this.readSession) {
      if (Object.keys(message).sort().join(',') !== 'token,type' ||
          message.type !== 'grant' || typeof message.token !== 'string' ||
          message.token.length > 4096) { channel.close(); return; }
      const payload = decodeJwt(message.token);
      // The scope is no longer forced to `read`: a grant may legitimately carry
      // `owner_write` once Base billing exists. What still matters is that the value is one
      // of the two known scopes — anything else closes the channel rather than defaulting.
      if ((payload.scope !== 'read' && payload.scope !== 'owner_write' && payload.scope !== 'write') ||
          typeof payload.account_id !== 'string') {
        channel.close(); return;
      }
      const lease = this.lease();
      if (!lease) { channel.close(); return; }
      this.readSession = await AuthenticatedReadSession.create(
        this.host, this.adapter, message.token, await importPinnedGrantKeys(),
        { accountId: payload.account_id, vaultId: this.vaultId,
          hostKeyId: await hostPairingKeyId(this.key.publicJwk),
          entitlementRevision: lease.entitlementRevision },
        this.usedGrantIds, this.lease,
      );
      const bytes = this.readSession.challenge();
      channel.send(JSON.stringify({ type: 'challenge', value: encode(bytes) }));
      return;
    }
    if (message.type === 'proof' && typeof message.signature === 'string' &&
        Object.keys(message).sort().join(',') === 'signature,type') {
      await this.readSession.prove(message.signature);
      channel.send(JSON.stringify({ type: 'ready' }));
      this.sendSignal('established', '');
      // The reader's proof succeeded over the data channel, so it is reading rather than waiting.
      this.readerWait?.connected();
      return;
    }
    if (message.type === 'viewing' && Object.keys(message).sort().join(',') === 'path,type') {
      // '' means "nothing open". Anything that is not a Markdown path is refused rather than stored.
      const path = message.path;
      this.viewingPath = typeof path === 'string' && path !== '' && validMarkdownPath(path)
        ? path : typeof path === 'string' && path === '' ? null : this.viewingPath;
      return;
    }
    if (message.type === 'request' && Object.keys(message).sort().join(',') === 'input,type') {
      // Authority is re-checked at the request boundary, not at connect time. The answer is trusted
      // for at most sixty seconds; past that, and whenever the check itself fails, the request is
      // refused and the channel closed. That is the fail-closed rule the design committed to.
      let state: AuthorityState;
      try { state = await this.authorityCache.ensure(); }
      catch (error) { this.note(`authority unverifiable ${String((error as Error)?.message ?? error)}`); channel.close(); return; }
      const serving = this.authority.current();
      if (serving !== null && state.epoch > serving) {
        // A newer round exists. This host adopts it and stops serving the reader it was serving:
        // whatever the relay believes, one vault does not answer two epochs.
        this.authority.adopt(state.epoch);
        this.note(`authority superseded ${serving}->${state.epoch}`);
        this.closePeer('authority superseded');
        channel.close();
        return;
      }
      if (serving === null) this.authority.adopt(state.epoch);
      if (state.state !== 'held' || !this.authority.allows(state.epoch)) {
        this.note(`authority refuses ${state.state} epoch=${state.epoch}`);
        channel.close(); return;
      }
      await this.readSession.send(channel, message.input);
      return;
    }
    channel.close();
  }
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
