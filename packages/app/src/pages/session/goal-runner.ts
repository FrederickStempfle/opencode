import { createEffect, onCleanup } from "solid-js"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { useSDK } from "@/context/sdk"
import type { SessionGoal } from "@/context/layout"
import { showToast } from "@/utils/toast"

// Hard stop so a poorly-phrased condition can never loop forever. When hit we
// surface it loudly rather than silently giving up.
const MAX_TURNS = 30
const TRANSCRIPT_LIMIT = 12_000
// Older turns are quoted briefly (just enough for context); the final turn carries the
// completion evidence, so it's quoted at much higher fidelity.
const PART_OUTPUT_LIMIT = 800
const LAST_TURN_OUTPUT_LIMIT = 6_000
// A single evaluator/summary inference must settle within this window. Past it we treat
// the call as unreadable and pause, so a hung request can never wedge the loop.
const EVAL_TIMEOUT_MS = 120_000

// The summarizer only titles text — it must NEVER touch the workspace. The server turns
// this map into permission rules (allow/deny by pattern); an EMPTY map produces no rules
// at all, leaving every tool enabled by default. A single wildcard `"*": false` denies
// every tool (matched via Wildcard.match), so any tool call is auto-rejected.
const NO_TOOLS = { "*": false } as const

// The evaluator, by contrast, must be able to VERIFY claims rather than trust them, so it
// gets a read-only allowlist (mirroring the built-in `explore` agent): deny everything,
// then allow inspection + running read-only commands (tests, builds, linters) via bash.
// EVAL_SYSTEM forbids mutating commands; the deny-all base blocks edit/write/patch.
const EVAL_TOOLS = { "*": false, read: true, grep: true, glob: true, list: true, bash: true } as const

// Plain YES/NO protocol (no structured-output format): parseable by every model.
// Structured output (json_schema) is intentionally avoided — models that don't comply
// trigger server-side retry loops, turning one check into several slow inferences.
const EVAL_SYSTEM = `You are a strict completion evaluator for an autonomous coding agent.
Decide whether the GOAL CONDITION is fully satisfied. Do NOT trust the agent's claims — actively VERIFY them: use read/grep/glob/list to inspect files, and run read-only commands (tests, builds, linters) with bash to confirm behaviour. NEVER modify files or run commands that change state (no writes, installs, migrations, network mutations).
If the evidence is incomplete, ambiguous, unverified, or merely claimed without proof, it is NOT satisfied.
When done verifying, reply with exactly one word on the first line: YES or NO. On the second line, give one short sentence stating what you verified and why it is or isn't met. Output nothing else.`

const SUMMARY_SYSTEM = `Summarize the user's goal as a short title of 3 to 6 words. Output only the title — no quotes, no surrounding text, no trailing punctuation.`

type GoalRunnerInput = {
  sessionID: () => string | undefined
  busy: (id: string) => boolean
  // True when the turn ended on a pending permission/question rather than genuinely
  // finishing — the loop must not fire a continuation on top of a blocked agent.
  blocked: () => boolean
  goalState: () => SessionGoal | undefined
  updateGoal: (patch: Partial<SessionGoal>) => void
  // Optimistically flip the main session's busy flag so the UI and both the goal and
  // queued-followup effects see the continuation immediately (no double-fire window).
  optimisticBusy: (id: string, busy: boolean) => void
  messagesFor: (id: string) => readonly Message[]
  partsFor: (messageID: string) => readonly Part[]
  model: () => { providerID: string; modelID: string } | undefined
  agent: () => string | undefined
  sdk: ReturnType<typeof useSDK>
}

// Settle `promise` or reject after `ms`. Used to bound evaluator/summary inference so a
// hung request surfaces as an unreadable verdict (pause) instead of wedging the loop.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// Pure decision for "should we run an evaluation now?", extracted so the turn-detection
// effect stays a thin reactive wrapper and the conditions are unit-testable.
export function shouldEvaluate(input: {
  finishedTurn: boolean
  active: boolean
  evaluating: boolean
  blocked: boolean
}): boolean {
  return input.finishedTurn && input.active && !input.evaluating && !input.blocked
}

