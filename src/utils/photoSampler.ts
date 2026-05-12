export function samplePhotosForVision<T>(items: T[], maxImages: number = 5): T[] {
  const n = items.length
  if (n === 0) return []
  const nVision = Math.min(Math.ceil(n / 2), maxImages)
  if (nVision >= n) return [...items]
  const out: T[] = []
  for (let i = 0; i < nVision; i++) {
    out.push(items[Math.floor((i * n) / nVision)])
  }
  return out
}
