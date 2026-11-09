const PALETTE = [
  '#2f4bff',
  '#0f766e',
  '#e07a5f',
  '#c48a05',
  '#7c3aed',
  '#0891b2',
  '#be123c',
  '#4d7c0f',
  '#6d28d9',
  '#b45309',
]

const AGG_LABELS = {
  count: 'Frecuencia',
  mean: 'Promedio',
  sum: 'Suma',
  median: 'Mediana',
}

const AGGREGATION_TYPES = new Set(['bar', 'hbar', 'stacked', 'line', 'area'])

export function isNumericVariable(variable) {
  return Boolean(variable && variable.type === 'numeric' && !variable.has_value_labels)
}

function isCategoricalVariable(variable) {
  return Boolean(variable && (variable.has_value_labels || variable.type === 'string'))
}

function safeLabel(value) {
  return value === null || value === undefined || value === '' ? 'Sin dato' : String(value)
}

function aggregate(values, aggregation) {
  const clean = values.filter((value) => typeof value === 'number' && !Number.isNaN(value))
  if (!clean.length) return null
  if (aggregation === 'sum') return clean.reduce((total, value) => total + value, 0)
  if (aggregation === 'median') {
    const sorted = [...clean].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle]
  }
  return clean.reduce((total, value) => total + value, 0) / clean.length
}

function rgba(hex, alpha) {
  const value = hex.replace('#', '')
  const normalized = value.length === 3 ? value.split('').map((char) => char + char).join('') : value
  const number = Number.parseInt(normalized, 16)
  const red = (number >> 16) & 255
  const green = (number >> 8) & 255
  const blue = number & 255
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function baseLayout(title, options = {}) {
  const showLegend = Boolean(options.showLegend)
  const horizontal = Boolean(options.horizontal)

  return {
    title: {
      text: title,
      x: 0.012,
      xanchor: 'left',
      y: 0.98,
      yanchor: 'top',
      font: { size: 17, color: '#17181c' },
    },
    margin: {
      l: horizontal ? 142 : 68,
      r: 30,
      t: showLegend ? 92 : 62,
      b: 84,
    },
    paper_bgcolor: '#fffefb',
    plot_bgcolor: '#fffefb',
    font: {
      family: '"Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif',
      size: 12,
      color: '#4b4740',
    },
    hoverlabel: {
      bgcolor: '#17181c',
      bordercolor: '#17181c',
      font: { color: '#fffefb', size: 12 },
    },
    xaxis: {
      automargin: true,
      gridcolor: '#ebe7df',
      zerolinecolor: '#d8d2c6',
      tickangle: horizontal ? 0 : -28,
      tickfont: { size: 11 },
    },
    yaxis: {
      automargin: true,
      gridcolor: '#ebe7df',
      zerolinecolor: '#d8d2c6',
      tickfont: { size: 11 },
    },
    showlegend: showLegend,
    autosize: true,
    legend: {
      orientation: 'h',
      x: 0,
      y: 1.13,
      xanchor: 'left',
      yanchor: 'top',
      font: { size: 11, color: '#4b4740' },
      bgcolor: 'rgba(0,0,0,0)',
    },
    bargap: 0.28,
    bargroupgap: 0.08,
    hovermode: 'closest',
  }
}

export const PLOTLY_CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
}