function joinText(parts: readonly Part[]): string {
  return parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n").trim()
}

// The evaluator's answer is normally a text part, but some models surface it only in a
// reasoning part — fall back to any part carrying string text so we don't read "nothing".
export function extractReply(parts: readonly Part[]): string {
  const text = joinText(parts)
  if (text) return text
  return parts
    .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim()
}

function partToText(part: Part, outputLimit: number): string[] {
  if (part.type === "text") return part.text ? [part.text] : []
  if (part.type === "tool") {
    const state = part.state as { status?: string; output?: unknown } | undefined
    const output = typeof state?.output === "string" ? `: ${state.output.slice(0, outputLimit)}` : ""
    const tool = (part as { tool?: string }).tool ?? "?"
    return [`[tool ${tool} ${state?.status ?? ""}${output}]`]
  }
  return []
}

function buildTranscript(input: GoalRunnerInput, sessionID: string): string {
  const recent = input.messagesFor(sessionID).slice(-14)
  const lastIndex = recent.length - 1
  const blocks = recent.map((message, index) => {
    // The final turn holds the completion evidence — quote its tool output at high
    // fidelity; older turns get the short cap just for context.
    const limit = index === lastIndex ? LAST_TURN_OUTPUT_LIMIT : PART_OUTPUT_LIMIT
    const lines = input.partsFor(message.id).flatMap((part) => partToText(part, limit))
    return `${message.role.toUpperCase()}:\n${lines.join("\n")}`
  })
  const text = blocks.join("\n\n")
  return text.length > TRANSCRIPT_LIMIT ? text.slice(-TRANSCRIPT_LIMIT) : text
}

