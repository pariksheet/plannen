import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// `src/lib/supabase.ts` throws at import time if these are unset; without stubs
// any test transitively importing the supabase client fails to load (and the
// suite silently records zero assertions).
vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
vi.stubEnv('VITE_PLANNEN_TIER', '1')
