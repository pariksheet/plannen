// mcp/src/checklists.ts — pure helpers shared by the Tier 0 checklist handlers.

/** Next sequential position for an appended item (max existing + 1, else 0). */
export function nextPosition(items: Array<{ position: number }>): number {
  if (items.length === 0) return 0
  return Math.max(...items.map((i) => i.position)) + 1
}

/** {done,total} for a set of items, where checked_at != null means done. */
export function checklistProgress(
  items: Array<{ checked_at: string | null }>,
): { done: number; total: number } {
  return { done: items.filter((i) => i.checked_at != null).length, total: items.length }
}

/**
 * SQL boolean fragment: "is checklist <idCol> accessible to user <userParam>?"
 * Both MCP servers bypass RLS (privileged connection), so access is enforced
 * here in SQL, not by Postgres policies. Caller substitutes the column name and
 * the bound parameter placeholder (e.g. ACCESSIBLE_CHECKLIST_SQL('c.id', '$1')).
 */
export function accessibleChecklistSql(idCol: string, userParam: string): string {
  return `(
    EXISTS (SELECT 1 FROM plannen.checklists oc
            WHERE oc.id = ${idCol} AND oc.created_by = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_users csu
               WHERE csu.checklist_id = ${idCol} AND csu.user_id = ${userParam})
    OR EXISTS (SELECT 1 FROM plannen.checklist_shared_with_groups csg
               JOIN plannen.friend_group_members fgm ON fgm.group_id = csg.group_id
               WHERE csg.checklist_id = ${idCol} AND fgm.user_id = ${userParam})
  )`
}

/** Stable string form used by the smoke test in checklists.test.ts. */
export const ACCESSIBLE_CHECKLIST_SQL = accessibleChecklistSql('$ID', '$USER')
