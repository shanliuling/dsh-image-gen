/** The two gallery tabs that render the selectable grid. */
export type BatchBarTab = 'gallery' | 'studio' | 'inspiration' | 'favorites'

/**
 * The batch bar is a fixed overlay at the page root, so it must only render on
 * the grid tabs; leaving them (studio/inspiration) hides it even if manage mode
 * or a selection somehow survives a tab switch.
 */
export function shouldShowBatchBar(activeTab: BatchBarTab, isManageMode: boolean, selectedCount: number): boolean {
  return (activeTab === 'gallery' || activeTab === 'favorites') && (isManageMode || selectedCount > 0)
}
