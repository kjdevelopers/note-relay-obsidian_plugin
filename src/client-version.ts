/**
 * Who this install is, on the wire.
 *
 * Installs are manual until the community store, so the relay cannot assume the plugin it is talking to
 * is the one it shipped. Every presence renewal carries the build so the Worker can apply an operator's
 * deny list — and, just as important, so an old build that sends nothing is *distinguishable* from a
 * current one that is behaving badly.
 *
 * The value is set once at load from `manifest.version`. A default of `null` means "not known yet":
 * `pluginHeaders()` then sends no header at all, because an invented version is worse than silence.
 */

let installedVersion: string | null = null;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export function setPluginVersion(version: unknown): void {
  installedVersion = typeof version === 'string' && VERSION.test(version.trim())
    ? version.trim() : null;
}

export function pluginVersion(): string | null {
  return installedVersion;
}

/** Header name the Worker reads. Kept in step with `cloud/src/plugin-policy.ts`. */
export const PLUGIN_VERSION_HEADER = 'x-note-relay-plugin';

/** Request headers for this build. Empty when the version is not known. */
export function pluginHeaders(): Record<string, string> {
  return installedVersion === null ? {} : { [PLUGIN_VERSION_HEADER]: installedVersion };
}
