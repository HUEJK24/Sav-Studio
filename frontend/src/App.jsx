import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import {
  checkHealth,
  deleteDataset,
  exportDatasetFile,
  getDatasetStatus,
  reloadDataset,
} from './api'
import DictionaryTable from './components/DictionaryTable'
import FilterBuilder from './components/FilterBuilder'
import UploadPanel from './components/UploadPanel'
import { downloadBlob, downloadCSV, downloadJSON } from './lib/export'
import { applyFilters, ruleIsActive } from './lib/filters'

const ChartPanel = lazy(() => import('./components/ChartPanel'))
const DataTable = lazy(() => import('./components/DataTable'))
const DiagramPanel = lazy(() => import('./components/DiagramPanel'))

const EMPTY_ROWS = []
const EMPTY_VARIABLES = []

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'table', label: 'Tabla' },
  { id: 'diagrams', label: 'Diagramas' },
  { id: 'dictionary', label: 'Diccionario' },
]

const PREVIEW_BARS = [46, 72, 38, 88, 61, 94, 54]

function defaultChartConfig(variables) {
  const categorical = variables.find(
    (variable) => variable.has_value_labels || variable.type === 'string',
  )
  const numeric = variables.find(
    (variable) => variable.type === 'numeric' && !variable.has_value_labels,
  )
  const x = categorical?.name || numeric?.name || variables[0]?.name || ''
  const y = numeric?.name || ''

  return {
    x,
    y,
    group: '',
    type: categorical ? 'bar' : numeric ? 'histogram' : 'bar',
    aggregation: 'count',
  }
}

function Kpi({ label, value, hint, accent = false }) {
  return (
    <div className={`kpi ${accent ? 'is-accent' : ''}`}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {hint && <span className="kpi-hint">{hint}</span>}
    </div>
  )
}