function buildSeries(rows, xVariable, yVariable, aggregation, groupVariable, options = {}) {
  const {
    sort = 'value',
    maxCategories = 40,
    maxGroups = 12,
    missing = 0,
  } = options
  const numericY = isNumericVariable(yVariable)
  const useAggregation = numericY && aggregation !== 'count'
  const groups = new Map()

  for (const row of rows) {
    const xLabel = safeLabel(row[xVariable.name])
    let entry = groups.get(xLabel)
    if (!entry) {
      entry = { label: xLabel, count: 0, values: [], groups: new Map() }
      groups.set(xLabel, entry)
    }
    entry.count += 1

    const rawY = numericY ? row[yVariable.name] : null
    const numericValue = numericY ? Number(rawY) : null
    const validValue =
      numericY &&
      rawY !== null &&
      rawY !== undefined &&
      rawY !== '' &&
      !Number.isNaN(numericValue)

    if (validValue) entry.values.push(numericValue)

    if (groupVariable) {
      const groupLabel = safeLabel(row[groupVariable.name])
      let groupEntry = entry.groups.get(groupLabel)
      if (!groupEntry) {
        groupEntry = { count: 0, values: [] }
        entry.groups.set(groupLabel, groupEntry)
      }
      groupEntry.count += 1
      if (validValue) groupEntry.values.push(numericValue)
    }
  }

  let entries = [...groups.values()]
  const valueOf = (entry) =>
    useAggregation ? aggregate(entry.values, aggregation) ?? -1 : entry.count

  if (sort === 'x' && xVariable.type === 'numeric') {
    entries.sort((a, b) => Number(a.label) - Number(b.label))
  } else if (sort === 'category') {
    const order = new Map(
      (xVariable.categories || []).map((category, index) => [safeLabel(category.value), index]),
    )
    entries.sort((a, b) => {
      const left = order.get(a.label)
      const right = order.get(b.label)
      if (left !== undefined && right !== undefined) return left - right
      if (left !== undefined) return -1
      if (right !== undefined) return 1
      return a.label.localeCompare(b.label, 'es')
    })
  } else {
    entries.sort((a, b) => valueOf(b) - valueOf(a))
  }

  if (entries.length > maxCategories) {
    const rest = entries.slice(maxCategories)
    const restEntry = {
      label: `Otros (${rest.length})`,
      count: rest.reduce((total, entry) => total + entry.count, 0),
      values: rest.flatMap((entry) => entry.values),
      groups: new Map(),
    }
    for (const entry of rest) {
      for (const [label, groupEntry] of entry.groups) {
        let target = restEntry.groups.get(label)
        if (!target) {
          target = { count: 0, values: [] }
          restEntry.groups.set(label, target)
        }
        target.count += groupEntry.count
        target.values.push(...groupEntry.values)
      }
    }
    entries = [...entries.slice(0, maxCategories), restEntry]
  }

  let groupLabels = []
  const groupBuckets = new Map()

  if (groupVariable) {
    const totals = new Map()
    for (const entry of entries) {
      for (const [label, groupEntry] of entry.groups) {
        totals.set(label, (totals.get(label) || 0) + groupEntry.count)
      }
    }
    const ordered = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label)
    const kept = ordered.slice(0, maxGroups)
    const rest = ordered.slice(maxGroups)
    groupLabels = [...kept]
    kept.forEach((label) => groupBuckets.set(label, label))
    if (rest.length) {
      const bucket = `Otros (${rest.length})`
      groupLabels.push(bucket)
      rest.forEach((label) => groupBuckets.set(label, bucket))
    }
  }

  const series = groupLabels.length
    ? groupLabels.map((bucket) => {
        const values = entries.map((entry) => {
          let count = 0
          const bucketValues = []
          for (const [label, groupEntry] of entry.groups) {
            if (groupBuckets.get(label) !== bucket) continue
            count += groupEntry.count
            bucketValues.push(...groupEntry.values)
          }
          if (!count) return missing
          return useAggregation ? aggregate(bucketValues, aggregation) ?? missing : count
        })
        return { name: bucket, values }
      })
    : [
        {
          name: null,
          values: entries.map((entry) =>
            useAggregation ? aggregate(entry.values, aggregation) ?? 0 : entry.count,
          ),
        },
      ]

  return {
    categories: entries.map((entry) => entry.label),
    series,
    useAggregation,
    metricLabel: useAggregation ? AGG_LABELS[aggregation] : 'Registros',
    grouped: groupLabels.length > 0,
    groupLabels,
  }
}

