export type LoopFailure = { head: string; error: string; count: number }

// The error lines of the last error the user pasted, and how often it came back.
export type LoopPaste = { lines: string[]; count: number }

declare module 'claude-code' {
  interface PluginState {
    'loop-breaker': { failures: Record<string, LoopFailure>; paste: LoopPaste | null }
  }
}
