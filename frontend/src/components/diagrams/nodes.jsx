import { Handle, Position } from '@xyflow/react'

const HANDLE_STYLE = {
  width: 9,
  height: 9,
  background: 'var(--accent)',
  border: '2px solid var(--surface)',
}

function ActorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="7.5"
        r="3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M5.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function EntityNode({ data, selected }) {
  const fields = data.fields || []
  return (
    <div className={`er-node ${data.root ? 'is-root' : ''} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <div className="er-node-header">
        <div className="er-node-heading">
          <span className="er-node-title" title={data.title}>
            {data.title}
          </span>
          {data.subtitle && <span className="er-node-sub">{data.subtitle}</span>}
        </div>
        {data.badge && <span className="badge badge-accent">{data.badge}</span>}
      </div>
      <ul className="er-node-fields">
        {fields.map((field, index) => (
          <li className="er-field" key={`${field.name}-${index}`}>
            <span className="er-field-label" title={field.name}>
              {field.label}
            </span>
            <span className="er-field-type">{field.meta}</span>
          </li>
        ))}
        {data.more > 0 && (
          <li className="er-field er-field-more">+{data.more} variables más</li>
        )}
        {!fields.length && <li className="er-field er-field-empty">Sin atributos</li>}
      </ul>
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
    </div>
  )
}

export function CaseNode({ data, selected }) {
  const kind = data.kind || 'process'

  if (kind === 'actor') {
    return (
      <div className={`case-node kind-actor ${selected ? 'is-selected' : ''}`}>
        <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
        <span className="actor-avatar">
          <ActorIcon />
        </span>
        <span className="case-node-title">{data.title}</span>
        <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      </div>
    )
  }

  return (
    <div className={`case-node kind-${kind} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <span className="case-node-title">{data.title}</span>
      {data.detail && <span className="case-node-detail">{data.detail}</span>}
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
    </div>
  )
}

export function LaneNode({ data, selected }) {
  return (
    <div className={`lane-node ${selected ? 'is-selected' : ''}`}>
      <span className="lane-node-header">{data.title || 'Carril'}</span>
    </div>
  )
}
