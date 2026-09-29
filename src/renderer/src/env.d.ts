/// <reference types="react" />

declare global {
  interface Window {
    dy?: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>
      on: (channel: string, cb: (data: unknown) => void) => () => void
    }
  }
}

export {}
