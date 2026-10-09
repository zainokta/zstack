export type ZstackPaneAgent = {
  id: string
  role: string
  harness: string
  model: string
  state: string
  task: string | null
  unread: number
}

export type ZstackPaneTask = { id: string; state: string; owner: string | null; rounds: number; title: string }

export type ZstackPaneMessage = { seq: number; kind: string; from: string; to: string; body: string }

export type ZstackPaneRun = {
  id: string
  goal: string
  state: string
  maxAgents: number
  maxParallel: number
  agents: ZstackPaneAgent[]
  tasks: ZstackPaneTask[]
  alerts: ZstackPaneMessage[]
}

// What the pane draws: a run, the "no run" hint, or why zstack could not be read.
export type ZstackPaneView =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error'; text: string }
  | { kind: 'run'; run: ZstackPaneRun; at: string }

declare module 'claude-code' {
  interface PluginState {
    'zstack-pane': { view: ZstackPaneView; draft: string; notice: string }
  }
}
