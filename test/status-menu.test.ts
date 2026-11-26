import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostingHeading, statusEntries, transitionNotice, type HostingSnapshot } from '../src/status-menu';

const stopped: HostingSnapshot = { hosting: false, transitioning: false, remoteStatus: null };
const hosting: HostingSnapshot = { hosting: true, transitioning: false, remoteStatus: null };

const entry = (state: HostingSnapshot, action: string) =>
  statusEntries(state).find(item => item.action === action);

test('while hosting, start is present but disabled and stop/restart are available', () => {
  assert.equal(entry(hosting, 'start')?.enabled, false);
  assert.equal(entry(hosting, 'stop')?.enabled, true);
  assert.equal(entry(hosting, 'restart')?.enabled, true);
  // The row stays in place rather than disappearing: a menu whose items move is a menu people mis-click.
  assert.equal(statusEntries(hosting).length, statusEntries(stopped).length);
});

test('while stopped, start is available and stop/restart are not', () => {
  assert.equal(entry(stopped, 'start')?.enabled, true);
  assert.equal(entry(stopped, 'stop')?.enabled, false);
  assert.equal(entry(stopped, 'restart')?.enabled, false);
});

test('the log and the settings stay reachable whatever the connection is doing', () => {
  for (const state of [stopped, hosting, { ...hosting, transitioning: true },
    { ...hosting, remoteStatus: 'refused: upgrade the plugin' }]) {
    assert.equal(entry(state, 'copy-diagnostics')?.enabled, true);
    assert.equal(entry(state, 'open-settings')?.enabled, true);
  }
});

test('a transition in flight disables every lifecycle action, so two cannot overlap', () => {
  const busy: HostingSnapshot = { hosting: true, transitioning: true, remoteStatus: null };
  for (const action of ['start', 'stop', 'restart']) {
    assert.equal(entry(busy, action)?.enabled, false, action);
  }
  assert.equal(hostingHeading(busy), 'Note Relay: changing hosting…');
});

test('restart says what it costs a reader who is connected right now', () => {
  assert.match(entry(hosting, 'restart')?.detail ?? '', /disconnected/);
  // Start and stop carry no such warning: neither interrupts an established reader for a restart.
  assert.equal(entry(stopped, 'start')?.detail, undefined);
  assert.equal(entry(hosting, 'stop')?.detail, undefined);
});

test('the heading keeps hosting and reachability apart', () => {
  assert.equal(hostingHeading(hosting), 'Note Relay: hosting on · presence active');
  assert.equal(hostingHeading(stopped), 'Note Relay: hosting stopped');
  // A refused presence is shown as the relay's own words, not as "connected" and not as a browser state.
  assert.equal(hostingHeading({ ...hosting, remoteStatus: 'refused: plugin out of date' }),
    'Note Relay: hosting on · refused: plugin out of date');
});

test('a completed transition names what happened, and an unnecessary one says so plainly', () => {
  assert.equal(transitionNotice('start', 'done'), 'Note Relay hosting on — the relay is contacted next');
  assert.equal(transitionNotice('stop', 'done'), 'Note Relay hosting stopped');
  assert.equal(transitionNotice('restart', 'done'), 'Note Relay hosting restarted');
  assert.equal(transitionNotice('start', 'already'), 'Note Relay was already hosting');
  assert.equal(transitionNotice('stop', 'already'), 'Note Relay was not hosting');
});
