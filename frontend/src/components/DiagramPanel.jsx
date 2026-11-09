import { useState } from 'react'
import { CASES_SECTION, ER_SECTION } from '../lib/diagrams.js'
import AutoDiagrams from './diagrams/AutoDiagrams.jsx'
import DiagramWorkspace from './diagrams/DiagramWorkspace.jsx'

const MODES = [
  { id: 'auto', label: 'Automático' },
  { id: 'manual', label: 'Manual' },
]

const MANUAL_SECTIONS = [
  { id: ER_SECTION, label: 'Entidad-relación' },
  { id: CASES_SECTION, label: 'Casos / flujo' },
]

export default function DiagramPanel(props) {
  const { dataset, variables } = props
  const [mode, setMode] = useState('auto')
  const [section, setSection] = useState(ER_SECTION)

  return (
    <section className="panel diagram-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">Modelado</span>
          <h2>Diagramas</h2>
          <p>
            {mode === 'auto'
              ? 'Vistas de solo lectura generadas desde el archivo y el estado actual. Exportables a Mermaid, draw.io o SVG.'
              : 'Editor manual para diagramas que no se pueden inferir de los datos: entidades y casos de uso.'}
          </p>
        </div>
        <span className="badge">{(variables?.length || 0).toLocaleString('es-MX')} variables</span>
      </div>

      <div className="tabs diagram-mode-tabs" role="tablist" aria-label="Modo de diagramas">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            className={mode === item.id ? 'is-active' : ''}
            onClick={() => setMode(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {mode === 'auto' ? (
        <AutoDiagrams
          dataset={dataset}
          variables={variables}
          filters={props.filters}
          matchMode={props.matchMode}
          quickFilter={props.quickFilter}
          advancedCount={props.advancedCount}
          viewCount={props.viewCount}
          chartConfig={props.chartConfig}
        />
      ) : (
        <>
          <div className="tabs diagram-tabs" role="tablist" aria-label="Secciones del editor">
            {MANUAL_SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={section === item.id}
                className={section === item.id ? 'is-active' : ''}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <DiagramWorkspace
            key={`${dataset.id}-${section}`}
            dataset={dataset}
            variables={variables}
            section={section}
            filters={props.filters}
            matchMode={props.matchMode}
            quickFilter={props.quickFilter}
            advancedCount={props.advancedCount}
            viewCount={props.viewCount}
            chartConfig={props.chartConfig}
          />
        </>
      )}
    </section>
  )
}
