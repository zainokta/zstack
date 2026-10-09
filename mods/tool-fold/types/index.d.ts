export type FoldOpen = boolean

declare module 'claude-code' {
  interface PluginState {
    'tool-fold': { open: StateFamily<FoldOpen> }
  }
}
