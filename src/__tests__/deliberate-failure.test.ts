import { describe, expect, it } from 'vitest'

describe('deliberately failing test (CI validation)', () => {
  it('fails on purpose to verify the CI test step blocks merge', () => {
    expect(1 + 1).toBe(3)
  })
})
