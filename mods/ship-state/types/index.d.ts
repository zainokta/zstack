export type ShipGit = {
  branch: string
  hasUpstream: boolean
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicted: number
}

export type ShipTest = { isPassed: boolean; command: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'ship-state': { git: ShipGit | null; test: ShipTest | null; now: number }
  }
}