function barSpec(rows, xVariable, yVariable, aggregation, groupVariable, orientation = 'v', mode = 'group') {
  if (!xVariable) {
    return { empty: 'Selecciona una variable para el eje X.' }
  }

  const built = buildSeries(rows, xVariable, yVariable, aggregation, groupVariable, {
    sort: 'value',
    maxCategories: 40,
    maxGroups: 10,
  })
  const horizontal = orientation === 'h'
  const metricLabel = built.metricLabel
  const title = built.grouped
    ? `${metricLabel} de ${xVariable.label} por ${groupVariable.label}`
    : built.useAggregation
      ? `${metricLabel} de ${yVariable.label} por ${xVariable.label}`
      : `Distribución de ${xVariable.label}`

  const layout = baseLayout(title, {
    showLegend: built.grouped,
    horizontal,
  })
  layout.barmode = mode

  if (horizontal) {
    layout.xaxis.title = { text: metricLabel }
    layout.yaxis.title = { text: xVariable.label }
    layout.yaxis.autorange = 'reversed'
    layout.yaxis.type = 'category'
  } else {
    layout.xaxis.title = { text: xVariable.label }
    layout.yaxis.title = { text: metricLabel }
    layout.xaxis.type = 'category'
  }

  const data = built.series.map((series, index) => {
    const color = built.grouped ? PALETTE[index % PALETTE.length] : null
    const categoryAxis = horizontal ? 'y' : 'x'
    const valueAxis = horizontal ? 'x' : 'y'
    return {
      type: 'bar',
      orientation,
      name: series.name || metricLabel,
      x: horizontal ? series.values : built.categories,
      y: horizontal ? built.categories : series.values,
      marker: {
        color: color || built.categories.map((_, itemIndex) => PALETTE[itemIndex % PALETTE.length]),
        line: { width: 0 },
      },
      hovertemplate:
        `<b>%{${categoryAxis}}</b><br>` +
        `${metricLabel}: %{${valueAxis}}<br>` +
        (built.grouped ? '%{fullData.name}<extra></extra>' : '<extra></extra>'),
    }
  })

  return { data, layout }
}

function histogramSpec(rows, xVariable) {
  if (!isNumericVariable(xVariable)) {
    return barSpec(rows, xVariable, null, 'count', null, 'v', 'group')
  }

  const values = rows
    .map((row) => row[xVariable.name])
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter((value) => !Number.isNaN(value))

  if (!values.length) {
    return { empty: `No hay valores numéricos para ${xVariable.label}.` }
  }

  const layout = baseLayout(`Histograma de ${xVariable.label}`)
  layout.xaxis.title = { text: xVariable.label }
  layout.yaxis.title = { text: 'Frecuencia' }

  return {
    data: [
      {
        type: 'histogram',
        x: values,
        nbinsx: Math.min(50, Math.max(10, Math.round(Math.sqrt(values.length)))),
        marker: { color: '#2f4bff', line: { color: '#fffefb', width: 1 } },
        hovertemplate: `${xVariable.label}: %{x}<br>Frecuencia: %{y}<extra></extra>`,
      },
    ],
    layout,
  }
}

function scatterSpec(rows, xVariable, yVariable) {
  if (!isNumericVariable(xVariable) || !isNumericVariable(yVariable)) {
    return {
      empty: 'La dispersión necesita dos variables numéricas en los ejes X e Y.',
    }
  }

  const points = []
  for (const row of rows) {
    const x = Number(row[xVariable.name])
    const y = Number(row[yVariable.name])
    if (
      row[xVariable.name] !== null &&
      row[xVariable.name] !== undefined &&
      row[yVariable.name] !== null &&
      row[yVariable.name] !== undefined &&
      !Number.isNaN(x) &&
      !Number.isNaN(y)
    ) {
      points.push({ x, y })
    }
  }

  if (!points.length) {
    return { empty: 'No hay pares de valores numéricos para la dispersión.' }
  }

  const step = Math.max(1, Math.ceil(points.length / 5000))
  const sampled = points.filter((_, index) => index % step === 0)

  const layout = baseLayout(`${yVariable.label} vs. ${xVariable.label}`)
  layout.xaxis.title = { text: xVariable.label }
  layout.yaxis.title = { text: yVariable.label }
  layout.hovermode = 'closest'

  return {
    data: [
      {
        type: 'scattergl',
        mode: 'markers',
        x: sampled.map((point) => point.x),
        y: sampled.map((point) => point.y),
        marker: {
          color: rgba('#2f4bff', 0.55),
          size: 7,
          line: { color: '#fffefb', width: 0.5 },
        },
        hovertemplate: `${xVariable.label}: %{x}<br>${yVariable.label}: %{y}<extra></extra>`,
      },
    ],
    layout,
  }
}

