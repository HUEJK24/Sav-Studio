import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import {
  CASES_SECTION,
  createCaseNode,
  createEntityNode,
  createLaneNode,
  datasetSignature,
  exportDiagramFile,
  loadDiagram,
  parseDiagramFile,
  saveDiagram,
  seedCaseDiagram,
  seedEntityDiagram,
} from '../../lib/diagrams.js'
import { diagramSvgElement } from '../../lib/diagramExport.js'
import { downloadDataUrl, downloadPdfFromSvg, svgToPngDataUrl } from '../../lib/imageExport.js'
import { CaseNode, EntityNode, LaneNode } from './nodes.jsx'

const NODE_TYPES = { entity: EntityNode, case: CaseNode, lane: LaneNode }
const EDGE_DEFAULTS = { type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } }
const ER_TOOLS = ['entity']
const CASE_TOOLS = ['actor', 'usecase', 'process', 'decision', 'lane']
const TOOL_LABELS = {
  entity: 'Entidad',
  actor: 'Actor',
  usecase: 'Caso de uso',
  process: 'Proceso',
  decision: 'Decisión',
  lane: 'Carril',
}

function emptyDiagram() {
  return { nodes: [], edges: [] }
}

function diagramBaseName(fileName) {
  return (
    String(fileName || 'dataset')
      .replace(/\.(sav|zsav)$/i, '')
      .replace(/[^\w\-. ]+/g, '_')
      .trim() || 'dataset'
  )
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function withLanesFirst(list) {
  return [
    ...list.filter((node) => node.type === 'lane'),
    ...list.filter((node) => node.type !== 'lane'),
  ]
}

function absolutePosition(node, byId) {
  const position = { ...node.position }
  let parentId = node.parentId
  let guard = 0
  while (parentId && guard < 20) {
    const parent = byId.get(parentId)
    if (!parent) break
    position.x += parent.position.x
    position.y += parent.position.y
    parentId = parent.parentId
    guard += 1
  }
  return position
}

function WorkspaceInner({
  dataset,
  variables,
  section,
  filters,
  matchMode,
  quickFilter,
  advancedCount,
  viewCount,
  chartConfig,
}) {
  const canvasRef = useRef(null)
  const fileInputRef = useRef(null)
  const [busy, setBusy] = useState('')
  const [exportError, setExportError] = useState('')
  const { fitView, getNodes, screenToFlowPosition } = useReactFlow()
  const storageId = datasetSignature(dataset)

  const initial = useMemo(() => {
    const stored = loadDiagram(storageId, section)
    if (stored) return stored
    if (section === CASES_SECTION) return emptyDiagram(section)
    return seedEntityDiagram(dataset, variables)
  }, [dataset, section, storageId, variables])

  const [nodes, setNodes, onNodesChange] = useNodesState(withLanesFirst(initial.nodes))
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)

  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges

  useEffect(() => {
    const timer = setTimeout(() => saveDiagram(storageId, section, { nodes, edges }), 350)
    return () => clearTimeout(timer)
  }, [nodes, edges, storageId, section])

  useEffect(
    () => () =>
      saveDiagram(storageId, section, { nodes: nodesRef.current, edges: edgesRef.current }),
    [storageId, section],
  )

  useEffect(() => {
    const timer = setTimeout(
      () => fitView({ padding: 0.18, duration: 250, minZoom: 0.001 }),
      120,
    )
    return () => clearTimeout(timer)
  }, [fitView])

  const viewportCenter = useCallback(() => {
    const element = canvasRef.current
    if (!element) return { x: 0, y: 0 }
    const rect = element.getBoundingClientRect()
    return screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    })
  }, [screenToFlowPosition])

  const addNode = useCallback(
    (kind) => {
      const center = viewportCenter()
      setNodes((current) => {
        if (kind === 'entity') {
          const count = current.filter((node) => node.type === 'entity').length + 1
          return [...current, createEntityNode({ x: center.x - 135, y: center.y - 60 }, count)]
        }
        if (kind === 'lane') {
          const count = current.filter((node) => node.type === 'lane').length + 1
          return [...current, createLaneNode(center, count)]
        }
        const count =
          current.filter((node) => node.type === 'case' && node.data?.kind === kind).length + 1
        return [...current, createCaseNode(kind, { x: center.x - 90, y: center.y - 30 }, count)]
      })
    },
    [setNodes, viewportCenter],
  )

  const onConnect = useCallback(
    (connection) => {
      setEdges((current) => addEdge({ ...connection, ...EDGE_DEFAULTS }, current))
    },
    [setEdges],
  )

  const handleGenerate = useCallback(() => {
    const confirmed = window.confirm(
      section === CASES_SECTION
        ? 'Esto reemplaza los casos actuales con un flujo generado desde el archivo y los filtros. ¿Continuar?'
        : 'Esto reemplaza el diagrama actual con todas las variables del archivo. ¿Continuar?',
    )
    if (!confirmed) return
    const seeded =
      section === CASES_SECTION
        ? seedCaseDiagram(dataset, variables, {
            filters,
            matchMode,
            quickFilter,
            advancedCount,
            viewCount,
            chartConfig,
          })
        : seedEntityDiagram(dataset, variables)
    setNodes(withLanesFirst(seeded.nodes))
    setEdges(seeded.edges)
    setTimeout(
      () => fitView({ padding: 0.18, duration: 300, minZoom: 0.001 }),
      80,
    )
  }, [
    dataset,
    variables,
    section,
    filters,
    matchMode,
    quickFilter,
    advancedCount,
    viewCount,
    chartConfig,
    setNodes,
    setEdges,
    fitView,
  ])

  const handleClear = useCallback(() => {
    if (!window.confirm('¿Eliminar todos los nodos y relaciones del diagrama?')) return
    setNodes([])
    setEdges([])
  }, [setNodes, setEdges])

  const handleExport = useCallback(() => {
    exportDiagramFile(dataset.file_name, section, { nodes, edges })
  }, [dataset.file_name, section, nodes, edges])

  const buildSvg = useCallback(
    () =>
      diagramSvgElement(getNodes(), edgesRef.current, {
        title: `${diagramBaseName(dataset.file_name)} · ${section === CASES_SECTION ? 'Casos y flujo' : 'Entidad-relación'}`,
        subtitle: `${variables.length.toLocaleString('es-MX')} variables · ${(viewCount || 0).toLocaleString('es-MX')} filas visibles`,
      }),
    [dataset.file_name, getNodes, section, variables.length, viewCount],
  )

  const handleExportSvg = useCallback(() => {
    setExportError('')
    try {
      const svg = buildSvg()
      const source = new XMLSerializer().serializeToString(svg)
      downloadBlob(
        new Blob([source], { type: 'image/svg+xml;charset=utf-8' }),
        `${diagramBaseName(dataset.file_name)}_${section}.svg`,
      )
    } catch (error) {
      setExportError(error.message || 'No se pudo exportar el SVG.')
    }
  }, [buildSvg, dataset.file_name, section])

  const handleExportPng = useCallback(async () => {
    if (busy) return
    setBusy('png')
    setExportError('')
    try {
      const svg = buildSvg()
      const { dataUrl } = await svgToPngDataUrl(svg)
      downloadDataUrl(dataUrl, `${diagramBaseName(dataset.file_name)}_${section}.png`)
    } catch (error) {
      setExportError(error.message || 'No se pudo exportar el PNG.')
    } finally {
      setBusy('')
    }
  }, [busy, buildSvg, dataset.file_name, section])

  const handleExportPdf = useCallback(async () => {
    if (busy) return
    setBusy('pdf')
    setExportError('')
    try {
      const svg = buildSvg()
      await downloadPdfFromSvg(svg, `${diagramBaseName(dataset.file_name)}_${section}`)
    } catch (error) {
      setExportError(error.message || 'No se pudo exportar el PDF.')
    } finally {
      setBusy('')
    }
  }, [busy, buildSvg, dataset.file_name, section])

  const handleImport = useCallback(
    (event) => {
      const file = event.target.files?.[0]
      if (!file) return
      file
        .text()
        .then((text) => {
          const diagram = parseDiagramFile(text)
          setNodes(withLanesFirst(diagram.nodes))
          setEdges(diagram.edges)
          setTimeout(() => fitView({ padding: 0.18, duration: 300 }), 80)
        })
        .catch((error) => window.alert(error.message || 'No se pudo importar el diagrama.'))
        .finally(() => {
          event.target.value = ''
        })
    },
    [setNodes, setEdges, fitView],
  )

  const onNodeDoubleClick = useCallback(
    (event, node) => {
      const next = window.prompt('Título del nodo', node.data?.title || '')
      if (next === null) return
      const title = next.trim()
      if (!title) return
      setNodes((current) =>
        current.map((item) =>
          item.id === node.id ? { ...item, data: { ...item.data, title } } : item,
        ),
      )
    },
    [setNodes],
  )

  const onNodeDragStop = useCallback(
    (event, dragged) => {
      if (!dragged || dragged.type === 'lane') return
      const all = getNodes()
      const byId = new Map(all.map((node) => [node.id, node]))
      const absolute = absolutePosition(dragged, byId)
      const width = dragged.measured?.width || dragged.width || 160
      const height = dragged.measured?.height || dragged.height || 60
      const centerX = absolute.x + width / 2
      const centerY = absolute.y + height / 2

      const lane = all.find((node) => {
        if (node.type !== 'lane' || node.id === dragged.id) return false
        const laneWidth = node.data?.width || node.width || node.measured?.width || 560
        const laneHeight = node.data?.height || node.height || node.measured?.height || 360
        return (
          centerX >= node.position.x &&
          centerX <= node.position.x + laneWidth &&
          centerY >= node.position.y &&
          centerY <= node.position.y + laneHeight
        )
      })

      if (lane) {
        if (dragged.parentId === lane.id) return
        setNodes((current) =>
          withLanesFirst(
            current.map((node) =>
              node.id === dragged.id
                ? {
                    ...node,
                    parentId: lane.id,
                    position: { x: absolute.x - lane.position.x, y: absolute.y - lane.position.y },
                  }
                : node,
            ),
          ),
        )
        return
      }

      if (dragged.parentId) {
        setNodes((current) =>
          withLanesFirst(
            current.map((node) =>
              node.id === dragged.id
                ? { ...node, parentId: undefined, position: absolute }
                : node,
            ),
          ),
        )
      }
    },
    [getNodes, setNodes],
  )

  const tools = section === CASES_SECTION ? CASE_TOOLS : ER_TOOLS
  const helpText =
    section === CASES_SECTION
      ? 'Conecta nodos arrastrando desde un punto. Suelta un nodo dentro de un carril para agruparlo. Doble clic renombra.'
      : 'Arrastra desde el punto de un nodo para crear una relación. Doble clic renombra la entidad.'

  return (
    <div className="diagram-workspace">
      <div className="diagram-toolbar">
        {tools.map((tool) => (
          <button
            key={tool}
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => addNode(tool)}
          >
            + {TOOL_LABELS[tool]}
          </button>
        ))}
        <button type="button" className="btn btn-primary btn-sm" onClick={handleGenerate}>
          {section === CASES_SECTION ? 'Generar casos desde .sav' : 'Generar datos desde .sav'}
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleExport}>
          Exportar JSON
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={handleExportSvg}
          disabled={!nodes.length}
        >
          Exportar SVG
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={handleExportPng}
          disabled={!nodes.length || Boolean(busy)}
        >
          {busy === 'png' ? 'Generando…' : 'Exportar PNG'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={handleExportPdf}
          disabled={!nodes.length || Boolean(busy)}
        >
          {busy === 'pdf' ? 'Generando…' : 'Exportar PDF'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => fileInputRef.current?.click()}
        >
          Importar
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => fitView({ padding: 0.18, duration: 250, minZoom: 0.001 })}
        >
          Ajustar
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={handleClear}>
          Limpiar
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={handleImport}
        />
      </div>

      {exportError && <p className="diagram-export-error">{exportError}</p>}

      <div className="diagram-canvas" ref={canvasRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onNodeDoubleClick={onNodeDoubleClick}
          nodeTypes={NODE_TYPES}
          defaultEdgeOptions={EDGE_DEFAULTS}
          deleteKeyCode={['Backspace', 'Delete']}
          minZoom={0.001}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d9d2c6" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeStrokeWidth={2} />
          <Panel position="top-left" className="diagram-help">
            {helpText}
          </Panel>
        </ReactFlow>
        {!nodes.length && (
          <div className="diagram-empty">
            <div>
              <strong>Diagrama vacío</strong>
              {section === CASES_SECTION
                ? 'Añade un actor, un caso de uso o un carril para empezar.'
                : 'Añade una entidad o genera el modelo desde las variables del archivo.'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function DiagramWorkspace(props) {
  return (
    <ReactFlowProvider>
      <WorkspaceInner {...props} />
    </ReactFlowProvider>
  )
}
