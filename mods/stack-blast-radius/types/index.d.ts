export type BlastHeld = {
  /** The held call's tool_use_id. */
  id: string
  label: string
  /** The command or SQL, secrets masked. */
  command: string
  /** Where it would land: workspace, stack, project, kube context. */
  context: string[]
  /** The dry-run preview's lines. */
  lines: string[]
  warnings: string[]
  isMeasuring: boolean
  decision: 'proceed' | 'cancel' | null
  /** Drawn in its pane, or in the band above the prompt when no pane is placed. */
  where: 'pane' | 'band'
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'stack-blast-radius': { held: BlastHeld | null }
  }
}
