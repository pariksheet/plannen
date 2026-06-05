// Password is percent-encoded; ref and region are already URL-safe per Supabase constraints.
export function buildPoolerUrl({ projectRef, region, password }) {
  if (!projectRef) throw new Error('buildPoolerUrl: projectRef is required')
  if (!region) throw new Error('buildPoolerUrl: region is required')
  if (!password) throw new Error('buildPoolerUrl: password is required')
  const pw = encodeURIComponent(password)
  return `postgresql://postgres.${projectRef}:${pw}@aws-0-${region}.pooler.supabase.com:6543/postgres`
}