function HeroPreview() {
  return (
    <div className="hero-preview" aria-hidden="true">
      <div className="preview-top">
        <span className="preview-dot" />
        <span>Vista previa del dashboard</span>
        <span className="preview-pill">SPSS</span>
      </div>
      <div className="preview-chart">
        <div className="preview-grid-line" />
        <div className="preview-grid-line" />
        <div className="preview-grid-line" />
        <div className="preview-bars">
          {PREVIEW_BARS.map((height, index) => (
            <span
              key={height}
              className={`preview-bar ${index === 5 ? 'is-highlight' : ''}`}
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      </div>
      <div className="preview-legend">
        <span>
          <i className="legend-swatch" /> Respuestas
        </span>
        <span>
          <i className="legend-swatch is-alt" /> Segmento
        </span>
        <span className="preview-trend">+18.4%</span>
      </div>
      <div className="preview-foot">
        <span>Etiquetas SPSS</span>
        <span>Filtros tipo Excel</span>
        <span>Exportación</span>
      </div>
    </div>
  )
}

export default function App() {
  const [dataset, setDataset] = useState(null)
  const [filters, setFilters] = useState([])
  const [matchMode, setMatchMode] = useState('all')
  const [quickFilter, setQuickFilter] = useState('')
  const [viewRows, setViewRows] = useState(EMPTY_ROWS)
  const [, setPagedRows] = useState(EMPTY_ROWS)
  const [chartConfig, setChartConfig] = useState({
    x: '',
    y: '',
    group: '',
    type: 'bar',
    aggregation: 'count',
  })
  const [tab, setTab] = useState('dashboard')
  const [visitedTabs, setVisitedTabs] = useState(['dashboard'])
  const [health, setHealth] = useState('checking')
  const [resetToken, setResetToken] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [reloading, setReloading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(null)
  const [serverFilterTotal, setServerFilterTotal] = useState(null)
  const [serverFilterPending, setServerFilterPending] = useState(false)

  const variables = dataset?.variables || EMPTY_VARIABLES
  const allRows = dataset?.rows || EMPTY_ROWS

  useEffect(() => {
    checkHealth().then((result) => setHealth(result ? 'online' : 'offline'))
  }, [])

  const advancedRows = useMemo(
    () => applyFilters(allRows, filters, matchMode),
    [allRows, filters, matchMode],
  )

  const activeRuleCount = filters.filter(ruleIsActive).length

  useEffect(() => {
    if (dataset?.server_paged && activeRuleCount === 0) setViewRows(allRows)
  }, [dataset?.server_paged, activeRuleCount, allRows])

  const notify = useCallback((message) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2600)
  }, [])

  const handleDatasetUnavailable = useCallback(() => {
    setDataset(null)
    setFilters([])
    setMatchMode('all')
    setQuickFilter('')
    setViewRows(EMPTY_ROWS)
    setPagedRows(EMPTY_ROWS)
    setServerFilterTotal(null)
    setServerFilterPending(false)
    setTab('dashboard')
    notify('La sesión del archivo expiró. Vuelve a cargar el archivo para continuar.')
  }, [notify])

  useEffect(() => {
    if (!dataset?.cache_building) return undefined
    let cancelled = false
    let failureNotified = false
    const datasetId = dataset.id
    const timer = window.setInterval(async () => {
      try {
        const status = await getDatasetStatus(datasetId)
        if (cancelled) return
        setDataset((current) =>
          current?.id === datasetId
            ? {
                ...current,
                cache_building: status.cache_building,
                cache_progress: status.cache_progress,
                cache_error: status.cache_error,
              }
            : current,
        )
      } catch (error) {
        if (cancelled) return
        if (error.status === 404) {
          handleDatasetUnavailable()
        } else if (!failureNotified) {
          failureNotified = true
          notify(`No se pudo consultar el progreso de indexación. ${error.message}`)
        }
      }
    }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [dataset?.cache_building, dataset?.id, handleDatasetUnavailable, notify])

  const handleFilteredTotalChange = useCallback((total, filtered, pending = false) => {
    setServerFilterPending(pending)
    setServerFilterTotal(filtered && !pending ? total : null)
  }, [])

  const handleReloadDataset = useCallback(async () => {
    if (!dataset || reloading) return
    setReloading(true)
    try {
      const payload = await reloadDataset(dataset.id)
      setDataset(payload)
      setFilters([])
      setMatchMode('all')
      setQuickFilter('')
      setViewRows(payload.rows || [])
      setPagedRows(EMPTY_ROWS)
      setServerFilterTotal(null)
      setServerFilterPending(false)
      setChartConfig(defaultChartConfig(payload.variables || []))
      setResetToken((value) => value + 1)
      notify(
        `ETL reprocesado: ${(payload.row_count || 0).toLocaleString('es-MX')} filas y ${(payload.variables?.length || 0).toLocaleString('es-MX')} variables.`,
      )
    } catch (error) {
      notify(error.message || 'No se pudo reprocesar el archivo .sav.')
    } finally {
      setReloading(false)
    }
  }, [dataset, notify, reloading])

  const handleLoaded = useCallback(async (payload) => {
    if (dataset && dataset.id !== payload.id) await deleteDataset(dataset.id)
    setDataset(payload)
    setFilters([])
    setMatchMode('all')
    setQuickFilter('')
    setViewRows(payload.rows || [])
    setPagedRows(EMPTY_ROWS)
    setServerFilterTotal(null)
    setServerFilterPending(false)
    setChartConfig(defaultChartConfig(payload.variables || []))
    setTab('dashboard')
    setVisitedTabs(['dashboard'])
    setResetToken((value) => value + 1)
    setSidebarOpen(false)
  }, [dataset])

  const handleTabChange = useCallback((nextTab) => {
    setTab(nextTab)
    setVisitedTabs((visited) =>
      visited.includes(nextTab) ? visited : [...visited, nextTab],
    )
  }, [])

  const handleClearFilters = useCallback(() => {
    setFilters([])
    setMatchMode('all')
    setQuickFilter('')
    setServerFilterTotal(null)
    setServerFilterPending(false)
    setResetToken((value) => value + 1)
  }, [])

  const handleCloseDataset = useCallback(async () => {
    if (dataset) await deleteDataset(dataset.id)
    setDataset(null)
    setFilters([])
    setViewRows(EMPTY_ROWS)
    setPagedRows(EMPTY_ROWS)
    setServerFilterTotal(null)
    setTab('dashboard')
    setVisitedTabs(['dashboard'])
  }, [dataset])

  async function handleServerExport(format) {
    if (!dataset || exporting) return
    setExporting(true)
    setExportProgress({
      format,
      percent: 0,
      completed: 0,
      total: dataset.source_row_count,
    })
    notify(`Generando ${format.toUpperCase()} con los filtros aplicados…`)
    try {
      const { blob, fileName } = await exportDatasetFile(dataset.id, {
        rules: filters,
        matchMode,
        format,
        onProgress: (progress) => setExportProgress({ format, ...progress }),
      })
      downloadBlob(blob, fileName)
      notify(`${format.toUpperCase()} filtrado descargado: ${fileName}`)
    } catch (error) {
      notify(error.message || `No se pudo generar el archivo ${format.toUpperCase()}.`)
    } finally {
      setExporting(false)
      setExportProgress(null)
    }
  }

  async function handleExportCSV() {
    if (dataset?.server_paged) {
      await handleServerExport('csv')
      return
    }
    const rows = viewRows
    if (!dataset || exporting) return
    setExporting(true)
    setExportProgress({ format: 'csv', percent: 0, completed: 0, total: rows.length })
    try {
      await downloadCSV(rows, variables, dataset.file_name, (progress) =>
        setExportProgress({ format: 'csv', ...progress }),
      )
      notify(`CSV exportado con ${rows.length.toLocaleString('es-MX')} filas filtradas.`)
    } catch (error) {
      notify(error.message || 'No se pudo generar el archivo CSV.')
    } finally {
      setExporting(false)
      setExportProgress(null)
    }
  }

  async function handleExportJSON() {
    if (dataset?.server_paged) {
      await handleServerExport('json')
      return
    }
    const rows = viewRows
    if (!dataset || exporting) return
    setExporting(true)
    setExportProgress({ format: 'json', percent: 0, completed: 0, total: rows.length })
    try {
      await downloadJSON(rows, dataset.file_name, (progress) =>
        setExportProgress({ format: 'json', ...progress }),
      )
      notify(`JSON exportado con ${rows.length.toLocaleString('es-MX')} filas filtradas.`)
    } catch (error) {
      notify(error.message || 'No se pudo generar el archivo JSON.')
    } finally {
      setExporting(false)
      setExportProgress(null)
    }
  }

  const visiblePercent = (dataset?.server_paged ? dataset.source_row_count : allRows.length)
    ? Math.round(
        (viewRows.length /
          (dataset?.server_paged ? dataset.source_row_count : allRows.length)) *
          100,
      )
    : 0

  const filteredCount = dataset?.server_paged
    ? activeRuleCount > 0
      ? serverFilterTotal
      : dataset.source_row_count
    : advancedRows.length
  const filterTotalCount = dataset?.server_paged ? dataset.source_row_count : allRows.length
  const dashboardRows =
    dataset?.server_paged && advancedRows.length === 0 && activeRuleCount > 0
      ? viewRows
      : dataset?.server_paged
        ? advancedRows
        : viewRows

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <span>SAV</span>
            <i />
          </div>
          <div>
            <h1>SAV Studio</h1>
            <p>Explorador SPSS · etiquetas, filtros y gráficas</p>
          </div>
        </div>

        <div className="topbar-right">
          <span className={`status-pill status-${health}`}>
            <i />
            {health === 'online'
              ? 'API conectada'
              : health === 'offline'
                ? 'API sin conexión'
                : 'Comprobando API…'}
          </span>
          {dataset && <UploadPanel compact onLoaded={handleLoaded} />}
        </div>
      </header>

      {!dataset ? (
        <main className="landing">
          <div className="hero-grid">
            <div className="hero">
              <span className="eyebrow">SPSS · .sav / .zsav</span>
              <h2>Tus encuestas de SPSS, convertidas en un explorador interactivo.</h2>
              <p>
                Sube un archivo .sav y conserva las etiquetas de variables y valores. Filtra como
                en Excel, genera gráficas dinámicas y exporta exactamente la vista que necesitas.
              </p>
              <div className="hero-points">
                <span>Metadatos reales</span>
                <span>Filtros combinables</span>
                <span>CSV / JSON</span>
              </div>
            </div>
            <HeroPreview />
          </div>

          <UploadPanel onLoaded={handleLoaded} />

          <div className="feature-grid">
            <article className="feature-card">
              <span className="feature-icon">01</span>
              <h3>Metadatos reales</h3>
              <p>
                Lee etiquetas de variables, etiquetas de valores, medidas y rangos perdidos de
                SPSS.
              </p>
            </article>
            <article className="feature-card">
              <span className="feature-icon">02</span>
              <h3>Filtros tipo Excel</h3>
              <p>
                Reglas avanzadas combinables y filtros flotantes por columna con listas de
                categorías.
              </p>
            </article>
            <article className="feature-card">
              <span className="feature-icon">03</span>
              <h3>Vista exportable</h3>
              <p>
                Las gráficas y las descargas CSV/JSON respetan todos los filtros activos de la
                sesión.
              </p>
            </article>
          </div>
        </main>
      ) : (
        <div className="workspace">
          <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
            <FilterBuilder
              variables={variables}
              rules={filters}
              setRules={setFilters}
              matchMode={matchMode}
              setMatchMode={setMatchMode}
              filteredCount={filteredCount}
              filterCountPending={serverFilterPending}
              totalCount={filterTotalCount}
              onClear={handleClearFilters}
              serverSide={dataset.server_paged}
            />

            {dataset.server_paged && (
              <div className="alert alert-warning">
                {dataset.cache_building ? (
                  <>
                    Preparando caché local para acelerar el acceso al archivo completo (
                    {dataset.cache_progress || 0}%). Puedes seguir explorando la muestra mientras
                    termina la indexación.
                  </>
                ) : dataset.cache_error ? (
                  dataset.cache_error
                ) : (
                  <>
                    La carga inicial es una muestra para mantener baja la memoria. El archivo
                    completo se consulta en el servidor y la pestaña Tabla recorre sus filas por
                    páginas.
                  </>
                )}
              </div>
            )}

            <section className="panel dataset-panel">
              <div className="panel-heading">
                <div>
                  <h2>Archivo</h2>
                  <p className="file-name" title={dataset.file_name}>
                    {dataset.file_name}
                  </p>
                </div>
              </div>
              <dl className="dataset-stats">
                <div>
                  <dt>Filas en el archivo</dt>
                  <dd>{dataset.source_row_count.toLocaleString('es-MX')}</dd>
                </div>
                <div>
                  <dt>{dataset.server_paged ? 'Filas de muestra' : 'Filas cargadas'}</dt>
                  <dd>{dataset.row_count.toLocaleString('es-MX')}</dd>
                </div>
                <div>
                  <dt>Variables</dt>
                  <dd>{dataset.column_count.toLocaleString('es-MX')}</dd>
                </div>
              </dl>
              {dataset.warnings?.length > 0 && (
                <div className="alert alert-warning">
                  {dataset.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleCloseDataset}>
                Cerrar archivo
              </button>
            </section>
          </aside>

          <main className="content">
            <div className="dataset-bar">
              <div className="dataset-title">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm sidebar-toggle"
                  onClick={() => setSidebarOpen((open) => !open)}
                >
                  {sidebarOpen ? 'Ocultar filtros' : 'Filtros'}
                </button>
                <div className="dataset-heading">
                  <span className="dataset-kicker">Conjunto de datos activo</span>
                  <h2>{dataset.file_name.replace(/\.(sav|zsav|json)$/i, '')}</h2>
                  <p>
                    {dataset.server_paged
                      ? `${dataset.source_row_count.toLocaleString('es-MX')} filas · muestra de ${dataset.row_count.toLocaleString('es-MX')} · `
                      : `${dataset.row_count.toLocaleString('es-MX')} filas · `}
                    {dataset.column_count.toLocaleString('es-MX')} variables ·{' '}
                    {dataset.file_name.toLowerCase().endsWith('.json')
                      ? 'datos JSON'
                      : 'etiquetas SPSS aplicadas'}
                  </p>
                </div>
              </div>

              <div className="dataset-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleExportCSV}
                  disabled={exporting || (!dataset.server_paged && viewRows.length === 0)}
                >
                  {exporting ? 'Generando…' : dataset.server_paged ? 'Exportar CSV filtrado' : 'Exportar CSV'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleExportJSON}
                  disabled={exporting || (!dataset.server_paged && viewRows.length === 0)}
                >
                  {exporting ? 'Generando…' : dataset.server_paged ? 'Exportar JSON filtrado' : 'Exportar JSON'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleReloadDataset}
                  disabled={reloading}
                >
                  {reloading ? 'Reprocesando…' : 'Recargar ETL'}
                </button>
                {exportProgress && (
                  <div className="export-progress" role="status" aria-live="polite">
                    <div className="export-progress-label">
                      <span>
                        Generando {exportProgress.format.toUpperCase()} ·{' '}
                        {exportProgress.percent}%
                      </span>
                      <span>
                        {exportProgress.completed.toLocaleString('es-MX')} de{' '}
                        {exportProgress.total.toLocaleString('es-MX')} filas procesadas
                      </span>
                    </div>
                    <div
                      className="export-progress-track"
                      role="progressbar"
                      aria-label={`Generando archivo ${exportProgress.format.toUpperCase()}`}
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={exportProgress.percent}
                    >
                      <span style={{ width: `${exportProgress.percent}%` }} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="kpi-grid">
              <Kpi
                label="Filas en archivo"
                value={dataset.source_row_count.toLocaleString('es-MX')}
                hint={dataset.server_paged ? 'Disponible por páginas en Tabla' : 'Archivo completo'}
              />
              <Kpi
                label={activeRuleCount > 0 ? 'Filas filtradas' : 'Filas en vista'}
                value={
                  dataset.server_paged
                    ? serverFilterPending
                      ? 'Calculando…'
                      : filteredCount === null
                        ? '—'
                        : filteredCount.toLocaleString('es-MX')
                    : viewRows.length.toLocaleString('es-MX')
                }
                hint={
                  dataset.server_paged
                    ? activeRuleCount > 0
                      ? 'Coincidencias en todo el archivo'
                      : `${dataset.row_count.toLocaleString('es-MX')} filas en la muestra inicial`
                    : `${visiblePercent}% de las filas cargadas`
                }
                accent
              />
              <Kpi
                label="Variables"
                value={variables.length.toLocaleString('es-MX')}
                hint={`${variables.filter((variable) => variable.has_value_labels).length} con etiquetas de valor`}
              />
              <Kpi
                label="Reglas activas"
                value={activeRuleCount.toLocaleString('es-MX')}
                hint={quickFilter ? 'Búsqueda global activa' : 'Filtros avanzados'}
              />
            </div>

            <nav className="tabs" aria-label="Secciones">
              {TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={tab === item.id ? 'is-active' : ''}
                  onClick={() => handleTabChange(item.id)}
                >
                  {item.label}
                  {item.id === 'table' && (
                    <span className="tab-count">
                      {(dataset.server_paged
                        ? dataset.source_row_count
                        : viewRows.length
                      ).toLocaleString('es-MX')}
                    </span>
                  )}
                  {item.id === 'dictionary' && (
                    <span className="tab-count">{variables.length.toLocaleString('es-MX')}</span>
                  )}
                </button>
              ))}
            </nav>

            <div className="tab-content" style={{ display: tab === 'dashboard' ? 'block' : 'none' }}>
              {visitedTabs.includes('dashboard') && (
                <Suspense fallback={<div className="alert" role="status">Cargando gráficas…</div>}>
                  <ChartPanel
                    rows={dashboardRows}
                    variables={variables}
                    config={chartConfig}
                    setConfig={setChartConfig}
                    active={tab === 'dashboard'}
                    serverPaged={dataset.server_paged}
                    filteredTotal={filteredCount}
                    filterPending={serverFilterPending}
                  />
                </Suspense>
              )}
            </div>

            <div className="tab-content" style={{ display: tab === 'table' ? 'block' : 'none' }}>
              {visitedTabs.includes('table') && (
                <Suspense fallback={<div className="alert" role="status">Cargando tabla…</div>}>
                  <DataTable
                    rows={advancedRows}
                    variables={variables}
                    rules={filters}
                    matchMode={matchMode}
                    datasetKey={dataset.id}
                    resetToken={resetToken}
                    quickFilter={quickFilter}
                    setQuickFilter={setQuickFilter}
                    onViewRowsChange={dataset.server_paged ? setPagedRows : setViewRows}
                    onFilteredTotalChange={handleFilteredTotalChange}
                    onDatasetUnavailable={handleDatasetUnavailable}
                    cacheBuilding={dataset.cache_building}
                    active={tab === 'table'}
                    serverPaged={dataset.server_paged}
                    sourceRowCount={dataset.source_row_count}
                  />
                </Suspense>
              )}
            </div>

            <div className="tab-content" style={{ display: tab === 'diagrams' ? 'block' : 'none' }}>
              {visitedTabs.includes('diagrams') && (
                <Suspense fallback={<div className="alert" role="status">Cargando diagramas…</div>}>
                  <DiagramPanel
                    dataset={dataset}
                    variables={variables}
                    filters={filters}
                    matchMode={matchMode}
                    quickFilter={quickFilter}
                    advancedCount={advancedRows.length}
                    viewCount={viewRows.length}
                    chartConfig={chartConfig}
                  />
                </Suspense>
              )}
            </div>

            <div className="tab-content" style={{ display: tab === 'dictionary' ? 'block' : 'none' }}>
              <DictionaryTable variables={variables} sampled={dataset.server_paged} />
            </div>
          </main>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
