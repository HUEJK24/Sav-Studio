const API_BASE = import.meta.env.VITE_API_URL || '/api'

function parseError(status, body, statusText = '') {
  let detail = ''
  try {
    const parsed = JSON.parse(body)
    detail = parsed.detail || parsed.message || ''
  } catch {
    detail = body.trim().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 240)
  }
  const error = new Error(
    detail || `El servidor respondió con estado ${status}${statusText ? ` (${statusText})` : ''}.`,
  )
  error.status = status
  return error
}

export function checkHealth() {
  return fetch(`${API_BASE}/health`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
}

export function uploadSav(file, onProgress, onProcessing) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/datasets`)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    }
    xhr.upload.onload = () => onProcessing?.()

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('La respuesta del servidor no es un JSON válido.'))
        }
        return
      }
      reject(parseError(xhr.status, xhr.responseText, xhr.statusText))
    }

    xhr.onerror = () => {
      reject(
        new Error(
          'No se pudo conectar con el backend. Verifica que FastAPI esté corriendo en el puerto 8000.',
        ),
      )
    }

    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

export async function deleteDataset(datasetId) {
  if (!datasetId) return
  await fetch(`${API_BASE}/datasets/${datasetId}`, { method: 'DELETE' }).catch(() => null)
}

export async function reloadDataset(datasetId) {
  if (!datasetId) throw new Error('No hay un archivo activo para reprocesar.')
  const response = await fetch(`${API_BASE}/datasets/${datasetId}/reload`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw parseError(response.status, await response.text(), response.statusText)
  }
  return response.json()
}

export async function getDatasetStatus(datasetId) {
  const response = await fetch(`${API_BASE}/datasets/${datasetId}/status`)
  if (!response.ok) {
    throw parseError(response.status, await response.text(), response.statusText)
  }
  return response.json()
}

export async function getExportProgress(exportId) {
  const response = await fetch(`${API_BASE}/exports/${exportId}/status`)
  if (!response.ok) {
    throw parseError(response.status, await response.text(), response.statusText)
  }
  return response.json()
}

export async function getDatasetRows(datasetId, offset, limit) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  const response = await fetch(`${API_BASE}/datasets/${datasetId}/rows?${params}`)
  if (!response.ok) {
    throw parseError(response.status, await response.text(), response.statusText)
  }
  return response.json()
}

export async function queryDatasetRows(datasetId, { rules, matchMode, offset, limit }) {
  const response = await fetch(`${API_BASE}/datasets/${datasetId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules: rules || [],
      matchMode: matchMode || 'all',
      offset: offset || 0,
      limit: limit || 100,
    }),
  })
  if (!response.ok) {
    throw parseError(response.status, await response.text(), response.statusText)
  }
  return response.json()
}

function fileNameFromDisposition(header, fallback) {
  if (!header) return fallback
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1])
    } catch {
      return fallback
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i)
  return plain ? plain[1] : fallback
}

export async function exportDatasetFile(
  datasetId,
  { rules, matchMode, format, onProgress },
) {
  const response = await fetch(`${API_BASE}/datasets/${datasetId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules: rules || [],
      matchMode: matchMode || 'all',
      format,
    }),
  })
  if (!response.ok) {
    throw parseError(response.status, await response.text())
  }

  const exportId = response.headers.get('X-Export-Progress-Id')
  let polling = true
  let progressError = null
  const monitorProgress = async () => {
    if (!exportId) return
    while (polling) {
      try {
        const progress = await getExportProgress(exportId)
        onProgress?.(progress)
        if (progress.error) {
          progressError = new Error(progress.error)
          return
        }
        if (progress.done) return
      } catch (error) {
        progressError = error
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  const progressTask = monitorProgress()
  const chunks = []
  try {
    if (!response.body) {
      throw new Error('El navegador no pudo leer el archivo generado.')
    }
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (progressError) throw progressError
      if (done) break
      chunks.push(value)
    }
    await progressTask
    if (progressError) throw progressError
  } finally {
    polling = false
    await progressTask
  }

  const blob = new Blob(chunks, {
    type: response.headers.get('Content-Type') || 'application/octet-stream',
  })
  const fileName = fileNameFromDisposition(
    response.headers.get('Content-Disposition'),
    `datos_filtrado.${format}`,
  )
  return { blob, fileName }
}
