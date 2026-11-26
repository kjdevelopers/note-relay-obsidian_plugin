/**
 * The status bar's menu, as data rather than as calls.
 *
 * The status bar used to be a bare toggle: it said "remote presence active" and one click turned hosting
 * off. That is the wrong control for the two moments that matter. An owner debugging a connection wants
 * to know what each action will do *before* pressing it, and an owner who has just lost a reader needs to
 * stop, restart or hand over a log without hunting through the command palette.
 *
 * So the entries are computed here, from state, and rendered by `main.ts` through Obsidian's own `Menu`.
 * Keeping the decision separate is what makes it testable in node: no `Menu`, no DOM, just which actions
 * exist, what they say, and whether they are available.
 */

/** What the plugin knows about itself at the moment the menu opens. */
export type HostingSnapshot = {
  /** The local read host: the switch the owner owns. */
  hosting: boolean;
  /** A lifecycle transition is in flight; overlapping ones are what produced duplicate hosts. */
  transitioning: boolean;
  /** What the relay last said: null means nothing has been refused, otherwise a short reason. */
  remoteStatus: string | null;
};

export type StatusAction = 'start' | 'stop' | 'restart' | 'copy-diagnostics' | 'open-settings';

export type StatusEntry = {
  action: StatusAction;
  label: string;
  enabled: boolean;
  /** A second line under the label, only where it prevents a wrong expectation. */
  detail?: string;
};

/**
 * The heading line at the top of the menu.
 *
 * Hosting and reachability are different facts and the wording keeps them apart: "hosting on" is what the
 * plugin is doing, "presence active" is the last thing the relay confirmed, and neither is a browser
 * connection. Reporting them as one was how a vault looked connected while no reader could reach it.
 */
export function hostingHeading(state: HostingSnapshot): string {
  if (state.transitioning) return 'Note Relay: changing hosting…';
  if (!state.hosting) return 'Note Relay: hosting stopped';
  return state.remoteStatus ? `Note Relay: hosting on · ${state.remoteStatus}` : 'Note Relay: hosting on · presence active';
}

/**
 * The actions, in the order they should appear.
 *
 * While hosting: Start is shown but disabled, Stop and Restart are available. While stopped: Start is
 * available and Stop/Restart are disabled rather than hidden — a menu whose rows move around is a menu
 * people mis-click. Copy diagnostics and Settings are always available, including while a lifecycle
 * transition is in flight and while the relay is refusing: those are the moments the log matters most.
 */
export function statusEntries(state: HostingSnapshot): StatusEntry[] {
  const busy = state.transitioning;
  const entries: StatusEntry[] = [
    { action: 'start', label: 'Start hosting', enabled: !state.hosting && !busy },
    { action: 'stop', label: 'Stop hosting', enabled: state.hosting && !busy },
    { action: 'restart', label: 'Restart hosting', enabled: state.hosting && !busy,
      detail: 'Readers connected now will be disconnected' },
    { action: 'copy-diagnostics', label: 'Copy diagnostic log', enabled: true },
    { action: 'open-settings', label: 'Open Note Relay settings', enabled: true },
  ];
  return entries;
}

/**
 * What to say after a lifecycle action, given what actually happened.
 *
 * Never called with a failure: a failed transition reports the failure instead of a success sentence.
 * "restart" says which halves ran, because a restart that stopped and could not start is a different
 * state from one that never stopped.
 */
export function transitionNotice(action: 'start' | 'stop' | 'restart', outcome: 'done' | 'already'): string {
  if (outcome === 'already') {
    return action === 'start' ? 'Note Relay was already hosting'
      : action === 'stop' ? 'Note Relay was not hosting' : 'Note Relay hosting restarted';
  }
  switch (action) {
    case 'start': return 'Note Relay hosting on — the relay is contacted next';
    case 'stop': return 'Note Relay hosting stopped';
    default: return 'Note Relay hosting restarted';
  }
}
