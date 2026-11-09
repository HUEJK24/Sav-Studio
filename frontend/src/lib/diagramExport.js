const COLORS = {
  background: '#fffefb',
  surface: '#ffffff',
  text: '#17181c',
  muted: '#6f6a61',
  border: '#cfc7b8',
  accent: '#2f4bff',
  accentSoft: '#e9edff',
  lane: '#f7f4ed',
  warning: '#fff7e0',
}

const PADDING = 48
const TITLE_SPACE = 54

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function number(value, fallback) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function wrapText(value, maxChars) {
  const text = String(value ?? '').trim()
  if (!text) return ['']
  const words = text.split(/\s+/)
  const lines = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= maxChars) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    if (word.length > maxChars) {
      let rest = word
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars))
        rest = rest.slice(maxChars)
      }
      current = rest
    } else {
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

function absolutePosition(node, byId) {
  const position = { x: node.position?.x || 0, y: node.position?.y || 0 }
  let parentId = node.parentId
  let guard = 0
  while (parentId && guard < 50) {
    const parent = byId.get(parentId)
    if (!parent) break
    position.x += parent.position?.x || 0
    position.y += parent.position?.y || 0
    parentId = parent.parentId
    guard += 1
  }
  return position
}

function entityLayout(node) {
  const data = node.data || {}
  const fields = data.fields || []
  const width = number(node.measured?.width ?? node.width ?? node.style?.width, 270)
  const header = data.subtitle ? 60 : 48
  let fieldsHeight = 10
  const rows = fields.map((field) => {
    const labelLines = wrapText(field.label || field.name, 27)
    const height = Math.max(22, labelLines.length * 14 + 8)
    fieldsHeight += height
    return { field, labelLines, height }
  })
  return {
    width,
    height: Math.max(90, header + fieldsHeight),
    header,
    rows,
    radius: 13,
  }
}

function caseLayout(node) {
  const data = node.data || {}
  const width = number(
    node.measured?.width ?? node.width ?? node.style?.width,
    data.kind === 'actor' ? 120 : 190,
  )
  const titleLines = wrapText(data.title, 26)
  const detailLines = data.detail ? wrapText(data.detail, 30) : []
  const height = Math.max(
    data.kind === 'actor' ? 74 : 54,
    26 + titleLines.length * 16 + detailLines.length * 14 + 14,
  )
  return {
    width,
    height,
    titleLines,
    detailLines,
    radius: data.kind === 'usecase' ? height / 2 : 11,
  }
}

function laneLayout(node) {
  return {
    width: number(
      node.data?.width ?? node.style?.width ?? node.measured?.width,
      560,
    ),
    height: number(
      node.data?.height ?? node.style?.height ?? node.measured?.height,
      360,
    ),
  }
}

function nodeLayout(node) {
  if (node.type === 'lane') return laneLayout(node)
  if (node.type === 'entity') return entityLayout(node)
  return caseLayout(node)
}

function text(lines, x, y, options = {}) {
  const {
    size = 11,
    weight = 400,
    fill = COLORS.text,
    anchor = 'start',
    lineHeight = 14,
    family = 'Inter, Segoe UI, sans-serif',
  } = options
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(line)}</text>`,
    )
    .join('')
}

function renderEntity(node, position) {
  const data = node.data || {}
  const layout = entityLayout(node)
  const { width, height, header, rows } = layout
  const isRoot = Boolean(data.root)
  const parts = [
    `<rect x="${position.x}" y="${position.y}" width="${width}" height="${height}" rx="${layout.radius}" fill="${COLORS.surface}" stroke="${isRoot ? '#b7c2ff' : COLORS.border}" />`,
    `<path d="M ${position.x} ${position.y + header} V ${position.y + layout.radius} Q ${position.x} ${position.y} ${position.x + layout.radius} ${position.y} H ${position.x + width - layout.radius} Q ${position.x + width} ${position.y} ${position.x + width} ${position.y + layout.radius} V ${position.y + header} Z" fill="${isRoot ? COLORS.accentSoft : '#faf8f2'}" />`,
  ]

  const titleLines = wrapText(data.title || 'Entidad', 28)
  const titleY = position.y + 20
  parts.push(
    text(titleLines.slice(0, 2), position.x + 12, titleY, { size: 12.5, weight: 700, lineHeight: 13 }),
  )
  if (data.subtitle) {
    parts.push(
      text([data.subtitle], position.x + 12, titleY + titleLines.slice(0, 2).length * 13 + 2, {
        size: 9.5,
        fill: COLORS.muted,
      }),
    )
  }
  if (data.badge) {
    parts.push(
      text([data.badge], position.x + width - 12, position.y + 20, {
        size: 9,
        weight: 700,
        fill: COLORS.accent,
        anchor: 'end',
      }),
    )
  }

  let rowY = position.y + header + 8
  for (const row of rows) {
    parts.push(
      `<rect x="${position.x + 6}" y="${rowY - 2}" width="${width - 12}" height="${row.height - 2}" rx="5" fill="none" />`,
    )
    parts.push(
      text(row.labelLines, position.x + 12, rowY + 12, {
        size: 10.5,
        weight: 600,
        lineHeight: 13,
      }),
    )
    if (row.field.meta) {
      parts.push(
        text([row.field.meta], position.x + width - 12, rowY + 12, {
          size: 8,
          fill: COLORS.muted,
          anchor: 'end',
        }),
      )
    }
    rowY += row.height
  }

  if (!rows.length) {
    parts.push(
      text(['Sin atributos'], position.x + width / 2, position.y + header + 24, {
        size: 10,
        fill: COLORS.muted,
        anchor: 'middle',
      }),
    )
  }

  return { markup: parts.join(''), width, height }
}

function renderCase(node, position) {
  const data = node.data || {}
  const layout = caseLayout(node)
  const { width, height } = layout
  const kind = data.kind || 'process'
  const fills = {
    usecase: COLORS.accentSoft,
    decision: COLORS.warning,
    actor: COLORS.surface,
    process: COLORS.surface,
  }
  const strokes = {
    usecase: '#c7d0ff',
    decision: '#e6cd93',
    actor: COLORS.border,
    process: COLORS.border,
  }
  const parts = [
    `<rect x="${position.x}" y="${position.y}" width="${width}" height="${height}" rx="${layout.radius}" fill="${fills[kind] || COLORS.surface}" stroke="${strokes[kind] || COLORS.border}" />`,
  ]

  if (kind === 'actor') {
    const centerX = position.x + width / 2
    parts.push(
      `<circle cx="${centerX}" cy="${position.y + 20}" r="9" fill="none" stroke="${COLORS.accent}" stroke-width="1.7" />`,
      `<path d="M ${centerX - 12} ${position.y + 43} C ${centerX - 12} ${position.y + 31} ${centerX + 12} ${position.y + 31} ${centerX + 12} ${position.y + 43}" fill="none" stroke="${COLORS.accent}" stroke-width="1.7" stroke-linecap="round" />`,
    )
    parts.push(
      text(layout.titleLines, centerX, position.y + 60, {
        size: 11,
        weight: 700,
        anchor: 'middle',
      }),
    )
    return { markup: parts.join(''), width, height }
  }

  const titleHeight = layout.titleLines.length * 16
  const detailHeight = layout.detailLines.length * 14
  const contentHeight = titleHeight + detailHeight
  const startY = position.y + (height - contentHeight) / 2 + 14
  parts.push(
    text(layout.titleLines, position.x + width / 2, startY, {
      size: 11,
      weight: 700,
      anchor: 'middle',
      lineHeight: 16,
    }),
  )
  if (layout.detailLines.length) {
    parts.push(
      text(layout.detailLines, position.x + width / 2, startY + titleHeight + 2, {
        size: 9,
        fill: COLORS.muted,
        anchor: 'middle',
        lineHeight: 14,
      }),
    )
  }
  return { markup: parts.join(''), width, height }
}

function renderLane(node, position) {
  const layout = laneLayout(node)
  const parts = [
    `<rect x="${position.x}" y="${position.y}" width="${layout.width}" height="${layout.height}" rx="16" fill="${COLORS.lane}" stroke="${COLORS.border}" />`,
    `<rect x="${position.x}" y="${position.y}" width="${layout.width}" height="34" rx="16" fill="#efeae0" />`,
    `<rect x="${position.x}" y="${position.y + 20}" width="${layout.width}" height="14" fill="#efeae0" />`,
    text([node.data?.title || 'Carril'], position.x + 14, position.y + 22, {
      size: 11,
      weight: 700,
      fill: COLORS.muted,
    }),
  ]
  return { markup: parts.join(''), width: layout.width, height: layout.height }
}

function edgePath(source, target) {
  const sourceCenterY = source.y + source.height / 2
  const targetCenterY = target.y + target.height / 2
  const targetIsRight = target.x >= source.x
  const startX = targetIsRight ? source.x + source.width : source.x
  const endX = targetIsRight ? target.x : target.x + target.width
  const distance = Math.max(50, Math.abs(endX - startX) / 2)
  const c1 = targetIsRight ? startX + distance : startX - distance
  const c2 = targetIsRight ? endX - distance : endX + distance
  return {
    d: `M ${startX} ${sourceCenterY} C ${c1} ${sourceCenterY}, ${c2} ${targetCenterY}, ${endX} ${targetCenterY}`,
    labelX: (startX + endX) / 2,
    labelY: (sourceCenterY + targetCenterY) / 2,
  }
}

function renderEdges(nodes, edges, offsetX, offsetY) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const parts = []
  for (const edge of edges) {
    const sourceNode = byId.get(edge.source)
    const targetNode = byId.get(edge.target)
    if (!sourceNode || !targetNode) continue
    const sourcePosition = absolutePosition(sourceNode, byId)
    const targetPosition = absolutePosition(targetNode, byId)
    const sourceSize = nodeLayout(sourceNode)
    const targetSize = nodeLayout(targetNode)
    const source = {
      x: sourcePosition.x + offsetX,
      y: sourcePosition.y + offsetY,
      width: sourceSize.width,
      height: sourceSize.height,
    }
    const target = {
      x: targetPosition.x + offsetX,
      y: targetPosition.y + offsetY,
      width: targetSize.width,
      height: targetSize.height,
    }
    const path = edgePath(source, target)
    parts.push(
      `<path d="${path.d}" fill="none" stroke="#8a8377" stroke-width="1.6" marker-end="url(#arrow)" />`,
    )
    if (edge.label) {
      const label = String(edge.label)
      const labelWidth = Math.max(26, label.length * 5.6 + 10)
      parts.push(
        `<rect x="${path.labelX - labelWidth / 2}" y="${path.labelY - 9}" width="${labelWidth}" height="18" rx="5" fill="${COLORS.background}" stroke="${COLORS.border}" />`,
        text([label], path.labelX, path.labelY + 4, {
          size: 8.5,
          weight: 600,
          fill: COLORS.muted,
          anchor: 'middle',
        }),
      )
    }
  }
  return parts.join('')
}

export function buildDiagramSvg(nodes = [], edges = [], options = {}) {
  if (!nodes.length) {
    return {
      source:
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#fffefb"/><text x="320" y="180" font-family="Segoe UI, sans-serif" font-size="14" fill="#6f6a61" text-anchor="middle">Diagrama vacío</text></svg>',
      width: 640,
      height: 360,
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const prepared = nodes.map((node) => {
    const position = absolutePosition(node, byId)
    const layout = nodeLayout(node)
    return { node, position, layout }
  })

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const item of prepared) {
    minX = Math.min(minX, item.position.x)
    minY = Math.min(minY, item.position.y)
    maxX = Math.max(maxX, item.position.x + item.layout.width)
    maxY = Math.max(maxY, item.position.y + item.layout.height)
  }

  const offsetX = PADDING - minX
  const offsetY = PADDING + TITLE_SPACE - minY
  const width = Math.max(480, maxX - minX + PADDING * 2)
  const height = Math.max(320, maxY - minY + PADDING * 2 + TITLE_SPACE)

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8a8377" /></marker></defs>`,
    `<rect width="${Math.ceil(width)}" height="${Math.ceil(height)}" fill="${COLORS.background}" />`,
  ]

  if (options.title) {
    parts.push(
      text([options.title], PADDING, PADDING + 16, { size: 16, weight: 700 }),
    )
  }
  if (options.subtitle) {
    parts.push(
      text([options.subtitle], PADDING, PADDING + 36, {
        size: 10.5,
        fill: COLORS.muted,
      }),
    )
  }

  for (const item of prepared) {
    if (item.node.type !== 'lane') continue
    parts.push(
      renderLane(item.node, {
        x: item.position.x + offsetX,
        y: item.position.y + offsetY,
      }).markup,
    )
  }

  parts.push(renderEdges(nodes, edges, offsetX, offsetY))

  for (const item of prepared) {
    if (item.node.type === 'lane') continue
    const position = {
      x: item.position.x + offsetX,
      y: item.position.y + offsetY,
    }
    if (item.node.type === 'entity') {
      parts.push(renderEntity(item.node, position).markup)
    } else {
      parts.push(renderCase(item.node, position).markup)
    }
  }

  parts.push('</svg>')
  return { source: parts.join(''), width: Math.ceil(width), height: Math.ceil(height) }
}

export function diagramSvgElement(nodes, edges, options = {}) {
  const { source } = buildDiagramSvg(nodes, edges, options)
  const documentNode = new DOMParser().parseFromString(source, 'image/svg+xml')
  return documentNode.documentElement
}
