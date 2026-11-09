import { useCallback, useMemo, useRef, useState } from 'react'
import { useGridFilter } from 'ag-grid-react'

function formatCount(count) {
  return Number(count || 0).toLocaleString('es-MX')
}

export default function CategoryFilter(props) {
  const categories = props.categories || props.filterParams?.categories || []
  const allValues = useMemo(
    () => categories.map((category) => String(category.value)),
    [categories],
  )
  const model = props.model
  const selected = useMemo(() => {
    if (!model || !Array.isArray(model.values)) return new Set(allValues)
    return new Set(model.values.map((value) => String(value)))
  }, [model, allValues])

  const activeRef = useRef(false)
  const selectedRef = useRef(selected)
  const getValueRef = useRef(props.getValue)
  activeRef.current = Boolean(model && Array.isArray(model.values))
  selectedRef.current = selected
  getValueRef.current = props.getValue

  const [search, setSearch] = useState('')

  const doesFilterPass = useCallback((params) => {
    if (!activeRef.current) return true
    const value = getValueRef.current(params.node)
    return selectedRef.current.has(String(value))
  }, [])

  const getModelAsString = useCallback((currentModel) => {
    if (!currentModel || !Array.isArray(currentModel.values)) return 'Todos'
    const values = currentModel.values
    if (values.length === 0) return 'Ninguno'
    const shown = values.slice(0, 3).join(', ')
    return values.length > 3 ? `${shown} +${values.length - 3}` : shown
  }, [])

  useGridFilter({ doesFilterPass, getModelAsString })

  function setSelected(nextSelected) {
    if (nextSelected.size === allValues.length) {
      props.onModelChange(null)
      return
    }
    props.onModelChange({ values: [...nextSelected] })
  }

  function toggle(value) {
    const nextSelected = new Set(selected)
    if (nextSelected.has(value)) nextSelected.delete(value)
    else nextSelected.add(value)
    setSelected(nextSelected)
  }

  const needle = search.trim().toLowerCase()
  const filtered = needle
    ? categories.filter(
        (category) =>
          String(category.label).toLowerCase().includes(needle) ||
          String(category.value).toLowerCase().includes(needle),
      )
    : categories

  return (
    <div className="category-filter-popup">
      <input
        className="input input-sm"
        type="search"
        placeholder="Buscar categoría…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      <div className="category-actions">
        <button type="button" className="text-button" onClick={() => props.onModelChange(null)}>
          Todos
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => props.onModelChange({ values: [] })}
        >
          Ninguno
        </button>
        <span className="category-counter">
          {selected.size} de {allValues.length}
        </span>
      </div>

      <div className="category-list category-list-popup">
        {filtered.map((category) => {
          const value = String(category.value)
          return (
            <label className="category-option" key={value}>
              <input
                type="checkbox"
                checked={selected.has(value)}
                onChange={() => toggle(value)}
              />
              <span className="category-label" title={String(category.label)}>
                {category.label}
              </span>
              <span className="category-count">{formatCount(category.count)}</span>
            </label>
          )
        })}
        {filtered.length === 0 && <span className="filter-hint">Sin coincidencias.</span>}
      </div>
    </div>
  )
}
