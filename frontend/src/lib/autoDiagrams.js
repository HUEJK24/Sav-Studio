import { OPERATOR_LABELS, ruleIsActive } from './filters.js'
import { buildGroups } from './diagrams.js'

const CHART_LABELS = {
  bar: 'Barras',
  hbar: 'Barras horizontales',
  stacked: 'Apiladas',
  line: 'Líneas',
  area: 'Área',
  scatter: 'Dispersión',
  histogram: 'Histograma',
  box: 'Caja',
}

const CLASS_DEFS = [
  ['source', 'fill:#e9edff,stroke:#2f4bff,color:#1f36c9'],
  ['filter', 'fill:#fff7e0,stroke:#e6cd93,color:#a16207'],
  ['step', 'fill:#fffefb,stroke:#cfc7b8,color:#17181c'],
  ['result', 'fill:#e6f4ef,stroke:#0f766e,color:#0f766e'],
  ['group', 'fill:#f7f4ed,stroke:#cfc7b8,color:#17181c'],
  ['variable', 'fill:#fffefb,stroke:#cfc7b8,color:#17181c'],
  ['note', 'fill:#fff7e0,stroke:#e6cd93,color:#a16207'],
]

function clean(value) {
  return String(value ?? '')
    .replace(/"/g, "'")
    .replace(/\r?\n/g, ' ')
    .trim()
}

function formatNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('es-MX') : '0'
}

function formatStat(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('es-MX') : String(value ?? '')
}

function variableName(variable, fallback) {
  if (!variable) return fallback
  return variable.label && variable.label !== variable.name ? variable.label : variable.name
}

function findVariable(variables, name) {
  if (!name) return null
  return variables.find((variable) => variable.name === name) || null
}

function displayValue(variable, value) {
  if (!variable) return String(value ?? '')
  const match = (variable.categories || []).find(
    (category) => String(category.value) === String(value),
  )
  return match ? match.label : value
}

export function describeRule(rule, variables) {
  const variable = findVariable(variables, rule.field)
  const name = variableName(variable, rule.field || 'Variable')
  const operator = OPERATOR_LABELS[rule.operator] || rule.operator || ''

  if (rule.operator === 'isNull' || rule.operator === 'notNull') {
    return `${name}: ${operator}`
  }
  if (rule.operator === 'between') {
    const min = rule.min === '' || rule.min === undefined ? '…' : rule.min
    const max = rule.max === '' || rule.max === undefined ? '…' : rule.max
    return `${name}: ${operator} ${min} y ${max}`
  }
  if (rule.operator === 'in') {
    const values = (rule.values || []).map((value) => displayValue(variable, value))
    return `${name}: ${operator} [${values.join(', ')}]`
  }
  return `${name}: ${operator} ${displayValue(variable, rule.value ?? '')}`
}

function headerLines(direction = 'LR') {
  const lines = [`flowchart ${direction}`]
  CLASS_DEFS.forEach(([name, style]) => lines.push(`  classDef ${name} ${style};`))
  return lines
}

