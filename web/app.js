(() => {
  'use strict'

  const bundle = window.CARBON_DATA
  if (!bundle?.regions) throw new Error('未找到多地区 web/data/dataset.js')
  let data = bundle.regions[bundle.defaultRegion]

  const NS = 'http://www.w3.org/2000/svg'
  const state = {
    mode: 'month',
    topic: bundle.defaultTopic,
    category: null,
    frame: 0,
    selected: null,
    playing: false,
    completed: false,
    timer: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    dragStart: null,
    pointerStart: null,
    pointerCell: null,
    hoveredCell: null,
  }
  let monthlyPeriods = data.topics[state.topic].periods
  let monthlyValues = data.topics[state.topic].values
  let monthYears = [...new Set(monthlyPeriods.map((period) => period.slice(0, 4)))]
  let allMonthlyTotals = monthlyPeriods.map((_, index) => monthlyValues.reduce((sum, row) => sum + row[index], 0))

  const el = (id) => document.getElementById(id)
  const mapCanvas = el('mapCanvas')
  const mapSvg = el('mapSvg')
  const gridLayer = el('gridLayer')
  const tooltip = el('tooltip')
  const selectedOutline = el('selectedOutline')
  const slider = el('timeSlider')
  const playButton = el('playButton')
  const replayOverlay = el('replayOverlay')
  const methodDialog = el('methodDialog')
  const colorScaleCache = new Map()
  const canvasLayers = [document.createElement('canvas'), document.createElement('canvas')]
  let canvasPaths = []

  function periods() {
    return state.mode === 'month' ? monthlyPeriods : monthYears
  }

  function topic() {
    return data.topics[state.topic]
  }

  function topicLabel() {
    if (!topic().categories) return topic().label
    const category = topic().categories.find((item) => item.id === state.category)
    return `${topic().label} · ${category?.label || '全部类别'}`
  }

  function category() {
    return topic().categories?.find((item) => item.id === state.category) || null
  }

  function setting(key) {
    return category()?.[key] ?? topic()[key]
  }

  function sourceUnit() {
    return setting('unit')
  }

  function syncTopicData() {
    const current = topic()
    monthlyPeriods = current.periods
    if (current.categories && !state.category) state.category = current.defaultCategory
    monthlyValues = current.categories ? current.values[state.category] : current.values
    monthYears = [...new Set(monthlyPeriods.map((period) => period.slice(0, 4)))]
    allMonthlyTotals = monthlyPeriods.map((_, index) => monthlyValues.reduce((sum, row) => sum + row[index], 0))
  }

  function yearIndices(year) {
    return monthlyPeriods.map((period, index) => period.startsWith(year) ? index : -1).filter((index) => index >= 0)
  }

  function aggregateYear(row, year) {
    const indices = yearIndices(year)
    return aggregateIndices(row, indices, category()?.annual_aggregation || topic().temporal_kind)
  }

  function aggregateIndices(row, indices, aggregation) {
    const values = indices.map((index) => row[index]).filter(Number.isFinite)
    if (!values.length) return null
    if (aggregation === 'snapshot') return row[indices.at(-1)]
    if (aggregation === 'mean') return values.reduce((sum, value) => sum + value, 0) / values.length
    if (aggregation === 'max') return Math.max(...values)
    return values.reduce((sum, value) => sum + value, 0)
  }

  function frameValues(frame = state.frame) {
    if (state.mode === 'month') return monthlyValues.map((row) => row[frame])
    const year = monthYears[frame]
    return monthlyValues.map((row) => aggregateYear(row, year))
  }

  function frameMapValues(frame = state.frame) {
    return frameValues(frame)
  }

  function seriesForCell(cellIndex) {
    if (state.mode === 'month') return monthlyValues[cellIndex]
    return monthYears.map((year) => aggregateYear(monthlyValues[cellIndex], year))
  }

  function regionalSeries() {
    const monthly = topic().regionalValues?.[state.category] || allMonthlyTotals
    if (state.mode === 'month') return monthly
    return monthYears.map((year) => aggregateYear(monthly, year))
  }

  function formatNumber(value, digits = 2) {
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
  }

  function visualScale() {
    const cacheKey = `${data.meta.id}:${state.topic}:${state.category || ''}:${state.mode}`
    if (colorScaleCache.has(cacheKey)) return colorScaleCache.get(cacheKey)
    const frames = periods().map((_, index) => frameMapValues(index))
    const values = frames.flat()
    const scale = window.VisualEncoding.createScale(setting('color_scale'), values, frames)
    colorScaleCache.set(cacheKey, scale)
    return scale
  }

  function projectCoordinates() {
    const ringsFor = (geometry) => geometry.type === 'Polygon'
      ? geometry.coordinates
      : geometry.coordinates.flatMap((polygon) => polygon)
    const points = data.features.flatMap((feature) => ringsFor(feature.geometry).flatMap((ring) => ring))
    const xs = points.map((point) => point[0])
    const ys = points.map((point) => point[1])
    const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    const width = 1000
    const height = 620
    const padding = 28
    const scale = Math.min((width - padding * 2) / (bounds.maxX - bounds.minX), (height - padding * 2) / (bounds.maxY - bounds.minY))
    const offsetX = (width - (bounds.maxX - bounds.minX) * scale) / 2
    const offsetY = (height - (bounds.maxY - bounds.minY) * scale) / 2
    const point = ([x, y]) => [offsetX + (x - bounds.minX) * scale, height - offsetY - (y - bounds.minY) * scale]
    const path = (geometry) => ringsFor(geometry).map((ring) => `M${ring.map((item) => point(item).join(',')).join('L')}Z`).join('')
    mapSvg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    return { path }
  }

  function buildMap() {
    gridLayer.replaceChildren()
    selectedOutline.removeAttribute('d')
    const projection = projectCoordinates()
    const fragment = document.createDocumentFragment()
    canvasPaths = []
    data.features.forEach((feature, index) => {
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', projection.path(feature.geometry))
      path.dataset.index = index
      path.setAttribute('tabindex', '0')
      path.setAttribute('aria-label', `网格 ${feature.id}`)
      path.addEventListener('mouseenter', showTooltip)
      path.addEventListener('mousemove', moveTooltip)
      path.addEventListener('mouseleave', () => {
        state.hoveredCell = null
        tooltip.hidden = true
      })
      path.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') selectCell(index) })
      canvasPaths.push(typeof Path2D === 'function' ? new Path2D(path.getAttribute('d')) : null)
      fragment.appendChild(path)
    })
    gridLayer.appendChild(fragment)
  }

  function loadRegion(regionId, autoplay = true) {
    pause()
    data = bundle.regions[regionId]
    syncTopicData()
    state.frame = 0
    state.zoom = 1
    state.panX = 0
    state.panY = 0
    state.hoveredCell = null
    tooltip.hidden = true
    clearSelection()
    buildMap()
    applyTransform()
    updateRegionLabels()
    render()
    if (autoplay) play()
  }

  function updateRegionLabels() {
    el('sourceName').textContent = `${data.meta.region} ${topic().source_label}`
    el('pageTitle').textContent = `${data.meta.regionZh} ${topicLabel()} 动态图谱`
    el('cellCount').textContent = data.meta.cellCount.toLocaleString('zh-CN')
    el('mapTitle').textContent = topic().map_title
    el('legendLabel').textContent = `${setting('legend_label')}（${category()?.legend_unit || sourceUnit()}）`
    const scale = setting('color_scale')
    el('legendBar').className = ''
    el('map').dataset.theme = scale.map_theme || ''
    el('cellUnit').textContent = sourceUnit()
    el('footerSource').textContent = topic().footer_source
    el('footerUnit').textContent = topic().footer_unit
    el('categoryLabel').textContent = topic().overview ? '观测指标' : '细分类别'
    el('currentMetricLabel').textContent = topic().regionalValues ? '当前区域值' : '当前时段总量'
    el('maxMetricLabel').textContent = topic().regionalValues ? '当前最高网格' : '当前最高网格'
    if (state.selected === null) {
      el('chartTitle').textContent = topic().regionalValues ? '区域统计趋势' : '区域总量趋势'
      el('chartSubtitle').textContent = topic().regionalValues ? (topic().trend_subtitle || '区域统计序列') : '完整观测时段'
    }
    renderFactorOverview()
    renderMethodology()
  }

  function annualRuleLabel() {
    const aggregation = category()?.annual_aggregation || topic().temporal_kind
    return { mean: '12 个月均值', sum: '12 个月累计值', max: '全年最大值', snapshot: '每年最后一期快照', flow: '12 个月累计值' }[aggregation] || aggregation
  }

  function spatialRuleLabel() {
    const aggregation = category()?.spatial_aggregation
    return { mean_unique_reference: '去重 API 参考点空间均值', max_unique_reference: '去重 API 参考点空间最大值', weighted_mean_pixels: '按有效像元数加权均值' }[aggregation] || topic().methodology?.spatial_rule || '--'
  }

  function renderMethodology() {
    const method = topic().methodology
    if (!method) return
    el('methodFactor').textContent = `${data.meta.regionZh} · ${topicLabel()}`
    el('methodSummary').textContent = method.summary
    el('methodFields').replaceChildren(...method.fields.map((field) => {
      const row = document.createElement('tr')
      row.innerHTML = `<td>${field.name}</td><td>${field.meaning}</td>`
      return row
    }))
    const currentItems = [
      ['指标', category()?.label || topic().label],
      ['单位', sourceUnit()],
      ['月度区域口径', spatialRuleLabel()],
    ]
    const quality = currentQuality()
    if (quality?.source) currentItems.push(['数据来源', quality.source])
    el('methodCurrent').replaceChildren(...currentItems.map(([label, value]) => {
      const item = document.createElement('div')
      item.innerHTML = `<span>${label}</span><strong>${value}</strong>`
      return item
    }))
    el('methodSpatial').textContent = method.spatial_rule
    el('methodAnnual').textContent = topic().overview
      ? `当前指标“${category().label}”采用：${annualRuleLabel()}。${method.annual_rule}`
      : method.annual_rule
  }

  function metricRegionalMonthly(metricId) {
    return topic().regionalValues?.[metricId] || null
  }

  function metricRegionalSeries(metricId) {
    const monthly = metricRegionalMonthly(metricId)
    if (!monthly) return null
    const metric = topic().categories.find((item) => item.id === metricId)
    if (state.mode === 'month') return monthly
    return monthYears.map((year) => aggregateIndices(monthly, yearIndices(year), metric.annual_aggregation))
  }

  function renderFactorOverview() {
    const overview = el('factorOverview')
    overview.hidden = !topic().overview
    if (!topic().overview) {
      overview.replaceChildren()
      return
    }
    overview.replaceChildren(...topic().categories.map((metric) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.classList.toggle('active', metric.id === state.category)
      const series = metricRegionalSeries(metric.id)
      const value = series[state.frame]
      button.innerHTML = `<span>${metric.short_label}</span><strong>${formatNumber(value * metric.regional_factor, metric.regional_precision)} ${metric.regional_unit}</strong>`
      button.addEventListener('click', () => selectCategory(metric.id))
      return button
    }))
  }

  function showTooltip(event) {
    const index = Number(event.currentTarget.dataset.index)
    state.hoveredCell = index
    tooltip.hidden = false
    updateTooltip()
    moveTooltip(event)
  }

  function updateTooltip() {
    if (state.hoveredCell === null || tooltip.hidden) return
    const feature = data.features[state.hoveredCell]
    const value = frameValues()[state.hoveredCell]
    const display = Number.isFinite(value) ? `${formatNumber(value, setting('value_precision'))} ${sourceUnit()}` : '无有效观测'
    tooltip.innerHTML = `<strong>${feature.id}</strong>${periods()[state.frame]}<br>${display}`
  }

  function moveTooltip(event) {
    const rect = el('map').getBoundingClientRect()
    tooltip.style.left = `${Math.min(rect.width - 155, event.clientX - rect.left + 13)}px`
    tooltip.style.top = `${Math.max(8, event.clientY - rect.top - 12)}px`
  }

  function selectCell(index) {
    pause()
    state.selected = index
    const feature = data.features[index]
    const path = gridLayer.children[index]
    selectedOutline.setAttribute('d', path.getAttribute('d'))
    el('emptyDetail').hidden = true
    el('detailContent').hidden = false
    el('cellBadge').textContent = feature.id
    el('clearSelection').hidden = false
    el('chartTitle').textContent = '网格历史趋势'
    el('chartSubtitle').textContent = `${feature.id} · ${topicLabel()}与区域占比`
    el('shareTrend').hidden = !topic().show_share
    updateDetails()
    drawTrend(seriesForCell(index))
    if (topic().show_share) drawShareTrend(index)
  }

  function clearSelection() {
    state.selected = null
    selectedOutline.removeAttribute('d')
    el('cellBadge').textContent = '未选择'
    el('clearSelection').hidden = true
    el('emptyDetail').hidden = false
    el('detailContent').hidden = true
    el('shareTrend').hidden = true
    el('chartTitle').textContent = topic().regionalValues ? '区域统计趋势' : '区域总量趋势'
    el('chartSubtitle').textContent = topic().regionalValues ? (topic().trend_subtitle || '区域统计序列') : '完整观测时段'
    drawTrend(regionalSeries())
  }

  function updateDetails() {
    if (state.selected === null) return
    const feature = data.features[state.selected]
    const values = frameValues()
    const value = values[state.selected]
    const sorted = values.filter(Number.isFinite).sort((a, b) => b - a)
    const firstRank = sorted.findIndex((item) => item === value) + 1
    const tiedCount = sorted.filter((item) => item === value).length
    el('detailPeriod').textContent = periods()[state.frame]
    el('cellValue').textContent = Number.isFinite(value) ? formatNumber(value, setting('value_precision')) : '--'
    el('cellLon').textContent = Number(feature.lon).toFixed(5) + '°E'
    el('cellLat').textContent = Number(feature.lat).toFixed(5) + '°N'
    el('cellRank').textContent = Number.isFinite(value) ? `第 ${firstRank} / ${sorted.length}${tiedCount > 1 ? `（并列 ${tiedCount}）` : ''}` : '无有效观测'
    const reference = topic().references?.[state.selected]
    el('referenceLonItem').hidden = !reference
    el('referenceLatItem').hidden = !reference
    if (reference) {
      el('referenceLat').textContent = Number(reference[0]).toFixed(5) + '°'
      el('referenceLon').textContent = Number(reference[1]).toFixed(5) + '°'
    }
    const quality = topic().quality
    const metricQuality = topic().metricQuality?.[state.category]
    el('validPixelItem').hidden = !quality && !metricQuality
    el('qualityItem').hidden = !quality && !metricQuality
    if (quality) {
      const periodIndex = state.mode === 'month' ? state.frame : yearIndices(monthYears[state.frame]).at(-1)
      const valid = topic().quality.ntl_valid_pixel_count[state.selected][periodIndex]
      const missing = topic().quality.ntl_is_missing[state.selected][periodIndex]
      const imputed = topic().quality.ntl_is_imputed[state.selected][periodIndex]
      el('validPixelCount').textContent = `${valid} 个 500 m 像元`
      el('cellQuality').textContent = missing ? '缺失' : imputed ? '填补数据' : '原始观测'
    } else if (metricQuality) {
      const indices = state.mode === 'month' ? [state.frame] : yearIndices(monthYears[state.frame])
      const valid = indices.reduce((sum, index) => sum + metricQuality.validPixelCount[state.selected][index], 0)
      el('validPixelCount').textContent = `${valid} 个 250 m 像元${state.mode === 'year' ? '（年度合计）' : ''}`
      el('cellQuality').textContent = Number.isFinite(value) ? '有效观测' : '无有效像元'
    }
    const nightlights = Boolean(topic().quality?.ntl_valid_pixel_count)
    for (const id of ['ntlMeanItem', 'ntlMaxItem', 'ntlSumItem', 'ntlLogItem']) el(id).hidden = !nightlights
    if (nightlights) {
      const metricValue = (metricId) => {
        const row = topic().values[metricId][state.selected]
        return state.mode === 'month' ? row[state.frame] : aggregateIndices(row, yearIndices(monthYears[state.frame]), topic().categories.find((item) => item.id === metricId)?.annual_aggregation || 'mean')
      }
      const mean = metricValue('ntl_radiance_mean')
      el('ntlMean').textContent = formatNumber(mean, 2)
      el('ntlMax').textContent = formatNumber(metricValue('ntl_radiance_max'), 2)
      el('ntlSum').textContent = formatNumber(metricValue('ntl_radiance_sum'), 2)
      el('ntlLog').textContent = formatNumber(Math.log1p(Math.max(0, mean)), 3)
    }
    const hasPeriodDetails = nightlights || Boolean(topic().periodQualityByMetric)
    el('dataSourceItem').hidden = !hasPeriodDetails
    el('dateRangeItem').hidden = !hasPeriodDetails
    if (hasPeriodDetails) {
      const index = state.mode === 'month' ? state.frame : yearIndices(monthYears[state.frame]).at(-1)
      const periodQuality = topic().periodQuality?.[index] || topic().periodQualityByMetric[state.category][index]
      el('dataSourceValue').textContent = periodQuality.source
      el('dateRangeValue').textContent = state.mode === 'month' ? `${periodQuality.startDate} 至 ${periodQuality.endDate}` : `${monthYears[state.frame]} 年度`
    }
  }

  function currentQuality() {
    const periodQuality = topic().periodQuality || topic().periodQualityByMetric?.[state.category]
    if (!periodQuality) return null
    if (state.mode === 'month') return periodQuality[state.frame]
    const indices = yearIndices(monthYears[state.frame])
    const entries = indices.map((index) => periodQuality[index])
    return {
      imputedCount: Math.max(...entries.map((item) => item.imputedCount)),
      missingCount: Math.max(...entries.map((item) => item.missingCount)),
      imputedMonths: entries.filter((item) => item.imputedCount > 0).length,
    }
  }

  function updateQualityBadge() {
    const quality = currentQuality()
    const badge = el('qualityBadge')
    badge.hidden = !quality
    el('map').classList.remove('imputed-frame')
    if (!quality) return
    badge.className = 'quality-badge'
    if (quality.missingCount > 0) {
      badge.textContent = `部分缺失 · ${quality.missingCount} 网格`
      badge.classList.add('missing')
    } else if (quality.imputedCount > 0) {
      badge.textContent = state.mode === 'month' ? `整月填补 · ${quality.imputedCount} 网格` : `含 ${quality.imputedMonths} 个填补月份`
      badge.classList.add('imputed')
      el('map').classList.add('imputed-frame')
    } else {
      badge.textContent = '原始观测'
    }
  }

  function prepareCanvas() {
    const rect = mapSvg.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(rect.width * dpr))
    const height = Math.max(1, Math.round(rect.height * dpr))
    if (mapCanvas.width !== width || mapCanvas.height !== height) {
      mapCanvas.width = width
      mapCanvas.height = height
    }
    for (const canvas of canvasLayers) {
      const layerWidth = Math.max(1, Math.round(rect.width))
      const layerHeight = Math.max(1, Math.round(rect.height))
      if (canvas.width !== layerWidth || canvas.height !== layerHeight) {
        canvas.width = layerWidth
        canvas.height = layerHeight
      }
    }
    const fit = Math.min(rect.width / 1000, rect.height / 620)
    return {
      dpr,
      width,
      height,
      fit,
      offsetX: (rect.width - 1000 * fit) / 2,
      offsetY: (rect.height - 620 * fit) / 2,
    }
  }

  function setCanvasTransform(context, layout) {
    const scale = layout.dpr * layout.fit
    context.setTransform(
      scale * state.zoom, 0, 0, scale * state.zoom,
      layout.dpr * (layout.offsetX + layout.fit * state.panX),
      layout.dpr * (layout.offsetY + layout.fit * state.panY),
    )
  }

  function drawNightlights(cells, scale, glow) {
    if (!mapCanvas.getContext || canvasPaths.some((path) => !path)) return false
    const layout = prepareCanvas()
    const broad = canvasLayers[0].getContext('2d')
    const soft = canvasLayers[1].getContext('2d')
    const output = mapCanvas.getContext('2d')
    for (const context of [broad, soft, output]) {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, layout.width, layout.height)
    }
    setCanvasTransform(broad, { ...layout, dpr: 1 })
    setCanvasTransform(soft, { ...layout, dpr: 1 })
    cells.forEach(({ value, fill, missing }, index) => {
      if (missing) return
      const brightness = scale.normalize(value)
      soft.fillStyle = fill
      soft.globalAlpha = Math.pow(brightness, glow.response_power) * glow.max_opacity * .72
      soft.fill(canvasPaths[index])
      broad.fillStyle = fill
      broad.globalAlpha = Math.pow(brightness, glow.response_power * glow.broad_power_multiplier) * glow.max_opacity * .42
      broad.fill(canvasPaths[index])
    })
    output.setTransform(1, 0, 0, 1, 0, 0)
    output.filter = `blur(${Math.max(2, layout.dpr * 5)}px)`
    output.drawImage(canvasLayers[0], 0, 0, layout.width, layout.height)
    output.filter = `blur(${Math.max(1, layout.dpr * 2)}px)`
    output.drawImage(canvasLayers[1], 0, 0, layout.width, layout.height)
    output.filter = 'none'
    setCanvasTransform(output, layout)
    output.globalAlpha = 1
    cells.forEach(({ fill, missing }, index) => {
      if (missing) return
      output.fillStyle = fill
      output.fill(canvasPaths[index])
    })
    output.setTransform(1, 0, 0, 1, 0, 0)
    output.globalAlpha = 1
    return true
  }

  function updateMap() {
    const values = frameMapValues()
    const scale = visualScale()
    const scaleConfig = setting('color_scale')
    const glow = scaleConfig.glow
    const quality = topic().quality
    const qualityIndex = quality ? (state.mode === 'month' ? state.frame : yearIndices(monthYears[state.frame]).at(-1)) : null
    const cells = values.map((value, index) => {
      const missing = !Number.isFinite(value) || (quality ? quality.ntl_is_missing[index][qualityIndex] === 1 : false)
      return { value, missing, fill: missing ? '' : scale.color(value) }
    })
    const canvasRenderer = scaleConfig.renderer === 'canvas-nightlights' && glow
    const canvasRendered = canvasRenderer && drawNightlights(cells, scale, glow)
    el('map').classList.toggle('canvas-nightlights', Boolean(canvasRendered))
    Array.from(gridLayer.children).forEach((path, index) => {
      const { missing, fill } = cells[index]
      if (path.classList.contains('missing-data') !== missing) path.classList.toggle('missing-data', missing)
      if (!canvasRendered) path.style.fill = fill
    })
    const digits = setting('value_precision')
    const ticks = scale.ticks()
    const legendKey = `${data.meta.id}:${state.topic}:${state.category || ''}:${state.mode}:${scale.min}:${scale.max}:${scale.center ?? ''}`
    if (el('legendValues').dataset.key !== legendKey) {
      el('legendValues').dataset.key = legendKey
      el('legendBar').style.background = scale.gradient()
      el('legendValues').replaceChildren(...ticks.map((value) => {
        const tick = document.createElement('span')
        tick.textContent = formatNumber(value, digits)
        return tick
      }))
    }
    el('mapSubtitle').textContent = `${periods()[state.frame]} · ${topicLabel()} · ${data.meta.cellCount} 个 1 km 网格`
    updateQualityBadge()
    updateTooltip()
  }

  function updateMetrics() {
    const values = frameValues()
    const finiteValues = values.filter(Number.isFinite)
    const total = finiteValues.reduce((sum, value) => sum + value, 0)
    const regionSeries = regionalSeries()
    const currentRegional = topic().regionalValues ? regionSeries[state.frame] : total
    const previous = state.frame > 0 ? regionSeries[state.frame - 1] : null
    const max = finiteValues.length ? Math.max(...finiteValues) : null
    const maxIndex = values.indexOf(max)
    const displayTotal = currentRegional * setting('regional_factor')
    const displayUnit = setting('regional_unit')
    const changeDivisor = 1 / setting('regional_factor')
    el('totalValue').textContent = formatNumber(displayTotal, setting('regional_precision'))
    el('totalUnit').textContent = displayUnit
    el('maxCell').textContent = maxIndex >= 0 ? data.features[maxIndex].id : '--'
    el('maxValue').textContent = Number.isFinite(max) ? `${formatNumber(max, setting('value_precision'))} ${sourceUnit()}` : '--'
    if (previous === null) {
      el('changeValue').textContent = '--'
      el('changeRate').textContent = '首个观测时段'
    } else {
      const change = currentRegional - previous
      const rate = change / previous * 100
      el('changeValue').textContent = `${change >= 0 ? '+' : ''}${formatNumber(change / changeDivisor, setting('change_precision'))}`
      el('changeValue').className = change >= 0 ? 'positive' : 'negative'
      el('changeRate').textContent = category()?.show_rate === false
        ? `· ${displayUnit}`
        : `${rate >= 0 ? '↑' : '↓'} ${Math.abs(rate).toFixed(1)}% · ${displayUnit}`
    }
    renderFactorOverview()
  }

  function drawTrend(values) {
    const svg = el('trendChart')
    const width = 520
    const height = 270
    const margin = { top: 19, right: 13, bottom: 35, left: 49 }
    const innerWidth = width - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom
    const finiteValues = values.map((value) => Number.isFinite(value) ? value : null)
    const observed = finiteValues.filter(Number.isFinite)
    const rawMax = observed.length ? Math.max(...observed) : 0
    const rawMin = observed.length ? Math.min(...observed) : 0
    const padding = Math.max((rawMax - rawMin) * .08, Math.max(Math.abs(rawMax), Math.abs(rawMin)) * .02, 1e-6)
    const max = rawMax + padding
    const min = rawMin - padding
    const x = (index) => margin.left + index / Math.max(1, values.length - 1) * innerWidth
    const y = (value) => margin.top + (max - value) / Math.max(1e-9, max - min) * innerHeight
    const pathFor = (series) => {
      let open = false
      return series.map((value, index) => {
        if (value === null) {
          open = false
          return ''
        }
        const command = open ? 'L' : 'M'
        open = true
        return `${command}${x(index)},${y(value)}`
      }).join('')
    }
    const line = pathFor(finiteValues)
    const visibleValues = finiteValues.slice(0, state.frame + 1)
    const visibleLine = pathFor(visibleValues)
    const visibleArea = visibleValues.every(Number.isFinite)
      ? `${visibleLine}L${x(state.frame)},${height - margin.bottom}L${x(0)},${height - margin.bottom}Z`
      : ''
    const isCell = state.selected !== null
    const unit = isCell ? sourceUnit() : setting('regional_unit')
    const divisor = isCell ? 1 : 1 / setting('regional_factor')
    const grids = Array.from({ length: 5 }, (_, index) => {
      const yy = margin.top + index / 4 * innerHeight
      const value = max - index / 4 * (max - min)
      const digits = isCell ? setting('value_precision') : setting('regional_precision')
      return `<line class="chart-grid" x1="${margin.left}" y1="${yy}" x2="${width - margin.right}" y2="${yy}"/><text class="chart-axis" x="${margin.left - 8}" y="${yy + 3}" text-anchor="end">${formatNumber(value / divisor, digits)}</text>`
    }).join('')
    const labels = periods().map((period, index) => ({ period, index })).filter((_, index, list) => index === 0 || index === list.length - 1 || index % Math.max(1, Math.floor(list.length / 4)) === 0).map(({ period, index }) => `<text class="chart-axis" x="${x(index)}" y="${height - 10}" text-anchor="middle">${period}</text>`).join('')
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    const currentValue = values[state.frame]
    const currentLabel = Number.isFinite(currentValue) ? `${formatNumber(currentValue / divisor, isCell ? setting('value_precision') : setting('regional_precision'))} ${unit}` : '无有效观测'
    const imputedClass = currentQuality()?.imputedCount > 0 ? ' imputed' : ''
    const point = Number.isFinite(currentValue) ? `<circle class="chart-point${imputedClass}" cx="${x(state.frame)}" cy="${y(currentValue)}" r="5"/>` : ''
    svg.innerHTML = `<defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#68a894" stop-opacity=".36"/><stop offset="1" stop-color="#68a894" stop-opacity=".02"/></linearGradient></defs>${grids}<path class="chart-future" d="${line}"/><path class="chart-area" d="${visibleArea}"/><path class="chart-line" d="${visibleLine}"/>${labels}<line class="chart-current-line" x1="${x(state.frame)}" y1="${margin.top}" x2="${x(state.frame)}" y2="${height - margin.bottom}"/>${point}<text class="chart-axis" x="10" y="15">${unit}</text><text class="chart-current-value" x="${width - margin.right}" y="15" text-anchor="end">${periods()[state.frame]} · ${currentLabel}</text>`
  }

  function drawShareTrend(cellIndex) {
    const svg = el('shareChart')
    const cellSeries = seriesForCell(cellIndex)
    const totals = regionalSeries()
    const shares = cellSeries.map((value, index) => value / totals[index] * 100)
    const width = 500
    const height = 72
    const margin = { top: 8, right: 5, bottom: 8, left: 5 }
    const innerWidth = width - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom
    const rawMin = Math.min(...shares)
    const rawMax = Math.max(...shares)
    const padding = Math.max((rawMax - rawMin) * .2, rawMax * .0005, .000001)
    const min = rawMin - padding
    const max = rawMax + padding
    const x = (index) => margin.left + index / Math.max(1, shares.length - 1) * innerWidth
    const y = (value) => margin.top + (max - value) / Math.max(1e-12, max - min) * innerHeight
    const fullLine = shares.map((value, index) => `${index ? 'L' : 'M'}${x(index)},${y(value)}`).join('')
    const visibleLine = shares.slice(0, state.frame + 1).map((value, index) => `${index ? 'L' : 'M'}${x(index)},${y(value)}`).join('')
    const current = shares[state.frame]
    const mean = shares.reduce((sum, value) => sum + value, 0) / shares.length
    el('shareValue').textContent = `${current.toFixed(4)}%`
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.innerHTML = `<line class="share-baseline" x1="${margin.left}" y1="${y(mean)}" x2="${width - margin.right}" y2="${y(mean)}"/><path class="share-future" d="${fullLine}"/><path class="share-line" d="${visibleLine}"/><circle class="share-point" cx="${x(state.frame)}" cy="${y(current)}" r="4"/>`
  }

  function render() {
    slider.max = periods().length - 1
    slider.value = state.frame
    el('currentPeriod').textContent = periods()[state.frame]
    el('startPeriod').textContent = periods()[0]
    el('endPeriod').textContent = periods().at(-1)
    updateMap()
    updateMetrics()
    updateDetails()
    drawTrend(state.selected === null ? regionalSeries() : seriesForCell(state.selected).map((value) => value * (state.selected === null ? 1 : 1)))
    if (state.selected !== null && topic().show_share) drawShareTrend(state.selected)
  }

  function play() {
    if (state.playing) return
    if (state.completed || state.frame >= periods().length - 1) state.frame = 0
    setCompleted(false)
    render()
    state.playing = true
    playButton.classList.add('playing')
    playButton.setAttribute('aria-label', '暂停')
    state.timer = window.setInterval(() => {
      if (state.frame >= periods().length - 1) {
        finishPlayback()
        return
      }
      state.frame += 1
      render()
      if (state.frame >= periods().length - 1) finishPlayback()
    }, 850)
  }

  function setCompleted(completed) {
    state.completed = completed
    el('map').classList.toggle('playback-complete', completed)
    replayOverlay.hidden = !completed
  }

  function finishPlayback() {
    pause()
    setCompleted(true)
  }

  function pause() {
    state.playing = false
    window.clearInterval(state.timer)
    playButton.classList.remove('playing')
    playButton.setAttribute('aria-label', '播放')
  }

  function applyTransform() {
    gridLayer.setAttribute('transform', `translate(${state.panX} ${state.panY}) scale(${state.zoom})`)
    selectedOutline.setAttribute('transform', `translate(${state.panX} ${state.panY}) scale(${state.zoom})`)
    if (setting('color_scale').renderer === 'canvas-nightlights') updateMap()
  }

  document.querySelectorAll('.mode-switch button').forEach((button) => button.addEventListener('click', () => {
    pause()
    setCompleted(false)
    state.mode = button.dataset.mode
    state.frame = 0
    document.querySelectorAll('.mode-switch button').forEach((item) => item.classList.toggle('active', item === button))
    render()
  }))
  playButton.addEventListener('click', () => state.playing ? pause() : play())
  replayOverlay.addEventListener('click', play)
  slider.addEventListener('input', () => { pause(); setCompleted(false); state.frame = Number(slider.value); render() })
  el('zoomIn').addEventListener('click', () => { state.zoom = Math.min(4, state.zoom * 1.25); applyTransform() })
  el('zoomOut').addEventListener('click', () => { state.zoom = Math.max(.8, state.zoom / 1.25); applyTransform() })
  el('resetMap').addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; applyTransform() })
  el('clearSelection').addEventListener('click', clearSelection)
  el('methodButton').addEventListener('click', () => {
    renderMethodology()
    methodDialog.showModal()
  })
  el('closeMethod').addEventListener('click', () => methodDialog.close())
  methodDialog.addEventListener('click', (event) => {
    if (event.target === methodDialog) methodDialog.close()
  })
  mapSvg.addEventListener('pointerdown', (event) => {
    const cell = event.target.closest?.('#gridLayer path')
    state.dragging = true
    state.dragStart = [event.clientX - state.panX, event.clientY - state.panY]
    state.pointerStart = [event.clientX, event.clientY]
    state.pointerCell = cell ? Number(cell.dataset.index) : null
    mapSvg.setPointerCapture(event.pointerId)
  })
  mapSvg.addEventListener('pointermove', (event) => {
    if (!state.dragging) return
    const distance = Math.hypot(event.clientX - state.pointerStart[0], event.clientY - state.pointerStart[1])
    if (distance < 4) return
    mapSvg.classList.add('dragging')
    state.panX = event.clientX - state.dragStart[0]
    state.panY = event.clientY - state.dragStart[1]
    applyTransform()
  })
  mapSvg.addEventListener('pointerup', (event) => {
    if (!state.dragging) return
    const distance = Math.hypot(event.clientX - state.pointerStart[0], event.clientY - state.pointerStart[1])
    const clickedCell = state.pointerCell
    state.dragging = false
    state.pointerCell = null
    mapSvg.classList.remove('dragging')
    if (distance < 4 && clickedCell !== null) selectCell(clickedCell)
  })
  mapSvg.addEventListener('pointercancel', () => {
    state.dragging = false
    state.pointerCell = null
    mapSvg.classList.remove('dragging')
  })
  window.addEventListener('resize', () => {
    if (setting('color_scale').renderer === 'canvas-nightlights') updateMap()
    drawTrend(state.selected === null ? regionalSeries() : seriesForCell(state.selected))
  })
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.selected !== null) clearSelection() })

  const regionSelect = el('regionSelect')
  const topicSelect = el('topicSelect')
  const categorySelect = el('categorySelect')
  function populateTopics() {
    topicSelect.replaceChildren()
    bundle.topicOrder.forEach((topicId) => {
      const item = data.topics[topicId]
      if (!item) return
      const option = document.createElement('option')
      option.value = topicId
      option.textContent = item.label
      topicSelect.appendChild(option)
    })
    if (!data.topics[state.topic]) state.topic = Object.keys(data.topics)[0]
    topicSelect.value = state.topic
  }
  populateTopics()
  Object.values(bundle.regions).forEach((region) => {
    const option = document.createElement('option')
    option.value = region.meta.id
    option.textContent = region.meta.regionZh
    regionSelect.appendChild(option)
  })
  regionSelect.value = bundle.defaultRegion
  regionSelect.addEventListener('change', () => {
    const url = new URL(window.location.href)
    url.searchParams.set('region', regionSelect.value)
    try {
      window.history.replaceState({}, '', url)
    } catch (_) {
      // Some browsers restrict history updates for local file pages.
    }
    data = bundle.regions[regionSelect.value]
    populateTopics()
    loadRegion(regionSelect.value)
  })
  function populateCategories() {
    categorySelect.replaceChildren()
    const categories = topic().categories || []
    categories.forEach((category) => {
      const option = document.createElement('option')
      option.value = category.id
      option.textContent = category.label
      categorySelect.appendChild(option)
    })
    if (categories.length) {
      if (!categories.some((item) => item.id === state.category)) state.category = topic().defaultCategory
      categorySelect.value = state.category
    }
  }

  function changeTopic() {
    pause()
    state.topic = topicSelect.value
    state.category = topic().defaultCategory || null
    const url = new URL(window.location.href)
    url.searchParams.set('topic', state.topic)
    if (!topic().categories) url.searchParams.delete('category')
    try { window.history.replaceState({}, '', url) } catch (_) {}
    state.frame = 0
    el('categoryControl').hidden = !topic().categories
    populateCategories()
    syncTopicData()
    clearSelection()
    updateRegionLabels()
    render()
    play()
  }

  topicSelect.addEventListener('change', changeTopic)
  function selectCategory(categoryId) {
    pause()
    state.category = categoryId
    categorySelect.value = categoryId
    const url = new URL(window.location.href)
    url.searchParams.set('topic', state.topic)
    url.searchParams.set('category', state.category)
    try { window.history.replaceState({}, '', url) } catch (_) {}
    state.frame = 0
    syncTopicData()
    clearSelection()
    updateRegionLabels()
    render()
    play()
  }
  categorySelect.addEventListener('change', () => selectCategory(categorySelect.value))
  const query = new URLSearchParams(window.location.search)
  const requestedRegion = query.get('region')
  const initialRegion = bundle.regions[requestedRegion] ? requestedRegion : bundle.defaultRegion
  regionSelect.value = initialRegion
  populateCategories()
  const requestedTopic = query.get('topic')
  if (requestedTopic && data.topics[requestedTopic]) {
    state.topic = requestedTopic
    topicSelect.value = requestedTopic
    el('categoryControl').hidden = !topic().categories
    state.category = topic().defaultCategory || null
    populateCategories()
    const requestedCategory = query.get('category')
    if (topic().categories?.some((item) => item.id === requestedCategory)) {
      state.category = requestedCategory
      categorySelect.value = requestedCategory
    }
    syncTopicData()
  }
  const requestedFrame = Number(query.get('frame'))
  if (Number.isInteger(requestedFrame) && requestedFrame >= 0 && requestedFrame < monthlyPeriods.length) {
    state.frame = requestedFrame
  }
  if (initialRegion === bundle.defaultRegion) {
    updateRegionLabels()
    buildMap()
    render()
    play()
  } else {
    loadRegion(initialRegion)
  }
  if (query.get('method') === '1') {
    renderMethodology()
    methodDialog.showModal()
  }
})()