function lineSpec(rows, xVariable, yVariable, aggregation, groupVariable, fill = false) {
  if (!xVariable) {
    return { empty: 'Selecciona una variable para el eje X.' }
  }

  const rawNumericLine =
    isNumericVariable(xVariable) && isNumericVariable(yVariable) && !groupVariable

  if (rawNumericLine) {
    const points = []
    for (const row of rows) {
      const x = Number(row[xVariable.name])
      const y = Number(row[yVariable.name])
      if (
        row[xVariable.name] !== null &&
        row[xVariable.name] !== undefined &&
        row[yVariable.name] !== null &&
        row[yVariable.name] !== undefined &&
        !Number.isNaN(x) &&
        !Number.isNaN(y)
      ) {
        points.push({ x, y })
      }
    }
    if (!points.length) {
      return { empty: 'No hay pares de valores numéricos para la línea.' }
    }
    points.sort((a, b) => a.x - b.x)
    const step = Math.max(1, Math.ceil(points.length / 5000))
    const sampled = points.filter((_, index) => index % step === 0)
    const layout = baseLayout(`${yVariable.label} vs. ${xVariable.label}`)
    layout.xaxis.title = { text: xVariable.label }
    layout.yaxis.title = { text: yVariable.label }
    layout.hovermode = 'x unified'

    return {
      data: [
        {
          type: 'scattergl',
          mode: 'lines+markers',
          x: sampled.map((point) => point.x),
          y: sampled.map((point) => point.y),
          line: { color: '#2f4bff', width: 2.5, shape: 'linear' },
          marker: { color: '#2f4bff', size: 4 },
          fill: fill ? 'tozeroy' : 'none',
          fillcolor: fill ? rgba('#2f4bff', 0.12) : undefined,
          hovertemplate: `${xVariable.label}: %{x}<br>${yVariable.label}: %{y}<extra></extra>`,
        },
      ],
      layout,
    }
  }

  const built = buildSeries(rows, xVariable, yVariable, aggregation, groupVariable, {
    sort: xVariable.type === 'numeric' ? 'x' : 'category',
    maxCategories: 60,
    maxGroups: 8,
    missing: null,
  })

  const title = built.grouped
    ? `${built.metricLabel} de ${xVariable.label} por ${groupVariable.label}`
    : built.useAggregation
      ? `${built.metricLabel} de ${yVariable.label} por ${xVariable.label}`
      : `Evolución de ${xVariable.label}`

  const numericX =
    xVariable.type === 'numeric' &&
    built.categories.every((label) => !Number.isNaN(Number(label)))
  const xValues = numericX ? built.categories.map(Number) : built.categories
  const layout = baseLayout(title, { showLegend: built.grouped })
  layout.xaxis.title = { text: xVariable.label }
  layout.yaxis.title = { text: built.metricLabel }
  layout.hovermode = 'x unified'

  const data = built.series.map((series, index) => {
    const color = PALETTE[index % PALETTE.length]
    return {
      type: 'scatter',
      mode: 'lines+markers',
      name: series.name || built.metricLabel,
      x: xValues,
      y: series.values,
      line: { color, width: 2.5, shape: 'linear' },
      marker: { color, size: 5 },
      fill: fill ? 'tozeroy' : 'none',
      fillcolor: fill ? rgba(color, 0.1) : undefined,
      connectgaps: false,
      hovertemplate:
        `<b>%{x}</b><br>${built.metricLabel}: %{y}<br>` +
        (built.grouped ? '%{fullData.name}<extra></extra>' : '<extra></extra>'),
    }
  })

  return { data, layout }
}

