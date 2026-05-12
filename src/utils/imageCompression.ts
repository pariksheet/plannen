const MAX_SIZE_BYTES = 500 * 1024 // 500KB
const MAX_DIMENSION = 1600
const DEFAULT_QUALITY = 0.85
const MIN_QUALITY = 0.2

/**
 * Load a File as an HTMLImageElement (for canvas drawing).
 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}

/**
 * Compress an image file to at most maxSizeBytes (default 500KB).
 * Resizes by dimension and reduces JPEG quality as needed.
 * Returns a Blob (JPEG); rejects if image cannot be compressed under the limit.
 */
export async function compressImage(
  file: File,
  maxSizeBytes: number = MAX_SIZE_BYTES
): Promise<Blob> {
  const img = await loadImage(file)
  let width = img.naturalWidth
  let height = img.naturalHeight
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    if (width >= height) {
      height = Math.round((height * MAX_DIMENSION) / width)
      width = MAX_DIMENSION
    } else {
      width = Math.round((width * MAX_DIMENSION) / height)
      height = MAX_DIMENSION
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')
  ctx.drawImage(img, 0, 0, width, height)

  let quality = DEFAULT_QUALITY
  let blob: Blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b!), 'image/jpeg', quality)
  })

  while (blob.size > maxSizeBytes && quality > MIN_QUALITY) {
    quality = Math.max(MIN_QUALITY, quality - 0.15)
    blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', quality)
    })
  }

  if (blob.size > maxSizeBytes) {
    // Try scaling down further
    const scale = Math.sqrt(maxSizeBytes / blob.size)
    const newW = Math.max(100, Math.round(width * scale))
    const newH = Math.max(100, Math.round(height * scale))
    canvas.width = newW
    canvas.height = newH
    ctx.drawImage(img, 0, 0, newW, newH)
    blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.7)
    })
  }

  if (blob.size > maxSizeBytes) {
    throw new Error(`Image could not be compressed under ${maxSizeBytes / 1024}KB. Try a smaller or less detailed image.`)
  }

  return blob
}
