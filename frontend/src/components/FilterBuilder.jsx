import { useEffect, useMemo, useState } from 'react'
import {
  OPERATOR_LABELS,
  createRule,
  operatorsFor,
  ruleIsActive,
  variableKind,
} from '../lib/filters'

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13M10 11v6m4-6v6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function normalizeCategorySearch(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase()
}

function RuleEditor({ rule, variables, onChange, onRemove }) {
  const variable = variables.find((item) => item.name === rule.field)
  const kind = variableKind(variable)
  const operators = operatorsFor(kind)
  const categories = variable?.categories || []
  const [search, setSearch] = useState('')

  useEffect(() => {
    setSearch('')
  }, [rule.field])

  const filteredCategories = useMemo(() => {
    if (!search.trim()) return categories
    const needle = normalizeCategorySearch(search)
    return categories
      .filter(
        (category) =>
          normalizeCategorySearch(category.label).includes(needle) ||
          normalizeCategorySearch(category.value).includes(needle),
      )
      .sort((left, right) => {
        const leftPrefix =
          normalizeCategorySearch(left.label).startsWith(needle) ||
          normalizeCategorySearch(left.value).startsWith(needle)
        const rightPrefix =
          normalizeCategorySearch(right.label).startsWith(needle) ||
          normalizeCategorySearch(right.value).startsWith(needle)
        return Number(rightPrefix) - Number(leftPrefix)
      })
  }, [categories, search])

  if (!variable) return null

  const selectedValues = new Set((rule.values || []).map((value) => String(value)))

  function changeVariable(name) {
    const nextVariable = variables.find((item) => item.name === name)
    if (!nextVariable) return
    onChange({ ...createRule(nextVariable), id: rule.id })
  }

  function changeOperator(operator) {
    if (operator === 'in' && (!rule.values || rule.values.length === 0)) {
      onChange({
        ...rule,
        operator,
        values: categories.map((category) => category.value),
      })
      return
    }
    onChange({ ...rule, operator })
  }

  function toggleCategory(category) {
    const key = String(category.value)
    const next = selectedValues.has(key)
      ? (rule.values || []).filter((value) => String(value) !== key)
      : [...(rule.values || []), category.value]
    onChange({ ...rule, values: next })
  }

  const active = ruleIsActive(rule)

  return (
    <div className={`filter-rule ${active ? 'is-active' : ''}`}>
      <div className="filter-rule-top">
        <select
          className="select select-sm"
          value={rule.field}
          onChange={(event) => changeVariable(event.target.value)}
          aria-label="Variable del filtro"
        >
          {variables.map((item) => (
            <option key={item.name} value={item.name}>
              {item.label} ({item.name})
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-button"
          onClick={onRemove}
          aria-label="Eliminar filtro"
          title="Eliminar filtro"
        >
          <TrashIcon />
        </button>
      </div>

      <div className="filter-rule-controls">
        <select
          className="select select-sm"
          value={rule.operator}
          onChange={(event) => changeOperator(event.target.value)}
          aria-label="Operador del filtro"
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {OPERATOR_LABELS[operator]}
            </option>
          ))}
        </select>

        {rule.operator === 'isNull' || rule.operator === 'notNull' ? (
          <span className="filter-hint">No requiere valor</span>
        ) : rule.operator === 'between' ? (
          <div className="range-inputs">
            <input
              className="input input-sm"
              type={kind === 'date' ? 'date' : 'number'}
              placeholder="Mínimo"
              value={rule.min ?? ''}
              onChange={(event) => onChange({ ...rule, min: event.target.value })}
            />
            <span>y</span>
            <input
              className="input input-sm"
              type={kind === 'date' ? 'date' : 'number'}
              placeholder="Máximo"
              value={rule.max ?? ''}
              onChange={(event) => onChange({ ...rule, max: event.target.value })}
            />
          </div>
        ) : rule.operator === 'in' ? (
          <div className="category-filter">
            {categories.length === 0 ? (
              <span className="filter-hint">
                Esta variable no tiene una lista de categorías. Usa otro operador.
              </span>
            ) : (
              <>
                {categories.length > 12 && (
                  <input
                    className="input input-sm"
                    type="search"
                    placeholder="Buscar categoría…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                )}
                <div className="category-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      onChange({ ...rule, values: categories.map((category) => category.value) })
                    }
                  >
                    Todos
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onChange({ ...rule, values: [] })}
                  >
                    Ninguno
                  </button>
                  <span className="category-counter">
                    {selectedValues.size} de {categories.length}
                  </span>
                </div>
                <div className="category-list">
                  {filteredCategories.map((category) => (
                    <label className="category-option" key={String(category.value)}>
                      <input
                        type="checkbox"
                        checked={selectedValues.has(String(category.value))}
                        onChange={() => toggleCategory(category)}
                      />
                      <span className="category-label" title={String(category.label)}>
                        {category.label}
                      </span>
                      <span className="category-count">{category.count.toLocaleString('es-MX')}</span>
                    </label>
                  ))}
                  {filteredCategories.length === 0 && (
                    <span className="filter-hint">Sin coincidencias.</span>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <input
            className="input input-sm"
            type={kind === 'numeric' ? 'number' : kind === 'date' ? 'date' : 'text'}
            placeholder={kind === 'numeric' ? 'Valor numérico' : 'Valor'}
            value={rule.value ?? ''}
            onChange={(event) => onChange({ ...rule, value: event.target.value })}
          />
        )}
      </div>
    </div>
  )
}

export default function FilterBuilder({
  variables,
  rules,
  setRules,
  matchMode,
  setMatchMode,
  filteredCount,
  filterCountPending = false,
  totalCount,
  onClear,
  serverSide = false,
}) {
  const [newField, setNewField] = useState('')

  useEffect(() => {
    if (!newField && variables.length > 0) {
      setNewField(variables[0].name)
    }
  }, [variables, newField])

  const activeCount = rules.filter(ruleIsActive).length

  function addRule() {
    const variable = variables.find((item) => item.name === newField) || variables[0]
    if (!variable) return
    setRules((current) => [...current, createRule(variable)])
  }

  function updateRule(id, nextRule) {
    setRules((current) => current.map((rule) => (rule.id === id ? nextRule : rule)))
  }

  function removeRule(id) {
    setRules((current) => current.filter((rule) => rule.id !== id))
  }

  return (
    <section className="panel filter-panel">
      <div className="panel-heading">
        <div>
          <h2>Filtros avanzados</h2>
          <p>Combina reglas y luego refina con los filtros de cada columna.</p>
        </div>
        {activeCount > 0 && <span className="badge badge-accent">{activeCount}</span>}
      </div>

      {serverSide && (
        <div className="alert alert-warning">
          Este archivo es grande: los filtros se aplican en el servidor sobre el archivo completo. La
          primera consulta puede tardar y después se usa una caché.
        </div>
      )}

      <div className="segmented" role="group" aria-label="Modo de combinación de filtros">
        <button
          type="button"
          className={matchMode === 'all' ? 'is-selected' : ''}
          onClick={() => setMatchMode('all')}
        >
          Todas (Y)
        </button>
        <button
          type="button"
          className={matchMode === 'any' ? 'is-selected' : ''}
          onClick={() => setMatchMode('any')}
        >
          Cualquiera (O)
        </button>
      </div>

      <div className="rule-list">
        {rules.map((rule) => (
          <RuleEditor
            key={rule.id}
            rule={rule}
            variables={variables}
            onChange={(nextRule) => updateRule(rule.id, nextRule)}
            onRemove={() => removeRule(rule.id)}
          />
        ))}

        {rules.length === 0 && (
          <div className="empty-note">
            Aún no hay filtros avanzados. Añade uno o usa los filtros flotantes de la tabla.
          </div>
        )}
      </div>

      <div className="add-rule">
        <select
          className="select select-sm"
          value={newField}
          onChange={(event) => setNewField(event.target.value)}
          aria-label="Variable para nuevo filtro"
        >
          {variables.map((variable) => (
            <option key={variable.name} value={variable.name}>
              {variable.label} ({variable.name})
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary btn-sm" onClick={addRule}>
          + Añadir
        </button>
      </div>

      <div className="filter-footer">
        <span>
          <strong>
            {filterCountPending
              ? 'Calculando…'
              : filteredCount === null
                ? '—'
                : filteredCount.toLocaleString('es-MX')}
          </strong>{' '}
          de{' '}
          {totalCount.toLocaleString('es-MX')} filas
        </span>
        <button type="button" className="text-button" onClick={onClear}>
          Limpiar filtros
        </button>
      </div>
    </section>
  )
}