function boxSpec(rows, xVariable, yVariable) {
  const valueVariable = isNumericVariable(yVariable)
    ? yVariable
    : isNumericVariable(xVariable)
      ? xVariable
      : null
  if (!valueVariable) {
    return { empty: 'La caja necesita al menos una variable numérica en el eje Y.' }
  }

  const groupVariable =
    valueVariable === xVariable ? null : isCategoricalVariable(xVariable) ? xVariable : null
  const groups = new Map()

  for (const row of rows) {
    const value = Number(row[valueVariable.name])
    if (
      row[valueVariable.name] === null ||
      row[valueVariable.name] === undefined ||
      row[valueVariable.name] === '' ||
      Number.isNaN(value)
    ) {
      continue
    }
    const key =
      groupVariable && row[groupVariable.name] !== null && row[groupVariable.name] !== undefined
        ? String(row[groupVariable.name])
        : 'Todos'
    const values = groups.get(key) || []
    values.push(value)
    groups.set(key, values)
  }

  if (!groups.size) {
    return { empty: `No hay valores numéricos para ${valueVariable.label}.` }
  }

  let entries = [...groups.entries()].map(([label, values]) => ({ label, values }))
  const grouped = Boolean(groupVariable) && isCategoricalVariable(groupVariable)

  if (grouped) {
    entries.sort((a, b) => b.values.length - a.values.length)
    entries = entries.slice(0, 12)
  }

  const data = entries.map((entry, index) => {
    const color = PALETTE[index % PALETTE.length]
    return {
      type: 'box',
      name: grouped ? entry.label : valueVariable.label,
      y: entry.values,
      boxpoints: 'outliers',
      marker: { color, size: 4 },
      line: { width: 1.5, color },
      fillcolor: rgba(color, 0.14),
      hovertemplate: `${grouped ? 'Grupo: %{x}<br>' : ''}${valueVariable.label}: %{y}<extra></extra>`,
    }
  })

  const title = grouped
    ? `${valueVariable.label} por ${groupVariable.label}`
    : `Distribución de ${valueVariable.label}`
  const layout = baseLayout(title)
  layout.yaxis.title = { text: valueVariable.label }
  layout.boxmode = 'group'
  if (grouped) layout.xaxis.title = { text: groupVariable.label }

  return { data, layout }
}

export function buildChartSpec(rows, variables, config) {
  if (!rows.length) {
    return { empty: 'No hay filas que coincidan con los filtros actuales.' }
  }

  const xVariable = variables.find((variable) => variable.name === config.x)
  const yVariable = variables.find((variable) => variable.name === config.y)
  const groupVariable = variables.find((variable) => variable.name === config.group)
  const chartType = config.type
  const canGroup = AGGREGATION_TYPES.has(chartType) && isCategoricalVariable(groupVariable)

  if (!xVariable && chartType !== 'box') {
    return { empty: 'Selecciona una variable para el eje X.' }
  }

  if (chartType === 'bar') {
    return barSpec(rows, xVariable, yVariable, config.aggregation, canGroup ? groupVariable : null)
  }
  if (chartType === 'hbar') {
    return barSpec(
      rows,
      xVariable,
      yVariable,
      config.aggregation,
      canGroup ? groupVariable : null,
      'h',
      'group',
    )
  }
  if (chartType === 'stacked') {
    return barSpec(
      rows,
      xVariable,
      yVariable,
      config.aggregation,
      canGroup ? groupVariable : null,
      'v',
      'stack',
    )
  }
  if (chartType === 'line') {
    return lineSpec(rows, xVariable, yVariable, config.aggregation, canGroup ? groupVariable : null)
  }
  if (chartType === 'area') {
    return lineSpec(
      rows,
      xVariable,
      yVariable,
      config.aggregation,
      canGroup ? groupVariable : null,
      true,
    )
  }
  if (chartType === 'histogram') return histogramSpec(rows, xVariable)
  if (chartType === 'scatter') return scatterSpec(rows, xVariable, yVariable)
  if (chartType === 'box') return boxSpec(rows, xVariable, yVariable)
  return { empty: 'Selecciona un tipo de gráfica.' }
}
