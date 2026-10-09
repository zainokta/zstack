/** What ran during the current main-loop turn (subagents' calls included). */
export type EvidenceCheckTurn = {
  tools: number
  checks: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'evidence-check': {
      turn: EvidenceCheckTurn
    }
  }
}
