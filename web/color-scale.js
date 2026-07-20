(() => {
  'use strict'

  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))

  function percentile(values, quantile) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    const index = Math.floor((sorted.length - 1) * clamp(quantile))
    return sorted[index] ?? 0
  }

  function hexToRgb(hex) {
    const value = hex.replace('#', '')
    const full = value.length === 3 ? value.split('').map((item) => item + item).join('') : value
    return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16) / 255)
  }

  function rgbToOklab(rgb) {
    const linear = rgb.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    const l = .4122214708 * linear[0] + .5363325363 * linear[1] + .0514459929 * linear[2]
    const m = .2119034982 * linear[0] + .6806995451 * linear[1] + .1073969566 * linear[2]
    const s = .0883024619 * linear[0] + .2817188376 * linear[1] + .6299787005 * linear[2]
    const [ll, mm, ss] = [Math.cbrt(l), Math.cbrt(m), Math.cbrt(s)]
    return [
      .2104542553 * ll + .793617785 * mm - .0040720468 * ss,
      1.9779984951 * ll - 2.428592205 * mm + .4505937099 * ss,
      .0259040371 * ll + .7827717662 * mm - .808675766 * ss,
    ]
  }

  function oklabToRgb(lab) {
    const l = (lab[0] + .3963377774 * lab[1] + .2158037573 * lab[2]) ** 3
    const m = (lab[0] - .1055613458 * lab[1] - .0638541728 * lab[2]) ** 3
    const s = (lab[0] - .0894841775 * lab[1] - 1.291485548 * lab[2]) ** 3
    const linear = [
      4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
      -.0041960863 * l - .7034186147 * m + 1.707614701 * s,
    ]
    return linear.map((value) => {
      const encoded = value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055
      return Math.round(clamp(encoded) * 255)
    })
  }

  function createRamp(colors, size = 256, interpolation = 'oklab') {
    if (interpolation === 'rgb') {
      const rgbs = colors.map((color) => hexToRgb(color).map((value) => value * 255))
      return Array.from({ length: size }, (_, index) => {
        const position = index / Math.max(1, size - 1) * (rgbs.length - 1)
        const lower = Math.floor(position)
        const upper = Math.min(rgbs.length - 1, lower + 1)
        const ratio = position - lower
        const rgb = rgbs[lower].map((value, channel) => Math.round(value + (rgbs[upper][channel] - value) * ratio))
        return `rgb(${rgb.join(',')})`
      })
    }
    const labs = colors.map((color) => rgbToOklab(hexToRgb(color)))
    return Array.from({ length: size }, (_, index) => {
      const position = index / Math.max(1, size - 1) * (labs.length - 1)
      const lower = Math.floor(position)
      const upper = Math.min(labs.length - 1, lower + 1)
      const ratio = position - lower
      const lab = labs[lower].map((value, channel) => value + (labs[upper][channel] - value) * ratio)
      return `rgb(${oklabToRgb(lab).join(',')})`
    })
  }

  function transform(value, type) {
    if (type === 'log1p') return Math.log1p(Math.max(0, value))
    if (type === 'sqrt') return Math.sqrt(Math.max(0, value))
    return value
  }

  function inverse(value, type) {
    if (type === 'log1p') return Math.expm1(value)
    if (type === 'sqrt') return value ** 2
    return value
  }

  function createBaseScale(config, rawValues, overrides = {}) {
    const values = rawValues.filter(Number.isFinite)
    const domainValues = config.positive_domain ? values.filter((value) => value > 0) : values
    const rawMin = overrides.min ?? config.fixed_min ?? percentile(domainValues, config.clip_low ?? 0)
    const rawMax = Math.max(config.minimum_max ?? -Infinity, overrides.max ?? percentile(domainValues, config.clip_high ?? 1))
    const type = overrides.transform || config.transform || 'linear'
    const transformedMin = transform(rawMin, type)
    const transformedMax = transform(rawMax === rawMin ? rawMin + 1 : rawMax, type)
    const center = config.center === 'median' ? percentile(values, .5) : null
    const transformedCenter = center === null ? null : transform(center, type)
    const colors = overrides.endpoint_palette ? [config.palette[0], config.palette.at(-1)] : config.palette
    const ramp = createRamp(colors, 256, config.interpolation)

    function normalize(value) {
      const current = transform(value, type)
      if (transformedCenter !== null) {
        if (current <= transformedCenter) return .5 * clamp((current - transformedMin) / Math.max(1e-12, transformedCenter - transformedMin))
        return .5 + .5 * clamp((current - transformedCenter) / Math.max(1e-12, transformedMax - transformedCenter))
      }
      return clamp((current - transformedMin) / Math.max(1e-12, transformedMax - transformedMin))
    }

    function denormalize(position) {
      if (transformedCenter !== null) {
        const transformed = position <= .5
          ? transformedMin + position * 2 * (transformedCenter - transformedMin)
          : transformedCenter + (position - .5) * 2 * (transformedMax - transformedCenter)
        return inverse(transformed, type)
      }
      return inverse(transformedMin + position * (transformedMax - transformedMin), type)
    }

    return {
      min: rawMin,
      max: rawMax,
      center,
      normalize,
      color(value) {
        if (value === 0 && config.zero_color) return config.zero_color
        return ramp[Math.round(normalize(value) * (ramp.length - 1))]
      },
      ticks(count = 3) {
        if (config.integer_ticks_below > 0 && rawMax <= config.integer_ticks_below && rawMin >= 0) {
          return Array.from({ length: Math.floor(rawMax) + 1 }, (_, index) => index)
        }
        if (config.tick_values === 'transformed') {
          return Array.from({ length: count }, (_, index) => transformedMin + index / Math.max(1, count - 1) * (transformedMax - transformedMin))
        }
        return Array.from({ length: count }, (_, index) => denormalize(index / Math.max(1, count - 1)))
      },
      gradient(samples = 12) {
        return `linear-gradient(90deg, ${Array.from({ length: samples }, (_, index) => {
          const position = index / (samples - 1)
          return `${ramp[Math.round(position * (ramp.length - 1))]} ${Math.round(position * 100)}%`
        }).join(', ')})`
      },
    }
  }

  function adjacentStats(frames, scale) {
    if (!Array.isArray(frames) || frames.length < 2) return { delta: 0, unchangedRatio: 1 }
    const deltas = []
    let unchanged = 0
    let comparisons = 0
    for (let frame = 1; frame < frames.length; frame += 1) {
      const previous = frames[frame - 1]
      const current = frames[frame]
      for (let index = 0; index < current.length; index += 1) {
        const before = previous[index]
        const after = current[index]
        if (!Number.isFinite(before) || !Number.isFinite(after)) continue
        comparisons += 1
        if (before === after) unchanged += 1
        deltas.push(Math.abs(scale.normalize(after) - scale.normalize(before)))
      }
    }
    return {
      delta: percentile(deltas, .5),
      unchangedRatio: comparisons ? unchanged / comparisons : 1,
    }
  }

  function createScale(config, rawValues, frames = null) {
    const initial = createBaseScale(config, rawValues)
    const auto = config.auto_contrast
    if (!auto?.enabled || !frames) {
      initial.diagnostics = { enhanced: false, reason: 'disabled' }
      return initial
    }

    const initialStats = adjacentStats(frames, initial)
    const diagnostics = { enhanced: false, ...initialStats, clipEachSide: 0, reason: 'sufficient' }
    if (initialStats.unchangedRatio >= auto.static_ratio) {
      initial.diagnostics = { ...diagnostics, reason: 'static' }
      return initial
    }
    if (initialStats.delta >= auto.target_delta) {
      initial.diagnostics = diagnostics
      return initial
    }

    const values = rawValues.filter(Number.isFinite)
    const domainValues = config.positive_domain ? values.filter((value) => value > 0) : values
    const baseLow = config.clip_low ?? 0
    const baseHigh = config.clip_high ?? 1
    let selected = initial
    let selectedStats = initialStats
    let selectedClip = 0
    for (let clip = .005; clip <= auto.max_clip_each_side + 1e-9; clip += .005) {
      const low = Math.min(baseHigh, baseLow + clip)
      const high = Math.max(low, baseHigh - clip)
      const candidate = createBaseScale(config, rawValues, {
        min: percentile(domainValues, low),
        max: percentile(domainValues, high),
        endpoint_palette: auto.endpoint_palette,
        transform: auto.enhanced_transform,
      })
      const stats = adjacentStats(frames, candidate)
      if (stats.delta > selectedStats.delta) {
        selected = candidate
        selectedStats = stats
        selectedClip = clip
      }
      if (selectedStats.delta >= auto.target_delta) break
    }
    if (selected === initial) {
      initial.diagnostics = { ...diagnostics, reason: 'no-improvement' }
      return initial
    }
    selected.diagnostics = {
      enhanced: true,
      reason: selectedStats.delta >= auto.target_delta ? 'target-reached' : 'best-effort',
      delta: initialStats.delta,
      enhancedDelta: selectedStats.delta,
      unchangedRatio: initialStats.unchangedRatio,
      clipEachSide: selectedClip,
      originalMin: initial.min,
      originalMax: initial.max,
      enhancedMin: selected.min,
      enhancedMax: selected.max,
    }
    return selected
  }

  window.VisualEncoding = { createRamp, createScale }
})()
