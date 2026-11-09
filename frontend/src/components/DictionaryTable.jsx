import { useMemo, useState } from 'react'

const TYPE_LABELS = {
  numeric: 'Numérica',
  string: 'Texto',
  date: 'Fecha',
}

const MEASURE_LABELS = {
  nominal: 'Nominal',
  ordinal: 'Ordinal',
  scale: 'Escala',
  unknown: '—',
}

function formatNumber(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') {
    return value.toLocaleString('es-MX', { maximumFractionDigits: 3 })
  }
  return value
}

function valuesSummary(variable) {
  const categories = variable.categories || []
  if (categories.length > 0) {
    const shown = categories.slice(0, 8)
    const extra = categories.length - shown.length
    return (
      <div className="value-chips">
        {shown.map((category) => (
          <span className="value-chip" key={String(category.value)}>
            {category.label}
            <em>{category.count.toLocaleString('es-MX')}</em>
          </span>
        ))}
        {extra > 0 && <span className="value-chip is-more">+{extra} más</span>}
      </div>
    )
  }

  const stats = variable.stats || {}
  if (variable.type === 'numeric' && stats.min !== undefined) {
    return (
      <span className="stats-line">
        {formatNumber(stats.min)} – {formatNumber(stats.max)} · media {formatNumber(stats.mean)}
      </span>
    )
  }

  return <span className="muted">Sin categorías</span>
}

export default function DictionaryTable({ variables, sampled = false }) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return variables
    return variables.filter(
      (variable) =>
        variable.name.toLowerCase().includes(needle) ||
        String(variable.label).toLowerCase().includes(needle),
    )
  }, [variables, search])

  return (
    <section className="panel dictionary-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">Metadatos</span>
          <h2>Diccionario de variables</h2>
          <p>
            {sampled
              ? 'Variables y etiquetas de todo el archivo; conteos y estadísticas de la muestra inicial.'
              : 'Metadatos, etiquetas y distribución de cada columna del archivo SPSS.'}
          </p>
        </div>
        <span className="badge">{filtered.length.toLocaleString('es-MX')} variables</span>
      </div>

      <div className="dictionary-toolbar">
        <input
          className="input"
          type="search"
          placeholder="Buscar por nombre o etiqueta…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="dictionary-table-wrap">
        <table className="dictionary-table">
          <thead>
            <tr>
              <th>Variable</th>
              <th>Etiqueta</th>
              <th>Tipo</th>
              <th>Medición</th>
              <th>Únicos</th>
              <th>Perdidos</th>
              <th>Valores / resumen</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((variable) => (
              <tr key={variable.name}>
                <td>
                  <code>{variable.name}</code>
                  {variable.has_value_labels && <span className="tiny-badge">etiquetas</span>}
                </td>
                <td>{variable.label}</td>
                <td>
                  <span className={`type-badge type-${variable.type}`}>
                    {TYPE_LABELS[variable.type] || variable.type}
                  </span>
                </td>
                <td>{MEASURE_LABELS[variable.measure] || variable.measure}</td>
                <td>{formatNumber(variable.stats?.unique)}</td>
                <td>{formatNumber(variable.stats?.missing)}</td>
                <td>{valuesSummary(variable)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="dictionary-empty">
                  No hay variables que coincidan con la búsqueda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
