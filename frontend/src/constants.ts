// ── Constants & Lookup Tables ─────────────────────────────────────────────────
// Pure data and lightweight lookup functions — no React imports.
// All source-color maps, biological label tables, and color allocation logic.

// ── Source styling ─────────────────────────────────────────────────────────

export const SOURCE_COLORS: Record<string, string> = {
  kegg:     'var(--chart-1)',
  cog:      'var(--chart-2)',
  enzyme:   'var(--chart-3)',
  taxonomy: 'var(--chart-4)',
}

export const SOURCE_TAG_CLS: Record<string, string> = {
  kegg:     'chart-1',
  cog:      'chart-2',
  enzyme:   'chart-3',
  taxonomy: 'chart-4',
}

export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
]

// Per-source shade palettes — used to give each new card a distinct hue
// within its source family rather than repeating the same color.
//
// 8 shades per family, cycled modulo 8 (see nextColorForSource below), so
// up to 8 same-source Compare series get distinct colors. Every shade stays
// within the same family's hue so it reads as "another kegg series", not
// an unrelated color.
export const SOURCE_SHADES: Record<string, string[]> = {
  kegg:     ['#56B4E9', '#0090C5', '#89D4F5', '#2B8FC4', '#003D56', '#B3E5FC', '#1C7A9E', '#6FCCF0'],  // sky-blue family
  cog:      ['#CC79A7', '#A0407A', '#E8A8C8', '#B55090', '#6E2452', '#F5CBE0', '#8A3368', '#D98FB8'],  // reddish-purple family
  enzyme:   ['#E69F00', '#B27A00', '#F0BC4D', '#D48A00', '#7A4400', '#FAD98A', '#9C6300', '#EDAA26'],  // orange family
  taxonomy: ['#009E73', '#006B4E', '#4DC9A3', '#007A5A', '#00402E', '#8FE3C8', '#00563D', '#2EB68C'],  // bluish-green/teal family
}

// ── Summed-group colors ─────────────────────────────────────────────────────
// A summed group's line color, by its position among the groups on a chart.
// MultiEgcChart draws with this and Compare's chips show it, so they agree.
// None of these is a SOURCE_SHADES color, so a group never looks like one
// of its own members.
const GROUP_EXTRA_COLORS = ['#D55E00', '#0072B2', '#882255', '#999933', '#332288', '#661100']

export function groupSeriesColor(groupIndex: number): string {
  return groupIndex === 0
    ? 'var(--chart-group)'
    : GROUP_EXTRA_COLORS[(groupIndex - 1) % GROUP_EXTRA_COLORS.length]
}

// ── Color allocation ───────────────────────────────────────────────────────
// Module-level counters cycle through SOURCE_SHADES so successive cards of
// the same source get distinct colors.  Call resetSourceCounters() on reset.

const _sourceCounters: Record<string, number> = {}

export function nextColorForSource(source: string): string {
  const shades = SOURCE_SHADES[source] ?? CHART_COLORS
  const idx    = (_sourceCounters[source] ?? 0) % shades.length
  _sourceCounters[source] = idx + 1
  return shades[idx]
}

// The first shade of `source` that isn't in `used`, so a new series never
// shares a colour with one already on screen. Cycles once every shade is taken.
export function freeColorForSource(source: string, used: readonly string[]): string {
  const shades = SOURCE_SHADES[source] ?? CHART_COLORS
  return shades.find(c => !used.includes(c)) ?? shades[used.length % shades.length]
}

export function resetSourceCounters(): void {
  for (const key of Object.keys(_sourceCounters)) {
    _sourceCounters[key] = 0
  }
}

// ── Biological label lookup tables ─────────────────────────────────────────

export const COG_CATEGORY_LABELS: Record<string, string> = {
  A: 'RNA processing and modification',
  B: 'Chromatin structure and dynamics',
  C: 'Energy production and conversion',
  D: 'Cell cycle control, cell division, chromosome partitioning',
  E: 'Amino acid transport and metabolism',
  F: 'Nucleotide transport and metabolism',
  G: 'Carbohydrate transport and metabolism',
  H: 'Coenzyme transport and metabolism',
  I: 'Lipid transport and metabolism',
  J: 'Translation, ribosomal structure and biogenesis',
  K: 'Transcription',
  L: 'Replication, recombination and repair',
  M: 'Cell wall/membrane/envelope biogenesis',
  N: 'Cell motility',
  O: 'Posttranslational modification, protein turnover, chaperones',
  P: 'Inorganic ion transport and metabolism',
  Q: 'Secondary metabolites biosynthesis, transport and catabolism',
  R: 'General function prediction only',
  S: 'Function unknown',
  T: 'Signal transduction mechanisms',
  U: 'Intracellular trafficking, secretion, and vesicular transport',
  V: 'Defense mechanisms',
  W: 'Extracellular structures',
  X: 'Mobilome: prophages, transposons',
  Y: 'Nuclear structure',
  Z: 'Cytoskeleton',
}

