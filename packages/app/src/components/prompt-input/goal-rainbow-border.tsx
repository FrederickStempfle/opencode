import { For, Show } from "solid-js"

const DURATION = "2s"
const LAYERS = 26
const HEAD_LEN = 4
const TAIL_LEN = 62

type TrailLayer = {
  dash: number
  width: number
  color: string
  opacity: number
  head: boolean
}

type Hsl = { h: number; s: number; l: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// Build the comet as many thin, smoothly-interpolated layers instead of a few uniform
// bands — at this density the per-layer steps disappear and read as one continuous fade.
// Layers are ordered tail→head (head drawn last, on top). Each layer's dashoffset is
// animated `L → L-100` so all layers keep the same FRONT edge while travelling.
function makeTrail(head: Hsl, tail: Hsl): TrailLayer[] {
  return Array.from({ length: LAYERS }, (_, index) => {
    // frac: 0 at the head, 1 at the tail (index 0 is the tail, so it draws first).
    const frac = 1 - index / (LAYERS - 1)
    const fade = Math.pow(1 - frac, 1.35)
    return {
      dash: lerp(HEAD_LEN, TAIL_LEN, frac),
      width: lerp(2.6, 1, frac),
      color: `hsl(${lerp(head.h, tail.h, frac).toFixed(1)} ${lerp(head.s, tail.s, frac).toFixed(1)}% ${lerp(head.l, tail.l, frac).toFixed(1)}%)`,
      opacity: Math.max(0.05, fade),
      head: index === LAYERS - 1,
    }
  })
}

const THEME = {
  active: {
    base: "hsl(276 68% 58%)",
    headGlow: "drop-shadow(0 0 2.5px hsl(0 0% 100% / 0.7)) drop-shadow(0 0 6px hsl(284 100% 78% / 0.35))",
    trail: makeTrail({ h: 285, s: 0, l: 100 }, { h: 278, s: 82, l: 68 }),
  },
  done: {
    base: "hsl(150 55% 45%)",
    headGlow: "drop-shadow(0 0 2.5px hsl(150 90% 92% / 0.7)) drop-shadow(0 0 6px hsl(150 100% 70% / 0.35))",
    trail: makeTrail({ h: 150, s: 30, l: 99 }, { h: 150, s: 78, l: 66 }),
  },
  // The loop stalled but is recoverable (unreadable/timed-out verdict): amber.
  paused: {
    base: "hsl(38 92% 52%)",
    headGlow: "drop-shadow(0 0 2.5px hsl(40 100% 92% / 0.7)) drop-shadow(0 0 6px hsl(38 100% 70% / 0.35))",
    trail: makeTrail({ h: 42, s: 40, l: 99 }, { h: 38, s: 90, l: 62 }),
  },
  // A call threw: red.
  error: {
    base: "hsl(0 72% 55%)",
    headGlow: "drop-shadow(0 0 2.5px hsl(0 100% 92% / 0.7)) drop-shadow(0 0 6px hsl(0 100% 70% / 0.35))",
    trail: makeTrail({ h: 0, s: 40, l: 99 }, { h: 0, s: 80, l: 64 }),
  },
} as const

export type GoalBorderState = keyof typeof THEME

const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

/**
 * "Goal mode" border: a solid outline around the input bar with a single comet of light
 * shooting around the whole perimeter, leaving a smoothly fading trail. Purple while the
 * goal is active, green for a moment once it's achieved, amber when paused, red on error.
 */
export function GoalRainbowBorder(props: { state: GoalBorderState }) {
  const animate = !prefersReducedMotion()
  const theme = () => THEME[props.state] ?? THEME.active
  return (
    <svg
      data-component="goal-rainbow-border"
      data-state={props.state}
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 z-30 h-full w-full overflow-visible"
      preserveAspectRatio="none"
    >
      <rect data-slot="goal-rainbow-rect" fill="none" stroke={theme().base} stroke-width="2" />
      <For each={theme().trail}>
        {(layer) => (
          <rect
            data-slot="goal-rainbow-comet"
            fill="none"
            stroke={layer.color}
            stroke-opacity={layer.opacity}
            stroke-width={layer.width}
            stroke-linecap="round"
            pathLength="100"
            stroke-dasharray={`${layer.dash} ${100 - layer.dash}`}
            style={layer.head ? { filter: theme().headGlow } : undefined}
          >
            <Show when={animate}>
              <animate
                attributeName="stroke-dashoffset"
                from={`${layer.dash}`}
                to={`${layer.dash - 100}`}
                dur={DURATION}
                repeatCount="indefinite"
              />
            </Show>
          </rect>
        )}
      </For>
    </svg>
  )
}
