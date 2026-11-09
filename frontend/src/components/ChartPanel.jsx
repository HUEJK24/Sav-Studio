import { useEffect, useMemo, useRef } from 'react'
import Plotly from 'plotly.js-cartesian-dist-min'
import { buildChartSpec, isNumericVariable, PLOTLY_CONFIG } from '../lib/charts'

const PlotlyLib = Plotly.default || Plotly

const CHART_TYPES = [
  { value: 'bar', label: 'Barras', hint: 'Compara categorías de un vistazo.' },
  { value: 'hbar', label: 'Barras H', hint: 'Ideal para etiquetas largas.' },
  { value: 'stacked', label: 'Apiladas', hint: 'Elige “Agrupar por” para apilar series.' },
  { value: 'line', label: 'Líneas', hint: 'Sigue tendencias y secuencias.' },
  { value: 'area', label: 'Área', hint: 'Resalta el volumen de una serie.' },
  { value: 'scatter', label: 'Dispersión', hint: 'Relaciona dos variables numéricas.' },
  { value: 'histogram', label: 'Histograma', hint: 'Explora la distribución de una variable.' },
  { value: 'box', label: 'Caja', hint: 'Compara cuartiles y valores atípicos.' },
]

const GROUPABLE_TYPES = new Set(['bar', 'hbar', 'stacked', 'line', 'area'])
const AGGREGATION_TYPES = GROUPABLE_TYPES
const BAR_TYPES = new Set(['bar', 'hbar', 'stacked'])
const NUMERIC_FIRST_TYPES = new Set(['scatter', 'histogram', 'box'])

function ChartIcon({ name }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }

  if (name === 'bar') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20V9m5 11V5m5 15v-7m5 7V8" {...common} />
      </svg>
    )
  }
  if (name === 'hbar') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h9M4 12h14M4 18h6" {...common} />
      </svg>
    )
  }
  if (name === 'stacked') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="4" width="4" height="5" rx="1" {...common} />
        <rect x="5" y="9" width="4" height="5" rx="1" {...common} />
        <rect x="5" y="14" width="4" height="6" rx="1" {...common} />
        <rect x="15" y="6" width="4" height="4" rx="1" {...common} />
        <rect x="15" y="10" width="4" height="5" rx="1" {...common} />
        <rect x="15" y="15" width="4" height="5" rx="1" {...common} />
      </svg>
    )
  }
  if (name === 'line') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m4 17 5-6 4 3 7-8" {...common} />
        <circle cx="4" cy="17" r="1.2" fill="currentColor" />
        <circle cx="9" cy="11" r="1.2" fill="currentColor" />
        <circle cx="13" cy="14" r="1.2" fill="currentColor" />
        <circle cx="20" cy="6" r="1.2" fill="currentColor" />
      </svg>
    )
  }
  if (name === 'area') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m4 17 5-6 4 3 7-8v12H4Z" fill="currentColor" opacity="0.14" stroke="none" />
        <path d="m4 17 5-6 4 3 7-8" {...common} />
      </svg>
    )
  }
  if (name === 'scatter') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="16" r="1.8" {...common} />
        <circle cx="10" cy="10" r="1.8" {...common} />
        <circle cx="15" cy="14" r="1.8" {...common} />
        <circle cx="19" cy="7" r="1.8" {...common} />
        <circle cx="8" cy="6" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (name === 'histogram') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20h16M6 20v-5h3v5m0 0v-9h3v9m0 0V7h3v13m0 0V4h3v16" {...common} />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4v3m0 10v3m-2-3h4m-4-10h4" {...common} />
      <rect x="9" y="7" width="9" height="10" rx="1.5" {...common} />
      <path d="M12 9.5h3M12 14.5h3" {...common} />
    </svg>
  )
}

