const BACKGROUND = '#fffefb'

function svgSize(svg) {
  const rect = svg.getBoundingClientRect()
  const viewBox = svg.viewBox?.baseVal
  const width = Math.max(
    1,
    Math.ceil(viewBox && viewBox.width > 0 ? viewBox.width : rect.width),
  )
  const height = Math.max(
    1,
    Math.ceil(viewBox && viewBox.height > 0 ? viewBox.height : rect.height),
  )
  return { width, height }
}

export async function svgToPngDataUrl(svg, options = {}) {
  if (!svg) throw new Error('No hay un diagrama para exportar.')

  const { width, height } = svgSize(svg)
  const maxCanvas = 9000
  const requestedScale = options.scale ?? 2
  const scale = Math.max(
    1,
    Math.min(requestedScale, maxCanvas / Math.max(width, height)),
  )

  const clone = svg.cloneNode(true)
  clone.removeAttribute('style')
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))

  const source = new XMLSerializer().serializeToString(clone)
  const url = URL.createObjectURL(
    new Blob([source], { type: 'image/svg+xml;charset=utf-8' }),
  )

  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('No se pudo convertir el diagrama a imagen.'))
      element.src = url
    })

    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(width * scale)
    canvas.height = Math.ceil(height * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('El navegador no permite generar la imagen.')

    context.fillStyle = options.background ?? BACKGROUND
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.drawImage(image, 0, 0, width, height)

    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function downloadDataUrl(dataUrl, fileName) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export async function downloadPdfFromSvg(svg, fileName) {
  const { dataUrl, width, height } = await svgToPngDataUrl(svg)
  const { jsPDF } = await import('jspdf')

  const pdf = new jsPDF({
    orientation: width >= height ? 'landscape' : 'portrait',
    unit: 'pt',
    format: 'a4',
  })

  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 28
  const ratio = Math.min(
    (pageWidth - margin * 2) / width,
    (pageHeight - margin * 2) / height,
  )
  const imageWidth = width * ratio
  const imageHeight = height * ratio

  pdf.addImage(
    dataUrl,
    'PNG',
    (pageWidth - imageWidth) / 2,
    (pageHeight - imageHeight) / 2,
    imageWidth,
    imageHeight,
  )
  pdf.save(`${fileName}.pdf`)
}
