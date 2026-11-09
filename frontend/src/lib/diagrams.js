import { ruleIsActive } from './filters.js'

export const ER_SECTION = 'er'
export const CASES_SECTION = 'cases'

const STORAGE_PREFIX = 'sav-studio:diagrams:v1'

const MEASURE_LABELS = {
  nominal: 'Nominales',
  ordinal: 'Ordinales',
  scale: 'Escala',
}

const CASE_DEFS = {
  actor: { title: 'Actor' },
  usecase: { title: 'Caso de uso' },
  process: { title: 'Proceso' },
  decision: { title: 'Decisión' },
}

function newId(prefix) {
  const random =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`
}

function stripExtension(name) {
  return String(name || '').replace(/\.(sav|zsav)$/i, '') || 'Conjunto de datos'
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('es-MX') : String(value)
}

function humanize(value) {
  return String(value || '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)(\S)/g, (match, space, char) => space + char.toUpperCase())
}

function slug(value) {
  return (
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'grupo'
  )
}

function measureLabel(variable) {
  if (variable.type === 'string') return 'Texto'
  const measure = String(variable.measure || '').toLowerCase()
  if (MEASURE_LABELS[measure]) return MEASURE_LABELS[measure]
  return 'Numéricas'
}

function typeMeta(variable) {
  if (variable.type === 'string') return 'texto'
  const measure = String(variable.measure || '').toLowerCase()
  if (measure) return measure
  return variable.type || 'dato'
}

function fieldMeta(variable) {
  const parts = [typeMeta(variable)]
  const categories =
    variable.categories?.length || Object.keys(variable.value_labels || {}).length
  if (categories) parts.push(`${categories} cat.`)
  const stats = variable.stats || {}
  if (variable.type === 'numeric' && stats.mean !== null && stats.mean !== undefined) {
    parts.push(`media ${formatNumber(stats.mean)}`)
  }
  if (stats.missing) parts.push(`${formatNumber(stats.missing)} perd.`)
  return parts.join(' · ')
}

function fieldFromVariable(variable) {
  const label =
    variable.label && variable.label !== variable.name ? variable.label : variable.name
  return { name: variable.name, label, meta: fieldMeta(variable) }
}

function prefixGroups(variables) {
  const groups = new Map()
  const pattern = /^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{1,})[0-9_]/
  for (const variable of variables) {
    const match = pattern.exec(variable.name || '')
    if (!match) continue
    const key = match[1].toLowerCase()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(variable)
  }
  return groups
}

function measureGroups(variables) {
  const groups = new Map()
  for (const variable of variables) {
    const label = measureLabel(variable)
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(variable)
  }
  return groups
}

export function buildGroups(variables) {
  const prefixes = prefixGroups(variables)
  const solidPrefixes = [...prefixes.values()].filter((group) => group.length >= 2)
  const usePrefixes = solidPrefixes.length >= 2 && prefixes.size <= 10
  const groups = []

  if (usePrefixes) {
    const grouped = new Set()
    for (const [key, vars] of prefixes) {
      vars.forEach((variable) => grouped.add(variable.name))
      groups.push({
        key: `prefix-${slug(key)}`,
        title: humanize(key),
        subtitle: 'grupo de variables',
        variables: vars,
      })
    }
    const rest = variables.filter((variable) => !grouped.has(variable.name))
    for (const [label, vars] of measureGroups(rest)) {
      groups.push({
        key: `measure-${slug(label)}`,
        title: label,
        subtitle: 'por medida SPSS',
        variables: vars,
      })
    }
    return groups
  }

  for (const [label, vars] of measureGroups(variables)) {
    groups.push({
      key: `measure-${slug(label)}`,
      title: label,
      subtitle: 'por medida SPSS',
      variables: vars,
    })
  }
  return groups
}

export function seedEntityDiagram(dataset, variables) {
  const safeVariables = Array.isArray(variables) ? variables : []
  const rootId = newId('entity')
  const nodes = [
    {
      id: rootId,
      type: 'entity',
      position: { x: 0, y: 0 },
      data: {
        title: stripExtension(dataset?.file_name),
        subtitle: 'Entidad principal',
        badge: 'Dataset',
        root: true,
        fields: [
          { name: 'archivo', label: 'Archivo', meta: 'sav' },
          { name: 'filas', label: 'Filas', meta: formatNumber(dataset?.source_row_count) },
          { name: 'variables', label: 'Variables', meta: formatNumber(safeVariables.length) },
        ],
      },
    },
  ]
  const edges = []
  const groups = buildGroups(safeVariables)
  if (!groups.length) return { nodes, edges }

  const BASE_HEIGHT = 66
  const ROW_HEIGHT = 24
  const COLUMN_X = [360, 700]
  const columnY = [0, 0]

  groups.forEach((group, index) => {
    const column = index % 2
    const fields = group.variables.map(fieldFromVariable)
    const id = newId('entity')
    nodes.push({
      id,
      type: 'entity',
      position: { x: COLUMN_X[column], y: columnY[column] },
      data: {
        title: group.title,
        subtitle: group.subtitle,
        badge: `${group.variables.length} var${group.variables.length === 1 ? '' : 's'}`,
        fields,
      },
    })
    edges.push({
      id: newId('edge'),
      source: rootId,
      target: id,
      type: 'smoothstep',
      label: 'contiene',
      markerEnd: { type: 'arrowclosed' },
      labelStyle: { fill: '#6f6a61', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: '#fffefb' },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
    })
    columnY[column] += BASE_HEIGHT + fields.length * ROW_HEIGHT + 46
  })

  return { nodes, edges }
}

export function seedCaseDiagram(dataset, variables, context = {}) {
  const {
    filters = [],
    matchMode = 'all',
    quickFilter = '',
    advancedCount = 0,
    viewCount = 0,
    chartConfig = {},
  } = context
  const nodes = []
  const edges = []
  const totalRows = dataset?.source_row_count ?? 0
  const loadedRows = dataset?.row_count ?? totalRows
  const activeRules = filters.filter(ruleIsActive)
  const search = String(quickFilter || '').trim()
  const chartLabel =
    {
      bar: 'Barras',
      hbar: 'Barras horizontales',
      stacked: 'Apiladas',
      line: 'Líneas',
      area: 'Área',
      scatter: 'Dispersión',
      histogram: 'Histograma',
      box: 'Caja',
    }[chartConfig.type] || chartConfig.type || 'Barras'

  function addCase(kind, title, position, detail) {
    const id = newId('case')
    nodes.push({
      id,
      type: 'case',
      position,
      data: { kind, title, detail },
    })
    return id
  }

  function connect(source, target, label) {
    edges.push({
      id: newId('edge'),
      source,
      target,
      type: 'smoothstep',
      label,
      markerEnd: { type: 'arrowclosed' },
      labelStyle: { fill: '#6f6a61', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: '#fffefb' },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
    })
  }

  const actor = addCase('actor', 'Analista de datos', { x: 0, y: 190 })
  const explore = addCase(
    'usecase',
    'Explorar archivo .sav',
    { x: 230, y: 80 },
    `${dataset?.file_name || 'Archivo .sav'} · ${formatNumber(totalRows)} filas · ${formatNumber(variables?.length || 0)} variables`,
  )
  const filter = addCase(
    'usecase',
    'Filtrar y buscar',
    { x: 230, y: 280 },
    `${activeRules.length} regla${activeRules.length === 1 ? '' : 's'} · ${matchMode === 'any' ? 'cualquiera' : 'todas'}${search ? ` · "${search}"` : ''}`,
  )
  const analyze = addCase(
    'process',
    'Analizar y visualizar',
    { x: 570, y: 180 },
    `${formatNumber(viewCount)} filas visibles · ${formatNumber(advancedCount)} tras filtros · ${chartLabel}`,
  )
  const decision = addCase(
    'decision',
    '¿Listo para exportar?',
    { x: 860, y: 180 },
    `${formatNumber(loadedRows)} filas procesadas`,
  )
  const exportData = addCase(
    'usecase',
    'Exportar datos',
    { x: 1130, y: 80 },
    'CSV / JSON con la vista actual',
  )
  const exportDiagrams = addCase(
    'usecase',
    'Exportar diagramas',
    { x: 1130, y: 280 },
    'SVG / PNG / PDF / Mermaid',
  )

  connect(actor, explore)
  connect(actor, filter)
  connect(explore, analyze, 'datos')
  connect(filter, analyze, 'vista')
  connect(analyze, decision)
  connect(decision, exportData, 'sí')
  connect(decision, exportDiagrams, 'sí')
  connect(decision, filter, 'ajustar')

  return { nodes, edges }
}

export function createEntityNode(position, index = 1) {
  return {
    id: newId('entity'),
    type: 'entity',
    position: { ...position },
    data: {
      title: index > 1 ? `Entidad ${index}` : 'Entidad',
      subtitle: 'Nueva entidad',
      badge: '0 vars',
      fields: [],
    },
  }
}

export function createCaseNode(kind, position, index = 1) {
  const definition = CASE_DEFS[kind] || CASE_DEFS.process
  const title = index > 1 ? `${definition.title} ${index}` : definition.title
  return {
    id: newId('case'),
    type: 'case',
    position: { ...position },
    data: { kind, title },
  }
}

export function createLaneNode(position, index = 1) {
  const width = 560
  const height = 360
  return {
    id: newId('lane'),
    type: 'lane',
    position: { x: position.x - width / 2, y: position.y - height / 2 },
    style: { width, height },
    data: {
      title: index > 1 ? `Carril ${index}` : 'Carril',
      width,
      height,
    },
  }
}

export function datasetSignature(dataset) {
  if (!dataset) return 'dataset'
  const name = String(dataset.file_name || 'dataset').toLowerCase()
  return `${name}::${dataset.source_row_count ?? ''}::${dataset.column_count ?? ''}`
}

export function diagramStorageKey(datasetId, section) {
  return `${STORAGE_PREFIX}:${datasetId}:${section}`
}

export function serializeDiagram(diagram) {
  const nodes = (diagram.nodes || []).map((node) => {
    const { selected, dragging, ...rest } = node
    return rest
  })
  const edges = (diagram.edges || []).map((edge) => {
    const { selected, ...rest } = edge
    return rest
  })
  return { nodes, edges }
}

export function loadDiagram(datasetId, section) {
  if (!datasetId) return null
  try {
    const raw = window.localStorage.getItem(diagramStorageKey(datasetId, section))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
    return { nodes: parsed.nodes, edges: parsed.edges }
  } catch {
    return null
  }
}

export function saveDiagram(datasetId, section, diagram) {
  if (!datasetId) return
  try {
    const payload = { version: 1, savedAt: Date.now(), ...serializeDiagram(diagram) }
    window.localStorage.setItem(diagramStorageKey(datasetId, section), JSON.stringify(payload))
  } catch {
    /* almacenamiento lleno o no disponible */
  }
}

export function exportDiagramFile(datasetName, section, diagram) {
  const base =
    String(datasetName || 'dataset')
      .replace(/\.(sav|zsav)$/i, '')
      .replace(/[^\w\-. ]+/g, '_')
      .trim() || 'dataset'
  const payload = {
    app: 'sav-studio',
    version: 1,
    section,
    dataset: datasetName,
    ...serializeDiagram(diagram),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8;',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${base}_${section}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function parseDiagramFile(text) {
  const parsed = JSON.parse(text)
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error('El archivo no contiene un diagrama válido.')
  }
  return { nodes: parsed.nodes, edges: parsed.edges }
}
