// ── Constants & Lookup Tables ─────────────────────────────────────────────────
// Pure data and lightweight lookup functions — no React imports.
// All source-color maps, biological label tables, and color allocation logic.

import type { AnnotationSourceKey } from './types'

// ── Source styling ─────────────────────────────────────────────────────────

export const SOURCE_COLORS: Record<string, string> = {
  kegg:     'var(--chart-1)',
  cog:      'var(--chart-2)',
  enzyme:   'var(--chart-3)',
  taxonomy: 'var(--chart-4)',
}

export const SOURCE_TAG_CLS: Record<string, string> = {
  kegg:     'teal',
  cog:      'violet',
  enzyme:   'amber',
  taxonomy: 'coral',
}

export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
]

// Per-source shade palettes — used to give each new card a distinct hue
// within its source family rather than repeating the same color.
export const SOURCE_SHADES: Record<string, string[]> = {
  kegg:     ['#38d9b4', '#0c9e7a', '#8effe0', '#1ecfaa'],
  cog:      ['#7b8ef0', '#3d4fc8', '#b3bbff', '#5566ff'],
  enzyme:   ['#f0b429', '#b87900', '#ffd97a', '#e09000'],
  taxonomy: ['#e8705a', '#b03520', '#ffaa95', '#cc4430'],
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
  D: 'Cell cycle control, division, chromosome partitioning',
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
  Q: 'Secondary metabolites biosynthesis, transport, catabolism',
  R: 'General function prediction only',
  S: 'Function unknown',
  T: 'Signal transduction mechanisms',
  U: 'Intracellular trafficking, secretion, vesicular transport',
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

// KEGG BRITE top-level numeric category codes → human-readable labels.
// These appear as parent values when the BRITE hierarchy stores only the code.
export const KEGG_BRITE_CODES: Record<string, string> = {
  '00001': 'KEGG Orthology (KO)',
  '00002': 'KEGG Pathway',
  '00003': 'KEGG Module',
  '00004': 'KEGG Network',
  '99976': 'Unclassified metabolism',
  '99977': 'Unclassified cellular processes',
  '99978': 'Unclassified genetic information processing',
  '99979': 'Unclassified environmental information processing',
  '99980': 'Unclassified signaling/cellular processes',
  '99981': 'Function unknown',
  '99982': 'Unclassified',
  '99983': 'Unclassified protein families',
  '99984': 'Unclassified poorly characterized',
  '99985': 'Other ion-coupled transporters',
  '99986': 'Other transporters',
  '99987': 'Other electron carriers',
  '99988': 'Other enzymes',
  '99990': 'Miscellaneous',
  '99995': 'Not included in regular maps',
  '99996': 'Not included in regular maps',
  '99997': 'Unclassified: metabolism',
  '99998': 'Unclassified: genetic information processing',
  '99999': 'Unclassified: cellular processes',
  '02024': 'Transporters',
  '02000': 'Transporters',
  '02044': 'Secretion system',
  '02048': 'Prokaryotic defense system',
  '01000': 'Enzymes',
  '01001': 'Protein kinases',
  '01002': 'Peptidases and inhibitors',
  '01003': 'Glycosyltransferases',
  '01004': 'Lipid biosynthesis proteins',
  '01005': 'Lipopolysaccharide biosynthesis proteins',
  '01007': 'Amino acid related enzymes',
  '01008': 'Polyketide biosynthesis proteins',
  '01009': 'Protein phosphatases and associated proteins',
  '01010': 'Ribosome biogenesis',
  '01011': 'Peptide antibiotics',
  '01012': 'Ubiquitin system',
}

// ── Parent label expansion ─────────────────────────────────────────────────
// Converts raw parent strings (which may be bare codes) into human-readable
// labels for display in tables and chart headers.

export function expandParentLabel(parent: string, source: string): string {
  if (!parent) return parent

  if (source === 'cog') {
    const key = parent.trim().toUpperCase()
    return COG_CATEGORY_LABELS[key]
      ? `${key} · ${COG_CATEGORY_LABELS[key]}`
      : parent
  }

  if (source === 'enzyme') {
    const cls = parent.trim().split('.')[0]
    return ENZYME_CLASS_LABELS[cls]
      ? `${parent} · ${ENZYME_CLASS_LABELS[cls]}`
      : parent
  }

  if (source === 'kegg') {
    // Format: "12345 Some label" — strip leading 5-digit code
    const withoutCode = parent.replace(/^\d{5}\s+/, '').trim()
    if (withoutCode && withoutCode !== parent) return withoutCode

    // Pure numeric code with no label — look up in BRITE table
    const codeOnly = parent.trim()
    if (/^\d{5}$/.test(codeOnly)) {
      return KEGG_BRITE_CODES[codeOnly]
        ? KEGG_BRITE_CODES[codeOnly]
        : `BRITE group ${codeOnly}`
    }
    return parent
  }

  return parent
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
    id:    'about',
    label: 'About & API',
    icon:  `<svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="9" r="7"/><line x1="9" y1="8" x2="9" y2="13"/><circle cx="9" cy="5.5" r=".75" fill="currentColor" stroke="none"/></svg>`,
  },
]