export default function ChartPanel({
  rows,
  variables,
  config,
  setConfig,
  active = true,
  serverPaged = false,
  filteredTotal = null,
  filterPending = false,
}) {
  const containerRef = useRef(null)

  const numericVariables = useMemo(
    () => variables.filter((variable) => isNumericVariable(variable)),
    [variables],
  )

  const categoricalVariables = useMemo(
    () =>
      variables.filter(
        (variable) => variable.has_value_labels || variable.type === 'string',
      ),
    [variables],
  )

  const spec = useMemo(
    () => buildChartSpec(rows, variables, config),
    [rows, variables, config],
  )

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined

    if (spec.empty) {
      PlotlyLib.purge(element)
      return undefined
    }

    PlotlyLib.react(element, spec.data, spec.layout, PLOTLY_CONFIG)
    return undefined
  }, [spec])

  useEffect(() => {
    if (!active || !containerRef.current || spec.empty) return undefined
    const element = containerRef.current
    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => PlotlyLib.Plots.resize(element))
    }

    resize()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    if (element.parentElement) observer?.observe(element.parentElement)
    window.addEventListener('resize', resize)

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [active, spec.empty])

  useEffect(
    () => () => {
      if (containerRef.current) PlotlyLib.purge(containerRef.current)
    },
    [],
  )

  function update(patch) {
    setConfig((current) => ({ ...current, ...patch }))
  }

  function changeType(type) {
    const xVariable = variables.find((variable) => variable.name === config.x)
    const yVariable = variables.find((variable) => variable.name === config.y)
    const next = { ...config, type }

    if (type === 'histogram' && !isNumericVariable(xVariable)) {
      next.x = numericVariables[0]?.name || config.x
    }
    if (type === 'scatter') {
      if (!isNumericVariable(xVariable)) next.x = numericVariables[0]?.name || config.x
      if (!isNumericVariable(yVariable)) {
        next.y = numericVariables[1]?.name || numericVariables[0]?.name || config.y
      }
    }
    if (type === 'box' && !isNumericVariable(yVariable)) {
      next.y = numericVariables[0]?.name || config.y
    }
    if (
      BAR_TYPES.has(type) &&
      NUMERIC_FIRST_TYPES.has(config.type) &&
      !categoricalVariables.some((variable) => variable.name === config.x)
    ) {
      next.x = categoricalVariables[0]?.name || config.x
    }
    if (!GROUPABLE_TYPES.has(type)) next.group = ''

    setConfig(next)
  }

  const yVariable = variables.find((variable) => variable.name === config.y)
  const activeType = CHART_TYPES.find((type) => type.value === config.type) || CHART_TYPES[0]
  const showAggregation = AGGREGATION_TYPES.has(config.type) && isNumericVariable(yVariable)
  const showGroup = GROUPABLE_TYPES.has(config.type)
  const activeHint =
    config.type === 'stacked' && !config.group
      ? 'Elige “Agrupar por” para apilar series de una misma categoría.'
      : activeType.hint

  return (
    <section className="panel chart-panel">
      <div className="panel-heading chart-heading">
        <div>
          <span className="section-kicker">Visualización</span>
          <h2>Dashboard dinámico</h2>
          <p>Elige un formato y la gráfica se construye automáticamente.</p>
        </div>
        <span className="badge">
          {serverPaged
            ? filterPending || filteredTotal === null
              ? `${rows.length.toLocaleString('es-MX')} filas de muestra`
              : `${filteredTotal.toLocaleString('es-MX')} coincidencias · muestra de ${rows.length.toLocaleString('es-MX')}`
            : `${rows.length.toLocaleString('es-MX')} filas`}
        </span>
      </div>

      <div className="chart-type-picker">
        <div className="chart-type-grid" role="group" aria-label="Tipo de gráfica">
          {CHART_TYPES.map((type) => (
            <button
              key={type.value}
              type="button"
              className={`chart-type-button ${config.type === type.value ? 'is-active' : ''}`}
              onClick={() => changeType(type.value)}
              aria-pressed={config.type === type.value}
              title={type.hint}
            >
              <span className="chart-type-icon">
                <ChartIcon name={type.value} />
              </span>
              <span>{type.label}</span>
            </button>
          ))}
        </div>
        <p className="chart-type-hint">{activeHint}</p>
      </div>

      <div className="chart-controls">
        <label className="control">
          <span>Eje X</span>
          <select
            className="select select-sm"
            value={config.x}
            onChange={(event) => update({ x: event.target.value })}
          >
            <option value="">Selecciona una variable…</option>
            {variables.map((variable) => (
              <option key={variable.name} value={variable.name}>
                {variable.label} ({variable.name})
              </option>
            ))}
          </select>
        </label>

        <label className="control">
          <span>Eje Y</span>
          <select
            className="select select-sm"
            value={config.y}
            onChange={(event) => update({ y: event.target.value })}
          >
            <option value="">Ninguna / contar</option>
            {numericVariables.map((variable) => (
              <option key={variable.name} value={variable.name}>
                {variable.label} ({variable.name})
              </option>
            ))}
          </select>
        </label>

        {showGroup && (
          <label className="control">
            <span>Agrupar por</span>
            <select
              className="select select-sm"
              value={config.group || ''}
              onChange={(event) => update({ group: event.target.value })}
            >
              <option value="">Sin agrupar</option>
              {categoricalVariables.map((variable) => (
                <option key={variable.name} value={variable.name}>
                  {variable.label} ({variable.name})
                </option>
              ))}
            </select>
          </label>
        )}

        {showAggregation && (
          <label className="control">
            <span>Agregación</span>
            <select
              className="select select-sm"
              value={config.aggregation}
              onChange={(event) => update({ aggregation: event.target.value })}
            >
              <option value="count">Frecuencia</option>
              <option value="mean">Promedio</option>
              <option value="median">Mediana</option>
              <option value="sum">Suma</option>
            </select>
          </label>
        )}
      </div>

      <div className="chart-area">
        <div
          ref={containerRef}
          className="chart-canvas"
          style={{ display: spec.empty ? 'none' : 'block' }}
        />
        {spec.empty && <div className="chart-empty">{spec.empty}</div>}
      </div>

      <p className="chart-footnote">
        {serverPaged
          ? `La gráfica se actualiza con las filas filtradas de la muestra cargada (${rows.length.toLocaleString('es-MX')}). El total de coincidencias incluye todo el archivo; las exportaciones CSV/JSON incluyen todas esas filas.`
          : 'La gráfica respeta los filtros avanzados y los filtros de columna aplicados en la tabla.'}
      </p>
    </section>
  )
}
