import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { extractReply, parseVerdict, shouldEvaluate, withTimeout } from "./goal-runner"

const textPart = (text: string) => ({ type: "text", text }) as Part
const reasoningPart = (text: string) => ({ type: "reasoning", text }) as Part
const toolPart = () => ({ type: "tool", tool: "bash", state: { status: "completed" } }) as Part

describe("parseVerdict", () => {
  test("reads structured JSON output", () => {
    expect(parseVerdict('{"met": true, "reason": "Tests pass."}')).toEqual({ met: true, reason: "Tests pass." })
    expect(parseVerdict('{"met": false, "reason": "No tests run yet."}')).toEqual({
      met: false,
      reason: "No tests run yet.",
    })
  })

  test("salvages JSON embedded in prose or code fences", () => {
    const fenced = 'Here is my verdict:\n```json\n{"met": true, "reason": "Done."}\n```'
    expect(parseVerdict(fenced)).toEqual({ met: true, reason: "Done." })
  })

  test("fills a default reason when JSON omits one", () => {
    expect(parseVerdict('{"met": true}')).toEqual({ met: true, reason: "Condition satisfied." })
    expect(parseVerdict('{"met": false}')).toEqual({ met: false, reason: "Condition not yet satisfied." })
  })

  test("reads a leading YES/NO, tolerating markdown and prefixes", () => {
    expect(parseVerdict("YES\nThe feature is implemented.")?.met).toBe(true)
    expect(parseVerdict("**NO** — still missing the migration.")?.met).toBe(false)
    expect(parseVerdict("Answer: yes, everything compiles.")?.met).toBe(true)
  })

  test("reads met/not-met phrasing from prose", () => {
    expect(parseVerdict("The condition is not yet met because the build fails.")?.met).toBe(false)
    expect(parseVerdict("The goal has been fully satisfied.")?.met).toBe(true)
  })

  test("returns null when there is no verdict to read (e.g. empty / unauthenticated)", () => {
    expect(parseVerdict("")).toBeNull()
    expect(parseVerdict("   ")).toBeNull()
    expect(parseVerdict("I am not sure what you are asking about here.")).toBeNull()
  })

  test("ignores JSON that has no verdict field", () => {
    expect(parseVerdict('{"foo": "bar"}')).toBeNull()
  })

  test("coerces stringy met values from sloppy models", () => {
    expect(parseVerdict('{"met": "true", "reason": "ok"}')).toEqual({ met: true, reason: "ok" })
    expect(parseVerdict('{"met": "false", "reason": "nope"}')).toEqual({ met: false, reason: "nope" })
  })
})

describe("extractReply", () => {
  test("joins text parts", () => {
    expect(extractReply([textPart("YES"), textPart("done")])).toBe("YES\ndone")
  })

  test("falls back to reasoning parts when no text part has content", () => {
    expect(extractReply([toolPart(), reasoningPart('{"met": false, "reason": "wip"}')])).toBe(
      '{"met": false, "reason": "wip"}',
    )
  })

  test("prefers text parts over reasoning parts", () => {
    expect(extractReply([reasoningPart("thinking..."), textPart("NO")])).toBe("NO")
  })

  test("returns empty string when there is nothing to read", () => {
    expect(extractReply([toolPart()])).toBe("")
    expect(extractReply([])).toBe("")
  })
})

describe("shouldEvaluate", () => {
  const base = { finishedTurn: true, active: true, evaluating: false, blocked: false }

  test("runs only on a finished turn of an active, unblocked, idle-evaluator goal", () => {
    expect(shouldEvaluate(base)).toBe(true)
  })

  test("does not run mid-turn", () => {
    expect(shouldEvaluate({ ...base, finishedTurn: false })).toBe(false)
  })

  test("does not run when the goal is not active", () => {
    expect(shouldEvaluate({ ...base, active: false })).toBe(false)
  })

  test("does not run while an evaluation is already in flight", () => {
    expect(shouldEvaluate({ ...base, evaluating: true })).toBe(false)
  })

  test("does not run when the turn ended blocked on a permission/question", () => {
    expect(shouldEvaluate({ ...base, blocked: true })).toBe(false)
  })
})

describe("withTimeout", () => {
  test("passes through a value that resolves in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42)
  })

  test("propagates a rejection without waiting for the timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom")
  })

  test("rejects when the promise outlasts the timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 50))
    await expect(withTimeout(slow, 5)).rejects.toThrow(/timed out/)
  })
})

describe("evaluator pipeline (extract then parse)", () => {
  test("a reasoning-only JSON verdict is read end-to-end", () => {
    const parts = [toolPart(), reasoningPart('{"met": true, "reason": "All checks green."}')]
    expect(parseVerdict(extractReply(parts))).toEqual({ met: true, reason: "All checks green." })
  })

  test("an empty response (no API key) yields no verdict, so the runner pauses", () => {
    expect(parseVerdict(extractReply([]))).toBeNull()
  })
})
