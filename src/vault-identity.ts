/**
 * Whether this vault already has an identity, needs one, or has one that must not be replaced.
 *
 * The distinction that matters: a store with NO identity is the normal first-run state — toggling hosting writes
 * `hostingEnabled` before anything asks for a `vaultId` — while a store with a vaultId that is present and malformed
 * may already be registered on the relay and must be refused rather than silently replaced. An earlier version
 * treated both as corruption, so a fresh install that had its settings written first could never pair at all.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type VaultIdentityPlan =
  | { action: 'reuse'; vaultId: string }
  | { action: 'mint' }
  | { action: 'refuse' };

export function planVaultIdentity(saved: unknown): VaultIdentityPlan {
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    const value = (saved as { vaultId?: unknown }).vaultId;
    if (typeof value === 'string' && uuid.test(value)) return { action: 'reuse', vaultId: value };
    if (value !== undefined && value !== null) return { action: 'refuse' };
  }
  return { action: 'mint' };
}
