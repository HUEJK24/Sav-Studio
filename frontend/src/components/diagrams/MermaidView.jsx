import { useEffect, useId, useRef, useState } from 'react'
import mermaid from 'mermaid'

let initialized = false

function ensureInitialized() {
  if (initialized) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    theme: 'base',
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif',
    themeVariables: {
      primaryColor: '#e9edff',
      primaryTextColor: '#17181c',
      primaryBorderColor: '#c7d0ff',
      lineColor: '#9a9388',
      secondaryColor: '#f7f4ed',
      tertiaryColor: '#fffefb',
      edgeLabelBackground: '#fffefb',
      clusterBkg: '#f7f4ed',
      clusterBorder: '#cfc7b8',
      titleColor: '#17181c',
      fontSize: '13px',
    },
    flowchart: {
      curve: 'basis',
      useMaxWidth: false,
      padding: 12,
      nodeSpacing: 34,
      rankSpacing: 46,
    },
  })
  initialized = true
}

export default function MermaidView({ code }) {
  const reactId = useId()
  const counter = useRef(0)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!code) {
      setSvg('')
      setError('')
      return undefined
    }

    ensureInitialized()
    let cancelled = false
    counter.current += 1
    const safeId = reactId.replace(/[^a-zA-Z0-9_-]/g, '')
    const renderId = `sav-mermaid-${safeId}-${counter.current}`

    mermaid
      .render(renderId, code)
      .then((result) => {
        if (cancelled) return
        setSvg(result.svg)
        setError('')
      })
      .catch((renderError) => {
        if (cancelled) return
        setError(renderError?.message || 'No se pudo renderizar el diagrama.')
      })

    return () => {
      cancelled = true
    }
  }, [code, reactId])

  if (error) {
    return (
      <div className="mermaid-error" role="alert">
        {error}
      </div>
    )
  }

  return (
    <div
      className="mermaid-canvas"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
