export type IntentGateIntent = 'question' | 'plan' | 'review' | 'execute' | 'ops' | 'none'

/** The current turn's intent and where it came from. */
export type IntentGateTurn = {
  intent?: IntentGateIntent
  confidence?: number
  source: 'jev' | 'override' | 'unavailable' | 'unsure'
}

/** What the next classification reads as evidence about the previous turn. */
export type IntentGatePrevious = {
  intent?: IntentGateIntent
  prompt: string
  replyTail: string
}

declare module 'claude-code' {
  interface PluginState {
    'intent-gate': {
      turn: IntentGateTurn
      previous: IntentGatePrevious
      mode: 'auto' | 'off'
      pinned: IntentGateIntent | null
      running: boolean
    }
  }
}
