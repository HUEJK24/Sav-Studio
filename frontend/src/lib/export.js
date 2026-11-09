import Papa from 'papaparse'

function safeBaseName(name) {
  const cleaned = String(name || 'datos')
    .replace(/\.(sav|zsav)$/i, '')
    .replace(/[^\w\-. ]+/g, '_')
    .trim()
  return cleaned || 'datos'
}

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

export function downloadBlob(blob, fileName) {
  triggerDownload(blob, fileName)
}

function headersFor(variables) {
  const used = new Map()
  return variables.map((variable) => {
    let header = variable.label && variable.label !== variable.name ? variable.label : variable.name
    const count = used.get(header) || 0
    used.set(header, count + 1)
    if (count > 0) header = `${header} (${variable.name})`
    return header
  })
}

const EXPORT_BATCH_SIZE = 500
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0))

export async function downloadCSV(rows, variables, baseName, onProgress) {
  const fields = headersFor(variables)
  const total = rows.length
  const chunks = [`\ufeff${Papa.unparse([fields])}\r\n`]

  for (let offset = 0; offset < total; offset += EXPORT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + EXPORT_BATCH_SIZE)
    const data = batch.map((row) =>
      variables.map((variable) => {
        const value = row[variable.name]
        return value === null || value === undefined ? '' : value
      }),
    )
    chunks.push(Papa.unparse(data))
    const completed = offset + batch.length
    onProgress?.({
      percent: Math.round((completed / total) * 100),
      completed,
      total,
      done: completed === total,
    })
    if (completed < total) {
      chunks.push('\r\n')
      await yieldToBrowser()
    }
  }

  const blob = new Blob(chunks, { type: 'text/csv;charset=utf-8;' })
  triggerDownload(blob, `${safeBaseName(baseName)}_filtrado.csv`)
}

export async function downloadJSON(rows, baseName, onProgress) {
  const total = rows.length
  const chunks = ['[']

  for (let offset = 0; offset < total; offset += EXPORT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + EXPORT_BATCH_SIZE)
    const serialized = batch.map((row) =>
      JSON.stringify(row, null, 2)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    )
    chunks.push(`${offset === 0 ? '\n' : ',\n'}${serialized.join(',\n')}`)
    const completed = offset + batch.length
    onProgress?.({
      percent: Math.round((completed / total) * 100),
      completed,
      total,
      done: completed === total,
    })
    if (completed < total) await yieldToBrowser()
  }

  chunks.push(total ? '\n]\n' : ']\n')
  const blob = new Blob(chunks, { type: 'application/json;charset=utf-8;' })
  triggerDownload(blob, `${safeBaseName(baseName)}_filtrado.json`)
}
