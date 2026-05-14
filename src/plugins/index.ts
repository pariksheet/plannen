import type { ComponentType } from 'react'

export type PluginEntry = {
  /** Display label shown in the nav. */
  label: string
  /** Mount path (e.g. "/kitchen"). Must start with "/" and be unique. */
  route: string
  /** Component rendered when the route is active. */
  Component: ComponentType
}

// Vite glob: eagerly import every .tsx file dropped into this directory.
// Plugins are expected to symlink a single .tsx file in here via their
// install.sh. Each file must default-export a PluginEntry.
const modules = import.meta.glob<{ default: PluginEntry }>('./*.tsx', { eager: true })

export const plugins: PluginEntry[] = Object.values(modules)
  .map(m => m.default)
  .filter((p): p is PluginEntry => Boolean(p && p.route && p.label && p.Component))
  .sort((a, b) => a.label.localeCompare(b.label))
