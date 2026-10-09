export type VaultEntry = { n: number; kind: string; value: string }

// `issued` only grows, so a number is never reused after `/vault clear`.
export type Vault = { entries: VaultEntry[]; issued: number }

declare module 'claude-code' {
  interface PluginState {
    'secret-vault': { vault: Vault }
  }
}