export const ENZYME_CLASS_LABELS: Record<string, string> = {
  '1': 'Oxidoreductases',
  '2': 'Transferases',
  '3': 'Hydrolases',
  '4': 'Lyases',
  '5': 'Isomerases',
  '6': 'Ligases',
  '7': 'Translocases',
}

// Old EC numbers JGI's files use that IUBMB later renumbered, keyed by the
// enzyme node their genes are now credited to -- the reverse of
// FastAPI/api/ec_renumbering.py's TRANSFERRED_EC (kept in step by
// tests/test_ec_renumbered_from_parity.py). A split number goes to the new
// numbers' shared parent (3.6.4.12 and 3.6.4.13 -> 5.6.2), and "3.6.3.-" is
// the retired transmembrane-ATPase sub-subclass, now in class 7.
export const EC_RENUMBERED_FROM: Record<string, string[]> = {
  '1.2.8.2':    ['1.2.99.7'],
  '1.3.5.1':    ['1.3.5.4'],
  '1.4.2.3':    ['1.4.3.24'],
  '1.8.1.22':   ['1.8.99.5'],
  '2.3.3.21':   ['2.3.1.182'],
  '2.4.3.4':    ['2.4.99.4'],
  '2.4.99.28':  ['2.4.1.129'],
  '3.1.21.10':  ['3.1.22.4'],
  '3.5.99.13':  ['4.3.3.2'],
  '3.6.1.75':   ['3.1.3.81'],
  '3.13.2.1':   ['3.3.1.1'],
  '3.13.2.3':   ['3.13.1.8'],
  '4.98.1.1':   ['4.99.1.1'],
  '5.6.1.10':   ['3.6.4.10'],
  '5.6.2':      ['3.6.4.12', '3.6.4.13'],
  '6.2.1.71':   ['2.7.7.58'],
  '7':          ['3.6.3.-'],
  '7.1.1.1':    ['1.6.1.2'],
  '7.2.1.4':    ['2.1.1.86'],
}

// The note shown on an enzyme node whose genes JGI's files list under an
// old, since-renumbered EC number, or null when there is none.
export function ecRenumberedNote(source: string, annotationId: string): string | null {
  if (source !== 'enzyme') return null
  const olds = EC_RENUMBERED_FROM[annotationId]
  if (!olds) return null
  const list = olds.length === 1 ? olds[0] : `${olds.slice(0, -1).join(', ')} and ${olds[olds.length - 1]}`
  const noun = olds.length === 1 ? 'number' : 'numbers'
  return `JGI's annotation files list some of these genes under the old EC ${noun} ${list}, `
    + `which IUBMB has since renumbered. They are counted here, under the current number.`
}

// ── Parent label expansion ─────────────────────────────────────────────────
// Converts raw parent strings (which may be bare codes) into human-readable
// labels for display in tables and chart headers.

export function expandParentLabel(parent: string, source: string): string {
  if (!parent) return parent

  // 'Ungrouped' is a shared cross-source
  // sentinel (ExplorePage.tsx's `r.parent ?? 'Ungrouped'` fallback for a
  // root annotation with no real parent), not a real lineage/category
  // value from any source -- must be handled uniformly BEFORE any
  // source-specific branch below, or a branch that treats its input as a
  // real value (e.g. taxonomy's rank-suffix logic) can mangle it --
  // taxonomy's branch would treat 'Ungrouped' as a 1-segment lineage and
  // show it as "Ungrouped (Domain)".
  if (parent === 'Ungrouped') return parent

  if (source === 'cog') {
    const key = parent.trim().toUpperCase()
    return COG_CATEGORY_LABELS[key] ?? parent
  }

  if (source === 'enzyme') {
    // Only a class's own name is known here; a deeper term names its
    // class as such, so "1.1.1" doesn't read as if it were called
    // "Oxidoreductases".
    const id  = parent.trim()
    const cls = id.split('.')[0]
    if (!ENZYME_CLASS_LABELS[cls]) return parent
    return id === cls
      ? `${parent} · ${ENZYME_CLASS_LABELS[cls]}`
      : `${parent} (class: ${ENZYME_CLASS_LABELS[cls]})`
  }

  if (source === 'taxonomy') {
    // parent is the ancestor's own full lineage-prefix (e.g.
    // "Bacteria;Proteobacteria;Alphaproteobacteria") — show just its bare
    // rank label, not the whole chain. segments[0] is the domain root,
    // which the lineage prefix always carries regardless of how deep it
    // goes. Eukaryota uses the same 8-position Domain..Strain ladder as
    // every other domain (confirmed live via /taxonomy/children — depth 2
    // under Eukaryota is real phyla like Annelida, Arthropoda), so it is
    // not special-cased here.
    const segments = parent.split(';')
    const bareName = segments[segments.length - 1]
    const rank = TAXONOMY_RANK_NAMES[segments.length]
    return rank ? `${bareName} (${rank})` : bareName
  }

  return parent
}

