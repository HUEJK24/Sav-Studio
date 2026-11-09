import { useCallback, useEffect, useMemo, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { getDatasetRows, queryDatasetRows } from '../api'
import { ruleIsActive } from '../lib/filters'
import CategoryFilter from './CategoryFilter'

const SERVER_PAGE_SIZE = 100

const LOCALE_TEXT = {
  page: 'Página',
  to: 'a',
  of: 'de',
  next: 'Siguiente',
  last: 'Última',
  first: 'Primera',
  previous: 'Anterior',
  loadingOoo: 'Cargando…',
  noRowsToShow: 'No hay filas para mostrar con los filtros actuales.',
  filterOoo: 'Filtrar…',
  equals: 'Igual a',
  notEqual: 'No igual a',
  contains: 'Contiene',
  notContains: 'No contiene',
  startsWith: 'Empieza por',
  endsWith: 'Termina en',
  lessThan: 'Menor que',
  greaterThan: 'Mayor que',
  inRange: 'Entre',
  inRangeStart: 'Desde',
  inRangeEnd: 'Hasta',
  blank: 'Vacío',
  notBlank: 'No vacío',
  andCondition: 'Y',
  orCondition: 'O',
  applyFilter: 'Aplicar',
  resetFilter: 'Limpiar',
  clearFilter: 'Limpiar',
  cancelFilter: 'Cancelar',
  searchOoo: 'Buscar…',
  selectAll: 'Seleccionar todo',
  selectAllSearchResults: 'Seleccionar resultados',
  blanks: 'Vacíos',
}

function widthFor(variable) {
  const labelLength = (variable.label || variable.name).length
  return Math.max(120, Math.min(280, labelLength * 8 + 70))
}

export default function DataTable({
  rows,
  variables,
  rules = [],
  matchMode = 'all',
  datasetKey,
  resetToken,
  quickFilter,
  setQuickFilter,
  onViewRowsChange,
  onFilteredTotalChange,
  onDatasetUnavailable,
  cacheBuilding = false,
  active = true,
  serverPaged = false,
  sourceRowCount = rows.length,
}) {
  const [gridApi, setGridApi] = useState(null)
  const [visibleCount, setVisibleCount] = useState(rows.length)
  const [serverRows, setServerRows] = useState([])
  const [serverPage, setServerPage] = useState(0)
  const [serverTotal, setServerTotal] = useState(sourceRowCount)
  const [pageInput, setPageInput] = useState('1')
  const [serverLoading, setServerLoading] = useState(false)
  const [serverError, setServerError] = useState('')

  const activeRules = useMemo(() => rules.filter(ruleIsActive), [rules])
  const filterSignature = useMemo(
    () => JSON.stringify({ rules: activeRules, matchMode }),
    [activeRules, matchMode],
  )
  const serverFiltered = serverPaged && activeRules.length > 0

  useEffect(() => {
    setServerPage(0)
    setPageInput('1')
    setServerRows([])
    setServerTotal(sourceRowCount)
    setServerError('')
  }, [datasetKey, sourceRowCount])

  useEffect(() => {
    if (serverPaged) setServerPage(0)
  }, [filterSignature, serverPaged])

  useEffect(() => {
    setPageInput(String(serverPage + 1))
  }, [serverPage])

  useEffect(() => {
    if (!serverPaged) return undefined

    let cancelled = false
    setServerRows([])
    setVisibleCount(0)
    setServerLoading(true)
    setServerError('')
    if (active || serverFiltered) onViewRowsChange([])
    onFilteredTotalChange?.(null, Boolean(serverFiltered), true)
    const timer = window.setTimeout(
      () => {
        const request = serverFiltered
          ? queryDatasetRows(datasetKey, {
              rules: activeRules,
              matchMode,
              offset: serverPage * SERVER_PAGE_SIZE,
              limit: SERVER_PAGE_SIZE,
            })
          : getDatasetRows(datasetKey, serverPage * SERVER_PAGE_SIZE, SERVER_PAGE_SIZE)

        request
          .then((payload) => {
            if (cancelled) return
            const total = payload.total ?? sourceRowCount
            setServerRows(payload.rows)
            setVisibleCount(payload.rows.length)
            setServerTotal(total)
            onFilteredTotalChange?.(total, Boolean(serverFiltered))
          })
          .catch((error) => {
            if (!cancelled) {
              if (error.status === 404) {
                onDatasetUnavailable?.()
                return
              }
              setServerError(error.message)
              onFilteredTotalChange?.(null, Boolean(serverFiltered), false)
            }
          })
          .finally(() => {
            if (!cancelled) setServerLoading(false)
          })
      },
      serverFiltered ? 300 : 0,
    )

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    datasetKey,
    serverPage,
    serverPaged,
    cacheBuilding,
    serverFiltered,
    filterSignature,
    matchMode,
    sourceRowCount,
    onFilteredTotalChange,
    onDatasetUnavailable,
    onViewRowsChange,
  ])

  const columnDefs = useMemo(
    () =>
      variables.map((variable) => {
        const hasCategories =
          (variable.has_value_labels || variable.type === 'string') &&
          variable.categories &&
          variable.categories.length > 0 &&
          variable.categories.length <= 200

        let filter = 'agTextColumnFilter'
        if (hasCategories) {
          filter = CategoryFilter
        } else if (variable.type === 'numeric' && !variable.has_value_labels) {
          filter = 'agNumberColumnFilter'
        }

        return {
          field: variable.name,
          headerName: variable.label || variable.name,
          headerTooltip: `${variable.label || variable.name} · ${variable.name}`,
          width: widthFor(variable),
          minWidth: 110,
          filter: serverPaged ? false : filter,
          filterParams:
            !serverPaged && hasCategories ? { categories: variable.categories } : undefined,
          floatingFilter: !serverPaged,
          sortable: !serverPaged,
          resizable: true,
          cellDataType: false,
          wrapHeaderText: true,
          autoHeaderHeight: true,
          valueFormatter: (params) => {
            if (params.value === null || params.value === undefined || params.value === '') {
              return '—'
            }
            if (typeof params.value === 'number') {
              return params.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })
            }
            return params.value
          },
        }
      }),
    [serverPaged, variables],
  )

  const defaultColDef = useMemo(
    () => ({
      sortable: true,
      resizable: true,
      filter: !serverPaged,
      floatingFilter: !serverPaged,
      suppressHeaderMenuButton: false,
    }),
    [serverPaged],
  )

  const emitViewRows = useCallback(
    (api) => {
      if (!api || serverPaged) return
      const data = []
      api.forEachNodeAfterFilter((node) => data.push(node.data))
      setVisibleCount(data.length)
      onViewRowsChange(data)
    },
    [onViewRowsChange, serverPaged],
  )

  function goToPage(event) {
    event.preventDefault()
    const page = Number(pageInput)
    const pageCount = Math.max(1, Math.ceil(serverTotal / SERVER_PAGE_SIZE))
    if (!Number.isInteger(page)) return
    setServerPage(Math.min(pageCount, Math.max(1, page)) - 1)
  }

  useEffect(() => {
    if (serverPaged) {
      if (active || serverFiltered) onViewRowsChange(serverRows)
      return undefined
    }
    if (!gridApi) return undefined
    const timer = setTimeout(() => emitViewRows(gridApi), 0)
    return () => clearTimeout(timer)
  }, [
    active,
    gridApi,
    rows,
    serverPaged,
    cacheBuilding,
    serverFiltered,
    serverRows,
    onViewRowsChange,
    emitViewRows,
  ])

  useEffect(() => {
    if (!gridApi) return
    gridApi.setGridOption('quickFilterText', quickFilter || '')
  }, [gridApi, quickFilter])

  useEffect(() => {
    if (!gridApi) return
    gridApi.setFilterModel(null)
    gridApi.setGridOption('quickFilterText', '')
  }, [gridApi, datasetKey, resetToken])

  useEffect(() => {
    if (!gridApi || !active) return undefined
    const timer = setTimeout(() => {
      try {
        gridApi.checkGridSize()
      } catch {
        // La API cambia entre versiones; el ResizeObserver de AG Grid cubre el caso normal.
      }
      emitViewRows(gridApi)
    }, 60)
    return () => clearTimeout(timer)
  }, [active, gridApi, emitViewRows])

  return (
    <div className="table-section">
      <div className="panel-heading table-heading">
        <div>
          <span className="section-kicker">Datos</span>
          <h2>Tabla interactiva</h2>
          <p>
            {serverPaged
              ? 'Recorre el archivo completo por páginas.'
              : 'Ordena, busca y combina filtros flotantes por columna.'}
          </p>
        </div>
        <span className="badge">
          {serverPaged
            ? `${serverTotal.toLocaleString('es-MX')} filas ${
                serverFiltered ? 'filtradas' : 'en el archivo'
              }`
            : `${rows.length.toLocaleString('es-MX')} filas base`}
        </span>
      </div>

      <div className="table-toolbar">
        {serverPaged ? (
          <div className="table-count">
            {serverLoading
              ? serverFiltered
                ? 'Buscando coincidencias en el archivo completo…'
                : 'Leyendo filas…'
              : serverError
                ? 'No se pudo leer esta página.'
                : `Filas ${(serverPage * SERVER_PAGE_SIZE + (serverRows.length ? 1 : 0)).toLocaleString('es-MX')}–${(serverPage * SERVER_PAGE_SIZE + serverRows.length).toLocaleString('es-MX')} de ${serverTotal.toLocaleString('es-MX')}`}
          </div>
        ) : (
          <>
            <div className="search-field">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
                <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                placeholder="Buscar en toda la tabla…"
                value={quickFilter}
                onChange={(event) => setQuickFilter(event.target.value)}
              />
            </div>
            <span className="table-count">
              {visibleCount.toLocaleString('es-MX')} de {rows.length.toLocaleString('es-MX')} filas
              visibles
            </span>
          </>
        )}
      </div>

      {serverError && (
        <div className="alert alert-error" role="alert">
          {serverError}
        </div>
      )}

      <div className="ag-theme-quartz grid-shell">
        <AgGridReact
          enableCellExpressions={false}
          rowData={serverPaged ? serverRows : rows}
          loading={serverPaged && serverLoading}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          localeText={LOCALE_TEXT}
          onGridReady={(event) => setGridApi(event.api)}
          onFilterChanged={(event) => emitViewRows(event.api)}
          onRowDataUpdated={(event) => emitViewRows(event.api)}
          onFirstDataRendered={(event) => emitViewRows(event.api)}
          pagination={!serverPaged}
          paginationPageSize={50}
          paginationPageSizeSelector={[25, 50, 100, 250]}
          animateRows={false}
          enableCellTextSelection
          ensureDomOrder
          suppressDragLeaveHidesColumns
          overlayNoRowsTemplate="<span class='grid-empty'>No hay filas que coincidan con los filtros.</span>"
        />
      </div>
      {serverPaged && (
        <div className="table-toolbar">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={serverPage === 0 || serverLoading}
            onClick={() => setServerPage((page) => page - 1)}
          >
            Anterior
          </button>
          <span className="table-count">
            Página {serverPage + 1} de {Math.ceil(serverTotal / SERVER_PAGE_SIZE).toLocaleString('es-MX')}
          </span>
          <form className="table-page-jump" onSubmit={goToPage}>
            <label htmlFor="table-page-number">Ir a página</label>
            <input
              id="table-page-number"
              className="select select-sm"
              type="number"
              min="1"
              max={Math.max(1, Math.ceil(serverTotal / SERVER_PAGE_SIZE))}
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
            />
            <button type="submit" className="btn btn-secondary btn-sm">
              Ir
            </button>
          </form>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={(serverPage + 1) * SERVER_PAGE_SIZE >= serverTotal || serverLoading}
            onClick={() => setServerPage((page) => page + 1)}
          >
            Siguiente
          </button>
        </div>
      )}
    </div>
  )
}
