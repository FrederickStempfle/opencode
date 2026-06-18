import { describe, expect, test } from "bun:test"
import { parseStructuredTitle, parseStructuredVerdict, shouldEvaluate, withTimeout } from "./goal-runner"

describe("parseStructuredVerdict", () => {
  test("passes a valid verdict through, trimming and collapsing the reason", () => {
    expect(parseStructuredVerdict({ met: true, reason: "tests   pass" })).toEqual({ met: true, reason: "tests pass" })
    expect(parseStructuredVerdict({ met: false, reason: "  build\nfails  " })).toEqual({
      met: false,
      reason: "build fails",
    })
  })

  test("fills a met-dependent default when the reason is empty", () => {
    expect(parseStructuredVerdict({ met: true, reason: "   " })).toEqual({ met: true, reason: "Condition satisfied." })
    expect(parseStructuredVerdict({ met: false, reason: "" })).toEqual({
      met: false,
      reason: "Condition not yet satisfied.",
    })
  })

  test("truncates an overlong reason to 240 chars", () => {
    const verdict = parseStructuredVerdict({ met: true, reason: "x".repeat(500) })
    expect(verdict?.reason.length).toBe(240)
  })

  test("ignores extra properties alongside a valid verdict", () => {
    expect(parseStructuredVerdict({ met: true, reason: "ok", extra: 1 })).toEqual({ met: true, reason: "ok" })
  })

  test("returns null when structured output is absent (StructuredOutputError / no key)", () => {
    expect(parseStructuredVerdict(undefined)).toBeNull()
    expect(parseStructuredVerdict(null)).toBeNull()
  })

  test("returns null for a non-object or malformed shape", () => {
    expect(parseStructuredVerdict("yes")).toBeNull()
    expect(parseStructuredVerdict(42)).toBeNull()
    expect(parseStructuredVerdict([])).toBeNull()
    expect(parseStructuredVerdict({ reason: "missing met" })).toBeNull()
    expect(parseStructuredVerdict({ met: "yes", reason: "wrong type" })).toBeNull()
    expect(parseStructuredVerdict({ met: true })).toBeNull()
    expect(parseStructuredVerdict({ met: true, reason: 1 })).toBeNull()
  })
})

describe("parseStructuredTitle", () => {
  test("returns a cleaned, first-line, 60-char-capped title", () => {
    expect(parseStructuredTitle({ title: "  Add dark mode toggle  " })).toBe("Add dark mode toggle")
    expect(parseStructuredTitle({ title: "First line\nsecond line" })).toBe("First line")
    expect(parseStructuredTitle({ title: "t".repeat(80) })?.length).toBe(60)
  })

  test("returns null when the title is empty, missing, or wrong-typed", () => {
    expect(parseStructuredTitle({ title: "   " })).toBeNull()
    expect(parseStructuredTitle({ title: 5 })).toBeNull()
    expect(parseStructuredTitle({})).toBeNull()
    expect(parseStructuredTitle(null)).toBeNull()
    expect(parseStructuredTitle(undefined)).toBeNull()
    expect(parseStructuredTitle("Add dark mode")).toBeNull()
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