// ── Taxonomy rank names ─────────────────────────────────────────────────────
// depth -> rank name. All four domains (Bacteria, Archaea, Viruses,
// Eukaryota) use the same 8-position Domain..Strain ladder -- confirmed
// live via /taxonomy/children: depth 2 under Eukaryota is real phyla
// (Annelida, Arthropoda, Chordata, ...), same as every other domain.

export const TAXONOMY_RANK_NAMES: Record<number, string> = {
  1: 'Domain',
  2: 'Phylum',
  3: 'Class',
  4: 'Order',
  5: 'Family',
  6: 'Genus',
  7: 'Species',
  8: 'Strain',
}

// domain: the taxon's domain root ("Bacteria" | "Archaea" | "Eukaryota" |
// "Viruses"), when known -- e.g. via taxonomyDomainFromId(annotationId) or
// a node/row's own `category` field. Currently unused by the ladder lookup
// itself (every domain uses the same ladder), kept in the signature since
// callers already resolve and pass it and a future domain-specific rank
// naming difference may need it again.
export function taxonomyRankLabel(depth: number | null): string {
  if (depth == null) return 'Unknown rank'
  return TAXONOMY_RANK_NAMES[depth] ?? `Level ${depth}`
}

// primaryLabelWithCogCategory
// For places that show an annotation by its ID alone, with no name beside
// it (Compare chips, chart legends, group member lists): a bare COG category
// letter ("E") is unreadable on its own, so it also carries its full category
// name ("E · Amino acid transport and metabolism"). Everything else is
// exactly taxonomyAwarePrimaryLabel.
export function primaryLabelWithCogCategory(
  source: string,
  annotationId: string,
  name: string | null | undefined,
): string {
  if (source === 'cog' && COG_CATEGORY_LABELS[annotationId]) {
    return `${annotationId} · ${COG_CATEGORY_LABELS[annotationId]}`
  }
  return taxonomyAwarePrimaryLabel(source, annotationId, name)
}

// ── Taxonomy-aware primary label ────────────────────────────────────────────
// annotation_id is the full lineage-prefix for taxonomy (e.g.
// "Bacteria;Proteobacteria;...;Bosea") — far too crowded to print as the
// headline label everywhere it appears (legends, modal headers, member
// lists). For taxonomy, the bare `name` is what should read as the primary
// label, with the full lineage available on demand (title/hover, or an
// explicit toggle) rather than always inline. For every other source,
// annotation_id already IS the short, meaningful label, so it's unchanged.
export function taxonomyAwarePrimaryLabel(
  source: string,
  annotationId: string,
  name: string | null | undefined,
): string {
  if (source !== 'taxonomy') return annotationId
  if (name) return name
  // `name` isn't always plumbed through (e.g. group-card members) — still
  // recoverable from the id itself, since the bare rank label is always
  // its last lineage segment.
  const segments = annotationId.split(';')
  return segments[segments.length - 1]
}

// ── Navigation items ───────────────────────────────────────────────────────
// Defined here so App.tsx and any future nav component share one source of truth.

import type { Page } from './types'

export const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  {
    id:    'analyze',
    label: 'Analyze',
    icon:  `<svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M12.5 12.5L16 16"/></svg>`,
  },
  {
    id:    'compare',
    label: 'Compare',
    icon:  `<svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2,14 6,8 10,11 14,5"/><polyline points="9,5 14,5 14,10"/></svg>`,
  },
  {
    id:    'explore',
    label: 'Explore',
    icon:  `<svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="10" width="3" height="6" rx="1"/><rect x="7.5" y="6" width="3" height="10" rx="1"/><rect x="13" y="2" width="3" height="14" rx="1"/></svg>`,
  },
  {
    id:    'taxonomy',
    label: 'Taxonomy',
    icon:  `<svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 2v5M9 7L4 14M9 7l5 7M4 14h10"/></svg>`,
  },
  {
    id:    'methods',
    label: 'Methods',
    icon:  `<svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 2h7l3 3v11H4z"/><path d="M7 8h5M7 11h5M7 14h3"/></svg>`,
  },
  {
    id:    'about',
    label: 'About & API',
    icon:  `<svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="9" r="7"/><line x1="9" y1="8" x2="9" y2="13"/><circle cx="9" cy="5.5" r=".75" fill="currentColor" stroke="none"/></svg>`,
  },
]