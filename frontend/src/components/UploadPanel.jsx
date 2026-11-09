import { useRef, useState } from 'react'
import { uploadSav } from '../api'

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function UploadPanel({ onLoaded, compact = false }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')

  async function handleFile(file) {
    if (!file) return
    if (!/\.(sav|zsav|json)$/i.test(file.name)) {
      setError('Selecciona un archivo .sav, .zsav o un JSON exportado desde la aplicación.')
      return
    }

    setBusy(true)
    setProgress(0)
    setProcessing(false)
    setError('')

    try {
      const dataset = await uploadSav(file, setProgress, () => setProcessing(true))
      onLoaded(dataset)
    } catch (uploadError) {
      setError(uploadError.message)
    } finally {
      setBusy(false)
      setProgress(0)
      setProcessing(false)
    }
  }

  function onDrop(event) {
    event.preventDefault()
    setDragging(false)
    if (busy) return
    handleFile(event.dataTransfer.files?.[0])
  }

  if (compact) {
    return (
      <div className="upload-compact">
        <input
          ref={inputRef}
          type="file"
          accept=".sav,.zsav,.json"
          hidden
          onChange={(event) => {
            handleFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {busy ? (processing ? 'Procesando archivo…' : `Subiendo… ${progress}%`) : 'Cargar otro archivo'}
        </button>
        {error && <span className="upload-error-inline">{error}</span>}
      </div>
    )
  }

  return (
    <div className="upload-wrap">
      <div
        className={`dropzone ${dragging ? 'is-dragging' : ''} ${busy ? 'is-busy' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          if (!busy) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click()
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".sav,.zsav,.json"
          hidden
          onChange={(event) => {
            handleFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />

        <div className="dropzone-icon">
          <UploadIcon />
        </div>
        <h2>
          {busy
            ? processing
              ? 'Leyendo datos del archivo…'
              : `Subiendo archivo… ${progress}%`
            : 'Arrastra tu archivo .sav, .zsav o .json aquí'}
        </h2>
        <p>
          O <span className="link-like">selecciona un archivo</span> desde tu equipo. Los archivos
          SPSS conservan etiquetas y metadatos; también se aceptan JSON exportados como filas.
        </p>

        {busy && (
          <div className="progress">
            <div
              className="progress-bar"
              style={{ width: `${processing ? 100 : progress}%` }}
            />
          </div>
        )}

        <div className="dropzone-meta">
          <span>.sav / .zsav / .json</span>
          <span>Hasta 5 GB (límite predeterminado)</span>
          <span>Procesamiento local</span>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