export function buildAnalysisFlow({
  dataset,
  variables = [],
  filters = [],
  matchMode = 'all',
  quickFilter = '',
  advancedCount = 0,
  viewCount = 0,
  chartConfig = {},
}) {
  const lines = headerLines()
  const edges = []

  let index = 0
  function addNode(label, className) {
    const id = `n${index}`
    index += 1
    lines.push(`  ${id}["${clean(label)}"]`)
    if (className) lines.push(`  class ${id} ${className};`)
    return id
  }
  function link(source, target) {
    edges.push(`  ${source} --> ${target}`)
  }

  const totalRows = dataset?.source_row_count ?? 0
  const loadedRows = dataset?.row_count ?? totalRows
  const columnCount = dataset?.column_count ?? variables.length
  const fileName = dataset?.file_name || 'Archivo .sav'
  const source = addNode(
    `${fileName}<br/>${formatNumber(totalRows)} filas · ${formatNumber(columnCount)} variables`,
    'source',
  )
  let previous = source

  const labelledCount = variables.filter((variable) => variable.has_value_labels).length
  const categoryCount = variables.reduce(
    (sum, variable) =>
      sum + (variable.categories?.length || Object.keys(variable.value_labels || {}).length),
    0,
  )
  const dataNode = addNode(
    `Datos procesados<br/>${formatNumber(loadedRows)} filas cargadas · ${formatNumber(variables.length)} variables<br/>${formatNumber(labelledCount)} con etiquetas · ${formatNumber(categoryCount)} categorías`,
    'step',
  )
  link(previous, dataNode)
  previous = dataNode

  const activeRules = filters.filter(ruleIsActive)
  const mode = matchMode === 'any' ? 'Cualquiera (O)' : 'Todas (Y)'
  const ruleLines = activeRules.map((rule) => describeRule(rule, variables))
  const filterNode = addNode(
    activeRules.length > 0
      ? `Filtros avanzados<br/>${activeRules.length} regla${activeRules.length === 1 ? '' : 's'} · ${mode}<br/>${ruleLines.join('<br/>')}`
      : 'Filtros avanzados<br/>Sin reglas activas',
    activeRules.length > 0 ? 'filter' : 'note',
  )
  link(previous, filterNode)
  previous = filterNode

  const search = String(quickFilter || '').trim()
  if (search) {
    const searchNode = addNode(`Búsqueda global<br/>"${search}"`, 'filter')
    link(previous, searchNode)
    previous = searchNode
  }

  const filteredRows = advancedCount || viewCount
  const visiblePercent = totalRows ? Math.round((viewCount / totalRows) * 100) : 0
  const viewLabel = `Vista actual<br/>${formatNumber(viewCount)} visibles · ${formatNumber(filteredRows)} tras filtros<br/>${formatNumber(totalRows)} en el archivo · ${visiblePercent}%`
  const view = addNode(viewLabel, 'result')
  link(previous, view)

  const xVariable = findVariable(variables, chartConfig.x)
  const yVariable = findVariable(variables, chartConfig.y)
  const groupVariable = findVariable(variables, chartConfig.group)
  const variableLines = []
  if (xVariable) variableLines.push(`Eje X: ${variableName(xVariable)}`)
  if (yVariable) variableLines.push(`Eje Y: ${variableName(yVariable)}`)
  else variableLines.push('Valor: conteo de filas')
  if (groupVariable) variableLines.push(`Agrupar: ${variableName(groupVariable)}`)
  const aggregation = chartConfig.aggregation || 'Conteo'
  variableLines.push(`Agregación: ${aggregation}`)

  const variablesNode = addNode(
    `Variables de la gráfica<br/>${variableLines.join('<br/>')}`,
    'step',
  )
  link(view, variablesNode)
  const chartLabel = CHART_LABELS[chartConfig.type] || chartConfig.type || 'Barras'
  const chartNode = addNode(`Gráfica<br/>${chartLabel}`, 'step')
  link(variablesNode, chartNode)

  const exportNode = addNode('Exportar resultados<br/>CSV / JSON', 'result')
  link(view, exportNode)

  if (viewCount === 0) {
    const warning = addNode('Sin filas visibles<br/>ajusta los filtros', 'note')
    link(view, warning)
  }

  return [...lines, ...edges].join('\n')
}

function variableMeta(variable) {
  const parts = []
  const measure = String(variable.measure || '').toLowerCase()
  if (measure && measure !== 'unknown') parts.push(measure)
  else if (variable.type) parts.push(variable.type)
  const categories = variable.categories?.length || Object.keys(variable.value_labels || {}).length
  if (categories) parts.push(`${categories} cat.`)
  return parts.join(' · ')
}

