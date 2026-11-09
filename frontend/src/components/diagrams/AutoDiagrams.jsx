import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildAnalysisFlow,
  buildVariableMap,
  downloadMermaid,
  mermaidBaseName,
} from '../../lib/autoDiagrams.js'
import {
  downloadDataUrl,
  downloadPdfFromSvg,
  svgToPngDataUrl,
} from '../../lib/imageExport.js'
import MermaidView from './MermaidView.jsx'

const AUTO_VIEWS = [
  { id: 'flow', label: 'Flujo del análisis', fileName: 'flujo' },
  { id: 'variables', label: 'Mapa de variables', fileName: 'mapa_variables' },
]

const MIN_ZOOM = 0.001
const MAX_ZOOM = 3
const EDGE_MARGIN = 48

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export default function AutoDiagrams({
  dataset,
  variables,
  filters,
  matchMode,
  quickFilter,
  advancedCount,
  viewCount,
  chartConfig,
}) {
  const [view, setView] = useState('flow')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState('')
  const [exportError, setExportError] = useState('')
  const [panning, setPanning] = useState(false)
  const [renderTick, setRenderTick] = useState(0)
  const [nav, setNav] = useState({ left: false, right: false, up: false, down: false })
  const [stage, setStage] = useState({ x: 0, y: 0, zoom: 1, fitted: true })
  const shellRef = useRef(null)
  const panState = useRef(null)
  const pendingFitRef = useRef(true)
  const fittedRef = useRef(true)
  const codeRef = useRef('')

  const code = useMemo(() => {
    if (view === 'variables') return buildVariableMap(dataset, variables)
    return buildAnalysisFlow({
      dataset,
      variables,
      filters,
      matchMode,
      quickFilter,
      advancedCount,
      viewCount,
      chartConfig,
    })
  }, [
    view,
    dataset,
    variables,
    filters,
    matchMode,
    quickFilter,
    advancedCount,
    viewCount,
    chartConfig,
  ])

  if (codeRef.current !== code) {
    codeRef.current = code
    pendingFitRef.current = true
  }

  const baseName = useMemo(() => mermaidBaseName(dataset?.file_name), [dataset?.file_name])
  const activeView = AUTO_VIEWS.find((item) => item.id === view) || AUTO_VIEWS[0]

  function getSvg() {
    return shellRef.current?.querySelector('.mermaid-canvas svg') || null
  }

  function naturalSize(svg) {
    const box = svg?.viewBox?.baseVal
    if (box && box.width > 0 && box.height > 0) {
      return { width: box.width, height: box.height }
    }
    const rect = svg?.getBoundingClientRect()
    return { width: rect?.width || 0, height: rect?.height || 0 }
  }

  function applyFit() {
    const shell = shellRef.current
    const svg = getSvg()
    if (!shell || !svg) return
    const { width, height } = naturalSize(svg)
    if (!width || !height) return
    const viewportWidth = Math.max(1, shell.clientWidth)
    const viewportHeight = Math.max(1, shell.clientHeight)
    const zoom = Math.max(
      MIN_ZOOM,
      Math.min(
        (viewportWidth - EDGE_MARGIN) / width,
        (viewportHeight - EDGE_MARGIN) / height,
        1,
      ),
    )
    setStage({
      x: (viewportWidth - width * zoom) / 2,
      y: (viewportHeight - height * zoom) / 2,
      zoom,
      fitted: true,
    })
    fittedRef.current = true
    pendingFitRef.current = false
  }

  function refreshStage() {
    if (pendingFitRef.current || fittedRef.current) {
      applyFit()
    }
    setRenderTick((tick) => tick + 1)
  }

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return undefined

    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(refreshStage)
    }

    schedule()

    const mutation = new MutationObserver(schedule)
    mutation.observe(shell, { childList: true, subtree: true })

    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    resize?.observe(shell)
    window.addEventListener('resize', schedule)

    return () => {
      cancelAnimationFrame(frame)
      mutation.disconnect()
      resize?.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [])

  useEffect(() => {
    const shell = shellRef.current
    const svg = getSvg()
    if (!shell || !svg) return
    const { width, height } = naturalSize(svg)
    const { x, y, zoom } = stage
    setNav({
      left: x < -1,
      right: x + width * zoom > shell.clientWidth + 1,
      up: y < -1,
      down: y + height * zoom > shell.clientHeight + 1,
    })
  }, [stage, renderTick])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  function handleExportMermaid() {
    downloadMermaid(code, `${baseName}_${activeView.fileName}`)
  }

  function handleExportSvg() {
    const svg = getSvg()
    if (!svg) return
    const clone = svg.cloneNode(true)
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const source = new XMLSerializer().serializeToString(clone)
    const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })
    triggerDownload(blob, `${baseName}_${activeView.fileName}.svg`)
  }

  async function handleExportPng() {
    if (busy) return
    setBusy('png')
    setExportError('')
    try {
      const { dataUrl } = await svgToPngDataUrl(getSvg())
      downloadDataUrl(dataUrl, `${baseName}_${activeView.fileName}.png`)
    } catch (error) {
      setExportError(error.message || 'No se pudo exportar la imagen.')
    } finally {
      setBusy('')
    }
  }

  async function handleExportPdf() {
    if (busy) return
    setBusy('pdf')
    setExportError('')
    try {
      await downloadPdfFromSvg(getSvg(), `${baseName}_${activeView.fileName}`)
    } catch (error) {
      setExportError(error.message || 'No se pudo exportar el PDF.')
    } finally {
      setBusy('')
    }
  }

  function clampOffset(value, size, viewport, fallback) {
    if (size <= viewport - 2) return fallback
    return clamp(value, viewport - size - EDGE_MARGIN, EDGE_MARGIN)
  }

  function moveStage(directionX, directionY) {
    const shell = shellRef.current
    const svg = getSvg()
    if (!shell || !svg) return
    const { width, height } = naturalSize(svg)
    const stepX = Math.max(90, Math.round(shell.clientWidth * 0.2))
    const stepY = Math.max(70, Math.round(shell.clientHeight * 0.2))

    setStage((current) => {
      const nextX = current.x + directionX * stepX
      const nextY = current.y + directionY * stepY
      return {
        ...current,
        x: clampOffset(nextX, width * current.zoom, shell.clientWidth, current.x),
        y: clampOffset(nextY, height * current.zoom, shell.clientHeight, current.y),
        fitted: false,
      }
    })
    fittedRef.current = false
    pendingFitRef.current = false
  }

  function zoomStage(factor) {
    const shell = shellRef.current
    if (!shell) return
    setStage((current) => {
      const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      const centerX = shell.clientWidth / 2
      const centerY = shell.clientHeight / 2
      const ratio = zoom / current.zoom
      return {
        x: centerX - (centerX - current.x) * ratio,
        y: centerY - (centerY - current.y) * ratio,
        zoom,
        fitted: false,
      }
    })
    fittedRef.current = false
    pendingFitRef.current = false
  }

  function handlePanStart(event) {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button, a, summary')) return
    const shell = shellRef.current
    if (!shell) return
    panState.current = {
      startX: event.clientX,
      startY: event.clientY,
      x: stage.x,
      y: stage.y,
    }
    setPanning(true)
    shell.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }

  function handlePanMove(event) {
    const pan = panState.current
    const shell = shellRef.current
    if (!pan || !shell) return
    const svg = getSvg()
    if (!svg) return
    const { width, height } = naturalSize(svg)
    const nextX = pan.x + (event.clientX - pan.startX)
    const nextY = pan.y + (event.clientY - pan.startY)
    setStage((current) => ({
      ...current,
      x: clampOffset(nextX, width * current.zoom, shell.clientWidth, current.x),
      y: clampOffset(nextY, height * current.zoom, shell.clientHeight, current.y),
      fitted: false,
    }))
    fittedRef.current = false
    pendingFitRef.current = false
  }

  function handlePanEnd(event) {
    const shell = shellRef.current
    panState.current = null
    setPanning(false)
    if (shell?.hasPointerCapture?.(event.pointerId)) {
      shell.releasePointerCapture(event.pointerId)
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      moveStage(1, 0)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      moveStage(-1, 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveStage(0, 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveStage(0, -1)
    }
  }

  return (
    <div className="auto-diagrams">
      <div className="auto-toolbar">
        <div className="tabs diagram-tabs" role="tablist" aria-label="Diagramas automáticos">
          {AUTO_VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              className={view === item.id ? 'is-active' : ''}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="auto-actions">
          <span className="badge badge-accent">Solo lectura</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleCopy}>
            {copied ? 'Copiado' : 'Copiar Mermaid'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleExportMermaid}>
            Exportar .mmd
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleExportSvg}>
            Exportar SVG
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleExportPng}
            disabled={Boolean(busy)}
          >
            {busy === 'png' ? 'Generando…' : 'Exportar PNG'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleExportPdf}
            disabled={Boolean(busy)}
          >
            {busy === 'pdf' ? 'Generando…' : 'Exportar PDF'}
          </button>
        </div>
      </div>

      {exportError && <p className="diagram-export-error">{exportError}</p>}

      <div className="mermaid-frame">
        <div
          className={`mermaid-shell ${panning ? 'is-panning' : ''}`}
          ref={shellRef}
          tabIndex={0}
          role="group"
          aria-label="Visor del diagrama"
          onPointerDown={handlePanStart}
          onPointerMove={handlePanMove}
          onPointerUp={handlePanEnd}
          onPointerCancel={handlePanEnd}
          onLostPointerCapture={handlePanEnd}
          onKeyDown={handleKeyDown}
        >
          <div
            className="mermaid-pan-layer"
            style={{
              transform: `translate(${stage.x}px, ${stage.y}px) scale(${stage.zoom})`,
            }}
          >
            <MermaidView code={code} />
          </div>
        </div>

        <div className="mermaid-nav" role="group" aria-label="Mover y ampliar el diagrama">
          <button
            type="button"
            className="mermaid-nav-button"
            onClick={() => moveStage(1, 0)}
            disabled={!nav.left}
            aria-label="Desplazar a la izquierda"
            title="Desplazar a la izquierda"
          >
            ←
          </button>
          <button
            type="button"
            className="mermaid-nav-button"
            onClick={() => moveStage(0, 1)}
            disabled={!nav.up}
            aria-label="Desplazar arriba"
            title="Desplazar arriba"
          >
            ↑
          </button>
          <button
            type="button"
            className="mermaid-nav-button"
            onClick={() => moveStage(0, -1)}
            disabled={!nav.down}
            aria-label="Desplazar abajo"
            title="Desplazar abajo"
          >
            ↓
          </button>
          <button
            type="button"
            className="mermaid-nav-button"
            onClick={() => moveStage(-1, 0)}
            disabled={!nav.right}
            aria-label="Desplazar a la derecha"
            title="Desplazar a la derecha"
          >
            →
          </button>
          <span className="mermaid-nav-separator" aria-hidden="true" />
          <button
            type="button"
            className="mermaid-nav-button"
            onClick={() => zoomStage(1 / 1.25)}
            aria-label="Reducir zoom"
            title="Reducir zoom"
          >
            −
          </button>
          <span className="mermaid-zoom-value">{Math.round(stage.zoom * 100)}%</span>
          <button
            type="button"
            className="mermaid-nav-button"
            onClick={() => zoomStage(1.25)}
            aria-label="Aumentar zoom"
            title="Aumentar zoom"
          >
            +
          </button>
          <button
            type="button"
            className="mermaid-fit-button"
            onClick={applyFit}
            title="Ajustar todo el diagrama a la ventana"
          >
            Ajustar
          </button>
        </div>
      </div>

      <details className="mermaid-source">
        <summary>Ver código Mermaid</summary>
        <pre>{code}</pre>
      </details>

      <p className="diagram-footnote">
        Este diagrama se genera automáticamente a partir del archivo y del estado actual (filtros,
        variables y tipo de gráfica). Se actualiza solo y se ajusta para verse completo; arrastra,
        usa las flechas o el zoom para revisarlo. Puedes exportarlo como Mermaid, SVG, PNG o PDF.
      </p>
    </div>
  )
}
