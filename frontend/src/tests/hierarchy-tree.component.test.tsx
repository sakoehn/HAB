/**
 * hierarchy-tree.component.test.tsx
 * ===================================
 * Component tests for HierarchyTree (components/hierarchy/HierarchyTree.tsx)
 * -- the read-only browse tree used inside the KEGG/COG/Enzyme hierarchy
 * popup. Purely presentational (nodes/highlightId/onToggleExpand are all
 * props, no fetching here), so no network mocking is needed -- see
 * hierarchy-modal.component.test.tsx for the fetch-driven auto-expand
 * behaviour this component is meant to display.
 *
 * Coverage
 * --------
 *   empty state
 *   renders node names, nested children when expanded
 *   chevron click calls onToggleExpand with the node
 *   the node matching highlightId gets the highlight class; others don't
 *
 * Run: npx vitest run src/tests/hierarchy-tree.component.test.tsx
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { HierarchyTree } from '../components/hierarchy/HierarchyTree'
import type { HierarchyTreeNode } from '../types'

function makeNode(overrides: Partial<HierarchyTreeNode> = {}): HierarchyTreeNode {
  return {
    annotationId:   'K00844',
    depth:          4,
    name:           'HK; hexokinase',
    category:       'Metabolism',
    expanded:       false,
    loadStatus:     'idle',
    childrenLoaded: false,
    children:       [],
    ...overrides,
  }
}

describe('HierarchyTree — empty state', () => {
  it('shows a message when there are no nodes', () => {
    render(<HierarchyTree nodes={[]} highlightId={null} onToggleExpand={vi.fn()} />)
    expect(screen.getByText('No entries under this node.')).toBeInTheDocument()
  })
})

// A failed root fetch leaves `nodes` empty exactly the same way a
// genuinely childless root would -- they must not render the same
// "No entries under this node." message.
describe('HierarchyTree — root load failure', () => {
  it('shows a distinct error message when status is error, even with zero nodes', () => {
    render(<HierarchyTree nodes={[]} status="error" highlightId={null} onToggleExpand={vi.fn()} />)
    expect(screen.getByText('Failed to load hierarchy tree.')).toBeInTheDocument()
    expect(screen.queryByText('No entries under this node.')).not.toBeInTheDocument()
  })

  it('still shows the real empty-result message when status is ok', () => {
    render(<HierarchyTree nodes={[]} status="ok" highlightId={null} onToggleExpand={vi.fn()} />)
    expect(screen.getByText('No entries under this node.')).toBeInTheDocument()
  })
})

// A failed CHILD fetch (loadStatus:'error' on an already-rendered node, as
// opposed to the root case above) must not look like a never-clicked
// collapsed row -- clicking the chevron again does retry (loadStatus never
// auto-resets), but the user needs to see the previous click failed.
describe('HierarchyTree — per-node child load failure', () => {
  it('shows a warning marker on a node whose child fetch failed', () => {
    render(
      <HierarchyTree nodes={[makeNode({ loadStatus: 'error' })]} highlightId={null} onToggleExpand={vi.fn()} />,
    )
    expect(screen.getByTitle('Failed to load children — click ▸ to retry')).toBeInTheDocument()
  })

  it('does not show a warning marker on a node that was never clicked', () => {
    render(<HierarchyTree nodes={[makeNode({ loadStatus: 'idle' })]} highlightId={null} onToggleExpand={vi.fn()} />)
    expect(screen.queryByTitle('Failed to load children — click ▸ to retry')).not.toBeInTheDocument()
  })
})

describe('HierarchyTree — rendering', () => {
  it('renders a node name', () => {
    render(<HierarchyTree nodes={[makeNode()]} highlightId={null} onToggleExpand={vi.fn()} />)
    expect(screen.getByText('HK; hexokinase')).toBeInTheDocument()
  })

  it('renders nested children only when the parent is expanded', () => {
    const child = makeNode({ annotationId: 'child', name: 'Child Node' })
    const parent = makeNode({ expanded: true, childrenLoaded: true, children: [child] })
    render(<HierarchyTree nodes={[parent]} highlightId={null} onToggleExpand={vi.fn()} />)
    expect(screen.getByText('Child Node')).toBeInTheDocument()
  })

  it('does not render children when the parent is collapsed', () => {
    const child = makeNode({ annotationId: 'child', name: 'Child Node' })
    const parent = makeNode({ expanded: false, childrenLoaded: true, children: [child] })
    render(<HierarchyTree nodes={[parent]} highlightId={null} onToggleExpand={vi.fn()} />)
    expect(screen.queryByText('Child Node')).not.toBeInTheDocument()
  })
})

describe('HierarchyTree — expand interaction', () => {
  it('clicking the chevron calls onToggleExpand with the node', async () => {
    const user = userEvent.setup()
    const onToggleExpand = vi.fn()
    const node = makeNode()
    render(<HierarchyTree nodes={[node]} highlightId={null} onToggleExpand={onToggleExpand} />)

    await user.click(screen.getByTitle('Expand'))
    expect(onToggleExpand).toHaveBeenCalledWith(node)
  })

  it('chevron is disabled while the node is loading', () => {
    render(
      <HierarchyTree nodes={[makeNode({ loadStatus: 'loading' })]} highlightId={null} onToggleExpand={vi.fn()} />,
    )
    // No "Expand"/"Collapse" title while loading -- shows the "…" glyph instead.
    expect(screen.getByText('…')).toBeDisabled()
  })
})

describe('HierarchyTree — highlight', () => {
  it('applies the highlight class to the node matching highlightId', () => {
    render(<HierarchyTree nodes={[makeNode()]} highlightId="K00844" onToggleExpand={vi.fn()} />)
    const row = screen.getByText('HK; hexokinase').closest('.tax-node-row')
    expect(row).toHaveClass('hier-node-highlighted')
  })

  it('does not apply the highlight class to a non-matching node', () => {
    render(<HierarchyTree nodes={[makeNode()]} highlightId="SOME_OTHER_ID" onToggleExpand={vi.fn()} />)
    const row = screen.getByText('HK; hexokinase').closest('.tax-node-row')
    expect(row).not.toHaveClass('hier-node-highlighted')
  })
})

describe('HierarchyTree — selectable rows (Bulk Download browse tree)', () => {
  it('without onSelect, names are plain text (the popup is unchanged)', () => {
    render(<HierarchyTree nodes={[makeNode()]} highlightId={null} onToggleExpand={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /hexokinase/ })).toBeNull()
    expect(screen.getByText('HK; hexokinase')).toBeInTheDocument()
  })

  it('with onSelect, clicking a name (at any depth) selects that node', async () => {
    const onSelect = vi.fn()
    const child = makeNode()
    const parent = makeNode({ annotationId: '00010', depth: 3, name: 'Glycolysis', expanded: true, childrenLoaded: true, children: [child] })
    render(<HierarchyTree nodes={[parent]} highlightId={null} onToggleExpand={vi.fn()} onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: /hexokinase/ }))
    expect(onSelect).toHaveBeenCalledWith(child)
    await userEvent.click(screen.getByRole('button', { name: /Glycolysis/ }))
    expect(onSelect).toHaveBeenLastCalledWith(parent)
  })
})