// Read a verdict from the evaluator across model behaviours: a JSON object (structured
// output), a leading YES/NO line, or an explicit "met"/"not met" phrase. Returns null
// when the response genuinely can't be interpreted — the caller pauses rather than
// blindly continuing, so a confused evaluator can't drive an infinite loop.
export function parseVerdict(raw: string): { met: boolean; reason: string } | null {
  if (!raw) return null

  const fromObject = (value: unknown): { met: boolean; reason: string } | undefined => {
    if (typeof value !== "object" || value === null) return undefined
    const record = value as Record<string, unknown>
    // Coerce the common stringy variants ("true"/"yes") so a model that emits met as a
    // string still parses; anything else means this isn't a real verdict object.
    const met = record.met
    const isMet = met === true || met === "true" || met === "yes"
    const isNotMet = met === false || met === "false" || met === "no"
    if (!isMet && !isNotMet) return undefined
    return { met: isMet, reason: typeof record.reason === "string" ? record.reason : "" }
  }

  for (const candidate of [raw, raw.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue
    try {
      const parsed = fromObject(JSON.parse(candidate))
      if (parsed) return parsed.reason ? parsed : { met: parsed.met, reason: parsed.met ? "Condition satisfied." : "Condition not yet satisfied." }
    } catch {
      // not JSON — try the text protocol below
    }
  }

  const trimmed = raw.trim()
  const reason = trimmed.replace(/\s+/g, " ").slice(0, 240)

  // A YES/NO near the start (tolerating markdown/"Answer:" wrappers) is the verdict.
  const head = trimmed.slice(0, 80).toLowerCase().match(/\b(yes|no)\b/)
  if (head) {
    const met = head[1] === "yes"
    return { met, reason: reason || (met ? "Condition satisfied." : "Condition not yet satisfied.") }
  }

  const lower = trimmed.toLowerCase()
  if (/\bnot\s+(?:yet\s+)?(?:met|complete|completed|satisfied|achieved)\b|\bincomplete\b|\bunmet\b/.test(lower)) {
    return { met: false, reason }
  }
  if (/\b(?:fully\s+)?(?:met|complete|completed|satisfied|achieved)\b/.test(lower)) {
    return { met: true, reason }
  }
  return null
}

/**
 * Drives `/goal`: after each turn on the active session completes, a fresh model
 * judges the goal condition against the recent transcript. "met" → the goal is
 * marked achieved and the loop stops; "not met" → another turn is kicked off with
 * the evaluator's feedback, until met, cleared, or the safety cap is hit.
 *
 * The evaluator runs in a hidden child session so the main transcript stays clean.
 * Must be called from a component scope (sets up its own effect + cleanup).
 */
export function createGoalRunner(input: GoalRunnerInput) {
  let prevBusy = false
  let prevID: string | undefined
  let evaluating = false
  let summarizing = false
  // In-flight create, so concurrent callers (summary + evaluator) reuse one session
  // instead of each spawning their own.
  let creating: Promise<string | undefined> | undefined
  // The eval session we're currently responsible for, keyed by its parent session, so
  // we can delete it when the goal ends (and never delete another session's on nav).
  let tracked: { sessionID: string; evalSessionID: string } | undefined

  // The hidden child session that runs both the summary and the per-turn evaluator.
  // Created once and reused (id persisted on the goal).
  const ensureEvalSession = async (sessionID: string): Promise<string | undefined> => {
    const existing = input.goalState()?.evalSessionID
    if (existing) return existing
    if (creating) return creating
    creating = (async () => {
      const created = await input.sdk().client.session.create({
        parentID: sessionID,
        title: "◎ goal evaluator",
        directory: input.sdk().directory,
      })
      const id = created.data?.id
      if (id) input.updateGoal({ evalSessionID: id })
      return id
    })()
    try {
      return await creating
    } finally {
      creating = undefined
    }
  }

  const deleteEvalSession = (evalSessionID: string) => {
    input.sdk().client.session.delete({ sessionID: evalSessionID, directory: input.sdk().directory }).catch(() => {})
  }

  // Generate a short display title for the goal so the UI never shows the raw (possibly
  // enormous) condition. Runs once per goal; failure just leaves the truncated fallback.
  const summarizeGoal = async (sessionID: string) => {
    summarizing = true
    try {
      const goal = input.goalState()
      if (!goal || goal.status !== "active" || goal.summary !== undefined) return
      const model = input.model()
      if (!model) return
      const evalSessionID = await ensureEvalSession(sessionID)
      if (!evalSessionID) return
      const response = await withTimeout(
        input.sdk().client.session.prompt({
          sessionID: evalSessionID,
          directory: input.sdk().directory,
          model,
          tools: NO_TOOLS,
          system: SUMMARY_SYSTEM,
          parts: [{ type: "text", text: goal.condition }],
        }),
        EVAL_TIMEOUT_MS,
      )
      const summary = joinText(response.data?.parts ?? [])
        .split("\n")[0]
        .replace(/^["'`]|["'`]$/g, "")
        .slice(0, 60)
        .trim()
      input.updateGoal({ summary: summary || "Goal" })
    } catch {
      // Leave summary undefined; the status toast falls back to a truncated condition.
    } finally {
      summarizing = false
    }
  }

  const runEvaluation = async (sessionID: string) => {
    evaluating = true
    try {
      const goal = input.goalState()
      if (!goal || goal.status !== "active") return
      const model = input.model()
      if (!model) return
      const client = input.sdk().client
      const directory = input.sdk().directory

      // Clear any prior soft failure: we're taking a fresh swing at the verdict.
      if (goal.paused || goal.error) input.updateGoal({ paused: false, error: undefined })

      const evalSessionID = await ensureEvalSession(sessionID)
      if (!evalSessionID) return

      const transcript = buildTranscript(input, sessionID)
      const promptText = `GOAL CONDITION:\n${goal.condition}\n\nRECENT TRANSCRIPT:\n${transcript || "(empty)"}\n\nVerify against the workspace, then decide: is the condition fully satisfied?`

      // A timeout or transient call failure is treated like a garbled reply (null →
      // pause + retry on the next turn), not a hard error, so a slow/flaky inference
      // can't wedge or kill the loop.
      const ask = async () => {
        try {
          const response = await withTimeout(
            client.session.prompt({
              sessionID: evalSessionID,
              directory,
              model,
              tools: EVAL_TOOLS,
              system: EVAL_SYSTEM,
              parts: [{ type: "text", text: promptText }],
            }),
            EVAL_TIMEOUT_MS,
          )
          return parseVerdict(extractReply(response.data?.parts ?? []))
        } catch {
          return null
        }
      }

      // One call in the common case; a single retry only if the reply was garbled.
      let verdict = await ask()
      if (!verdict) verdict = await ask()

      // Couldn't read a verdict: pause instead of looping on garbage. The goal stays
      // active, so the next message (or another turn) re-evaluates.
      if (!verdict) {
        input.updateGoal({ paused: true, lastReason: "Evaluator response could not be read." })
        showToast({
          title: "◎ Goal paused",
          description: "Couldn't read the evaluator's verdict. Send a message to retry, or run /goal clear.",
        })
        return
      }

      const turns = goal.turns + 1
      input.updateGoal({ turns, lastReason: verdict.reason })

      if (verdict.met) {
        input.updateGoal({ status: "achieved" })
        showToast({ title: "◎ Goal achieved", description: verdict.reason })
        return
      }
      if (turns >= MAX_TURNS) {
        input.updateGoal({ status: "achieved" })
        showToast({ title: "◎ Goal stopped", description: `Hit the ${MAX_TURNS}-turn safety cap. Last check: ${verdict.reason}` })
        return
      }

      // The goal may have been cleared (or replaced) while we were evaluating.
      if (input.goalState()?.status !== "active") return

      // Flip busy optimistically so the UI and the queued-followup effect both see the
      // continuation immediately — otherwise this idle window can launch a second prompt.
      input.optimisticBusy(sessionID, true)
      try {
        await client.session.promptAsync({
          sessionID,
          directory,
          model,
          agent: input.agent(),
          parts: [
            {
              type: "text",
              text: `Goal not complete yet. The evaluator checked the workspace and found: ${verdict.reason}\n\nAddress that specific gap. Goal:\n${goal.condition}`,
            },
          ],
        })
      } catch (error) {
        input.optimisticBusy(sessionID, false)
        throw error
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.updateGoal({ error: message })
      showToast({ title: "◎ Goal evaluation failed", description: message })
    } finally {
      evaluating = false
    }
  }

  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID) {
      prevID = undefined
      prevBusy = false
      return
    }
    // On a session switch, re-baseline without treating it as a turn boundary.
    if (sessionID !== prevID) {
      prevID = sessionID
      prevBusy = input.busy(sessionID)
      return
    }
    const busy = input.busy(sessionID)
    const finishedTurn = prevBusy && !busy
    prevBusy = busy
    if (
      !shouldEvaluate({
        finishedTurn,
        active: input.goalState()?.status === "active",
        evaluating,
        blocked: input.blocked(),
      })
    )
      return
    void runEvaluation(sessionID)
  })

  // Generate the short title as soon as a goal becomes active (independent of turns).
  createEffect(() => {
    const sessionID = input.sessionID()
    const goal = input.goalState()
    if (!sessionID || !goal || goal.status !== "active" || goal.summary !== undefined || summarizing) return
    void summarizeGoal(sessionID)
  })

  // Reap the hidden evaluator session once a goal ends (cleared/achieved) or is replaced,
  // so they don't pile up on disk. Keyed by parent session, so navigating away from a
  // still-active goal never deletes its evaluator.
  createEffect(() => {
    const sessionID = input.sessionID()
    const goal = input.goalState()
    const evalSessionID = goal?.evalSessionID
    const active = goal?.status === "active"

    if (sessionID && active && evalSessionID) {
      // A fresh evaluator replaced an older one for this same session — drop the stale one.
      if (tracked && tracked.sessionID === sessionID && tracked.evalSessionID !== evalSessionID) {
        deleteEvalSession(tracked.evalSessionID)
      }
      tracked = { sessionID, evalSessionID }
      return
    }

    // The goal we were tracking is now gone or finished: delete its evaluator session.
    if (tracked && tracked.sessionID === sessionID) {
      deleteEvalSession(tracked.evalSessionID)
      tracked = undefined
    }
  })

  onCleanup(() => {
    evaluating = false
    summarizing = false
  })
}