function variableStats(variable) {
  const stats = variable.stats || {}
  const parts = []
  if (Number.isFinite(Number(stats.count))) parts.push(`${formatNumber(stats.count)} válidos`)
  if (Number(stats.missing) > 0) parts.push(`${formatNumber(stats.missing)} perdidos`)
  if (stats.min !== null && stats.min !== undefined && stats.max !== null && stats.max !== undefined) {
    parts.push(`rango ${formatStat(stats.min)}–${formatStat(stats.max)}`)
  }
  if (variable.type === 'numeric' && stats.mean !== null && stats.mean !== undefined) {
    parts.push(`media ${formatStat(stats.mean)}`)
  }
  return parts.join(' · ')
}

function variableDetailLines(variable) {
  const lines = [variableName(variable, variable.name)]
  const meta = variableMeta(variable)
  if (meta) lines.push(meta)
  const stats = variableStats(variable)
  if (stats) lines.push(stats)
  const measure = String(variable.measure || '').toLowerCase()
  const categories = variable.categories || []
  const showCategories =
    categories.length > 0 &&
    (variable.has_value_labels ||
      (measure !== 'scale' && categories.length <= 80))
  if (showCategories) {
    lines.push('Valores:')
    categories.forEach((category) => {
      lines.push(`${clean(category.label)} (${formatNumber(category.count)})`)
    })
  } else if (categories.length) {
    lines.push(`${formatNumber(categories.length)} valores distintos`)
  }
  return lines
}

export function buildVariableMap(dataset, variables = [], options = {}) {
  const maxVariables = options.maxVariables ?? Number.POSITIVE_INFINITY
  const maxPerGroup = options.maxPerGroup ?? Number.POSITIVE_INFINITY
  const lines = headerLines('TB')

  const fileName = dataset?.file_name || 'Archivo .sav'
  const totalRows = dataset?.source_row_count ?? dataset?.row_count ?? 0
  const categoryCount = variables.reduce(
    (sum, variable) =>
      sum + (variable.categories?.length || Object.keys(variable.value_labels || {}).length),
    0,
  )
  lines.push(
    `  root["${clean(fileName)}<br/>${formatNumber(variables.length)} variables · ${formatNumber(totalRows)} filas<br/>${formatNumber(categoryCount)} categorías de respuesta"]`,
  )
  lines.push('  class root source;')

  if (!variables.length) {
    lines.push('  empty["Sin variables disponibles"]')
    lines.push('  class empty note;')
    lines.push('  root --> empty')
    return lines.join('\n')
  }

  const groups = buildGroups(variables)
  let shown = 0
  let omitted = 0

  groups.forEach((group, groupIndex) => {
    const groupId = `g${groupIndex}`
    const count = group.variables.length
    lines.push(`  ${groupId}["${clean(group.title)}<br/>${formatNumber(count)} variable${count === 1 ? '' : 's'}"]`)
    lines.push(`  class ${groupId} group;`)
    lines.push(`  root --> ${groupId}`)

    const withinGroup = group.variables.slice(0, maxPerGroup)
    withinGroup.forEach((variable, variableIndex) => {
      if (shown >= maxVariables) {
        omitted += 1
        return
      }
      const variableId = `${groupId}v${variableIndex}`
      const detail = variableDetailLines(variable).map(clean).join('<br/>')
      lines.push(`  ${variableId}["${detail}"]`)
      lines.push(`  class ${variableId} variable;`)
      lines.push(`  ${groupId} --> ${variableId}`)
      shown += 1
    })

    if (count > withinGroup.length) {
      omitted += count - withinGroup.length
    }
  })

  if (omitted > 0) {
    lines.push(`  more["+${formatNumber(omitted)} variables no mostradas"]`)
    lines.push('  class more note;')
    lines.push('  root --> more')
  }

  return lines.join('\n')
}

export function mermaidBaseName(fileName) {
  return (
    String(fileName || 'dataset')
      .replace(/\.(sav|zsav)$/i, '')
      .replace(/[^\w\-. ]+/g, '_')
      .trim() || 'dataset'
  )
}

export function downloadMermaid(code, fileName) {
  const blob = new Blob([code], { type: 'text/plain;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileName}.mmd`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
