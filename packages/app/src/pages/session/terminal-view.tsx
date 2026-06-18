import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

import { Terminal } from "@/components/terminal"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { focusTerminalById } from "@/pages/session/helpers"

/**
 * Renders a single terminal pty. Each pty is its own side-panel tab, so there
 * is no per-terminal tab strip here — `active` controls focus, the parent owns
 * tab switching and creation.
 */
export function TerminalView(props: { pty: LocalPTY; active: Accessor<boolean> }) {
  const delays = [120, 240]
  const terminal = useTerminal()
  const ops = terminal.bind()

  const [store, setStore] = createStore({ recovered: false })

  const recoveryKey = () => String(props.pty.titleNumber || props.pty.title || props.pty.id)

  const onConnect = () => {
    setStore("recovered", false)
    ops.trim(props.pty.id)
  }

  const onConnectError = () => {
    if (store.recovered) return
    setStore("recovered", true)
    void ops.clone(props.pty.id)
  }

  createEffect(
    on(props.active, (active) => {
      if (!active) return
      const id = props.pty.id

      focusTerminalById(id)
      const frame = requestAnimationFrame(() => {
        if (!props.active()) return
        focusTerminalById(id)
      })
      const timers = delays.map((ms) =>
        window.setTimeout(() => {
          if (!props.active()) return
          focusTerminalById(id)
        }, ms),
      )

      onCleanup(() => {
        cancelAnimationFrame(frame)
        for (const timer of timers) clearTimeout(timer)
      })
    }),
  )

  return (
    <div class="flex flex-col h-full min-h-0 overflow-hidden bg-background-stronger">
      <div class="flex-1 min-h-0 relative">
        <div id={`terminal-wrapper-${props.pty.id}`} class="absolute inset-0">
          <Terminal
            pty={props.pty}
            autoFocus={props.active()}
            onConnect={onConnect}
            onCleanup={ops.update}
            onConnectError={onConnectError}
          />
        </div>
      </div>
    </div>
  )
}
