export type GitGuardPrompt = string

declare module 'claude-code' {
  interface PluginState {
    'git-guard': { prompt: GitGuardPrompt; paused: boolean }
  }
}
