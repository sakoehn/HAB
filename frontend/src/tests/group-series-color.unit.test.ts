/**
 * group-series-color.unit.test.ts
 * =================================
 * groupSeriesColor (constants.ts) is the one place a summed group's line
 * color comes from -- MultiEgcChart draws with it and Compare's chips show
 * it -- so the two always agree. Group colors must also never equal a
 * single-series source shade, or a group line could look like one of its
 * own members.
 */

import { describe, it, expect } from 'vitest'

import { groupSeriesColor, SOURCE_SHADES } from '../constants'

describe('groupSeriesColor', () => {
  it('the first group uses the theme group color', () => {
    expect(groupSeriesColor(0)).toBe('var(--chart-group)')
  })

  it('later groups get distinct colors that no single-series shade uses', () => {
    const shades = new Set(Object.values(SOURCE_SHADES).flat().map(c => c.toUpperCase()))
    const extra = [1, 2, 3, 4, 5, 6].map(groupSeriesColor)
    expect(new Set(extra).size).toBe(extra.length)
    for (const c of extra) expect(shades.has(c.toUpperCase())).toBe(false)
  })
})
