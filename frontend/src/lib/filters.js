export const OPERATOR_LABELS = {
  equals: 'Es igual a',
  notEquals: 'No es igual a',
  contains: 'Contiene',
  notContains: 'No contiene',
  startsWith: 'Empieza por',
  endsWith: 'Termina en',
  greaterThan: 'Mayor que',
  greaterThanOrEqual: 'Mayor o igual que',
  lessThan: 'Menor que',
  lessThanOrEqual: 'Menor o igual que',
  between: 'Entre',
  in: 'Está en la lista',
  isNull: 'Está vacío',
  notNull: 'No está vacío',
}

export function variableKind(variable) {
  if (!variable) return 'string'
  if (variable.has_value_labels) return 'categorical'
  if (variable.type === 'numeric') return 'numeric'
  if (variable.type === 'date') return 'date'
  return 'string'
}

export function operatorsFor(kind) {
  switch (kind) {
    case 'categorical':
      return [
        'in',
        'equals',
        'notEquals',
        'contains',
        'notContains',
        'startsWith',
        'isNull',
        'notNull',
      ]
    case 'numeric':
      return [
        'greaterThan',
        'greaterThanOrEqual',
        'lessThan',
        'lessThanOrEqual',
        'between',
        'equals',
        'notEquals',
        'isNull',
        'notNull',
      ]
    case 'date':
      return ['between', 'equals', 'notEquals', 'greaterThan', 'lessThan', 'isNull', 'notNull']
    default:
      return ['contains', 'notContains', 'equals', 'notEquals', 'startsWith', 'endsWith', 'isNull', 'notNull']
  }
}

export function newRuleId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createRule(variable) {
  const kind = variableKind(variable)
  const base = { id: newRuleId(), field: variable.name, kind, operator: 'equals' }

  if (kind === 'categorical') {
    const categories = variable.categories || []
    if (categories.length > 0) {
      return {
        ...base,
        operator: 'in',
        values: categories.slice(0, 300).map((category) => category.value),
      }
    }
    return { ...base, operator: 'contains', value: '' }
  }

  if (kind === 'numeric') {
    return { ...base, operator: 'greaterThan', value: '' }
  }

  if (kind === 'date') {
    return { ...base, operator: 'between', min: '', max: '' }
  }

  return { ...base, operator: 'contains', value: '' }
}

export function ruleIsActive(rule) {
  if (!rule.field || !rule.operator) return false
  if (rule.operator === 'isNull' || rule.operator === 'notNull') return true
  if (rule.operator === 'between') {
    return String(rule.min ?? '') !== '' || String(rule.max ?? '') !== ''
  }
  if (rule.operator === 'in') {
    return true
  }
  return String(rule.value ?? '') !== ''
}

function isEmpty(value) {
  return value === null || value === undefined || value === ''
}

function asNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() === '') return NaN
  return Number(value)
}

function asTime(value) {
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? NaN : time
}

function normalizeText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function equalsValue(value, expected, kind) {
  if (kind === 'numeric') {
    const left = asNumber(value)
    const right = asNumber(expected)
    return !Number.isNaN(left) && !Number.isNaN(right) && left === right
  }
  if (kind === 'date') {
    return asTime(value) === asTime(expected)
  }
  return normalizeText(value) === normalizeText(expected)
}

export function testRule(value, rule) {
  if (rule.operator === 'isNull') return isEmpty(value)
  if (rule.operator === 'notNull') return !isEmpty(value)
  if (isEmpty(value)) return false

  const text = String(value)
  const needle = String(rule.value ?? '')

  switch (rule.operator) {
    case 'equals':
      return equalsValue(value, rule.value, rule.kind)
    case 'notEquals':
      return !equalsValue(value, rule.value, rule.kind)
    case 'contains':
      return normalizeText(text).includes(normalizeText(needle))
    case 'notContains':
      return !normalizeText(text).includes(normalizeText(needle))
    case 'startsWith':
      return normalizeText(text).startsWith(normalizeText(needle))
    case 'endsWith':
      return normalizeText(text).endsWith(normalizeText(needle))
    case 'greaterThan':
      return rule.kind === 'date'
        ? asTime(value) > asTime(rule.value)
        : asNumber(value) > asNumber(rule.value)
    case 'greaterThanOrEqual':
      return asNumber(value) >= asNumber(rule.value)
    case 'lessThan':
      return rule.kind === 'date'
        ? asTime(value) < asTime(rule.value)
        : asNumber(value) < asNumber(rule.value)
    case 'lessThanOrEqual':
      return asNumber(value) <= asNumber(rule.value)
    case 'between': {
      const hasMin = String(rule.min ?? '') !== ''
      const hasMax = String(rule.max ?? '') !== ''
      if (rule.kind === 'date') {
        const current = asTime(value)
        if (Number.isNaN(current)) return false
        if (hasMin && current < asTime(rule.min)) return false
        if (hasMax && current > asTime(rule.max)) return false
        return true
      }
      const current = asNumber(value)
      if (Number.isNaN(current)) return false
      if (hasMin && current < asNumber(rule.min)) return false
      if (hasMax && current > asNumber(rule.max)) return false
      return true
    }
    case 'in':
      return (rule.values || []).some((item) => normalizeText(item) === normalizeText(text))
    default:
      return true
  }
}

export function applyFilters(rows, rules, matchMode = 'all') {
  const activeRules = rules.filter(ruleIsActive)
  if (activeRules.length === 0) return rows

  return rows.filter((row) => {
    const evaluate = (rule) => testRule(row[rule.field], rule)
    return matchMode === 'any'
      ? activeRules.some(evaluate)
      : activeRules.every(evaluate)
  })
}
