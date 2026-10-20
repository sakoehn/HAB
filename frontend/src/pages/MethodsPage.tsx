// ── MethodsPage ───────────────────────────────────────────────────────────────
// How every number in the app is produced and why: annotation types, how genes
// become annotation hierarchies, the EGC / relative-abundance / chart formulas,
// the correlation method, and where the data comes from. Split out of the old
// single About page (UI round 2026-10-14).
//
// Every statement here was checked against the current code, not carried over
// from the old page (which still said "9 lags" and "1000 random shifts" long
// after both had changed). The numbers that can drift live in METHODS_FACTS,
// which tests/test_methods_page_facts.py checks against the backend's config.
// No props, no state -- purely informational.

import type { ReactNode } from 'react'
import { LOWESS_BANDWIDTH_MIN, LOWESS_BANDWIDTH_MAX } from '../components/charts/ChartControls'

export const METHODS_FACTS = {
  // FastAPI/api/config.py CORRELATION_LAGS / LAG_HOURS_PER_SAMPLE
  correlationLags: [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6],
  lagHoursPerSample: 4,
  // FastAPI/api/correlation_sql.py CIRCULAR_SHIFT_SCREEN_TOP_N
  circularShiftScreenTopN: 200,
  // /correlations/family `limit` Query(default, le=max)
  familyLimitDefault: 50,
  familyLimitMax: 500,
}

const N_LAGS  = METHODS_FACTS.correlationLags.length
const MAX_LAG = Math.max(...METHODS_FACTS.correlationLags)

function Formula({ children }: { children: ReactNode }) {
  return (
    <code style={{
      fontFamily:   'var(--mono)',
      fontSize:     12,
      background:   'var(--surface2)',
      padding:      '2px 6px',
      borderRadius: 4,
    }}>
      {children}
    </code>
  )
}

function Item({ title, formula, children }: { title: string; formula?: ReactNode; children: ReactNode }) {
  return (
    <p style={{ marginBottom: 16 }}>
      <strong style={{ color: 'var(--teal)' }}>{title}</strong>
      {formula && <><br /><Formula>{formula}</Formula></>}
      <br />
      <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{children}</span>
    </p>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ marginBottom: 12 }}><h2>{title}</h2></div>
      <div className="about-card" style={{ lineHeight: 1.9 }}>{children}</div>
    </div>
  )
}

const ANNOTATION_TYPES = [
  {
    label: 'Functional',
    title: 'KEGG Orthology (KO)',
    desc:  'KEGG Orthology terms represent functional orthologs across species and link genes to metabolic pathways, biological processes, and molecular functions. Hierarchy: pathway class → subcategory → pathway → KO.',
    ex:    'K02014 · K00001 · K16950',
  },
  {
    label: 'Functional',
    title: 'COG',
    desc:  'Clusters of Orthologous Groups — a classification system for proteins that assigns genes to functional categories conserved across bacteria, archaea, and eukaryotes. Hierarchy: category (a single letter, e.g. E · Amino acid transport and metabolism) → COG.',
    ex:    'COG0001 · COG1234',
  },
  {
    label: 'Biochemical',
    title: 'Enzyme Commission (EC)',
    desc:  'EC numbers classify enzymes by the chemical reactions they catalyze. Hierarchical: class → subclass → sub-subclass → serial number.',
    ex:    'EC:1.1.1.1 · EC:4.2.1.17',
  },
  {
    label: 'Biological',
    title: 'Taxonomy',
    desc:  'Taxonomic classifications assign genes and contigs to organisms across the tree of life, from domain down to species and strain level. On the Taxonomy Explorer page you can remove branches from a taxon’s total, or keep only the branches you choose.',
    ex:    'Tenacibaculum maritimum',
  },
]

export function MethodsPage() {
  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Methods</h1>
          <p className="subtitle">How every value is calculated, why, and where the data comes from</p>
        </div>
      </div>

      <div className="page-body">

        {/* ── Annotation Types ── */}
        <div>
          <div style={{ marginBottom: 12 }}><h2>Annotation Types</h2></div>
          <div className="about-grid">
            {ANNOTATION_TYPES.map(c => (
              <div className="about-card" key={c.title}>
                <div className="card-type-label">{c.label}</div>
                <h3>{c.title}</h3>
                <p>{c.desc}</p>
                <div className="card-id-example">{c.ex}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── From Genes to Annotations ── */}
        <Section title="From Genes to Annotations">
          <Item title="Which genes are counted">
            For each sample, every gene with at least one hit in any of JGI’s four per-gene
            annotation files (COG, KEGG, EC, taxonomy) is included. All of a gene’s distinct
            hits are kept — a multi-domain protein with two COGs, or a bifunctional enzyme
            with two EC numbers, counts toward both. No e-value or percent-identity filter
            is applied, consistent across all four sources. A gene’s scaffold is read from
            its own ID.
          </Item>
          <Item title="Hierarchies roll up">
            A gene counts toward its own annotation and toward every ancestor above it
            (e.g. a KO, its pathway, subcategory and pathway class), but only once per
            category per sample, even if it has several hits beneath that category. So a
            category’s value always includes everything beneath it. That is why top-level
            categories (COG letters, KEGG’s top classes, EC classes, taxonomic domains) are
            shown separately on the Explore page instead of being ranked next to the groups
            they already contain.
          </Item>
          <Item title="Annotations with more than one parent">
            A KO that belongs to several pathways, or a COG assigned to several categories,
            counts in full toward each one. Each group’s total is therefore correct on its
            own, but totals summed across groups can exceed the overall total.
          </Item>
          <Item title="Renumbered and incomplete EC numbers">
            Some EC numbers in the JGI annotations have since been renumbered and are no
            longer in KEGG’s EC hierarchy. These are credited to their new place in the
            tree, per KEGG’s record of where each was transferred (e.g. 1.6.1.2 → 7.1.1.1).
            When one old number was split into several new ones, the gene is credited to
            their shared parent only, since the old label can’t say which it was: DNA
            helicase 3.6.4.12 (now 5.6.2.3 and 5.6.2.4) and RNA helicase 3.6.4.13 are
            credited to 5.6.2. Genes labelled with the retired subclass 3.6.3.- are
            credited to class 7 (Translocases), where nearly all of its enzymes moved.
            Any other EC number that is partial (e.g. 3.6.1.-) or missing from the
            hierarchy is credited to its deepest real ancestor, since an EC number’s
            position is fixed by its own digits; one with no resolvable ancestor at all is
            dropped.
          </Item>
          <Item title="Taxonomy is keyed by full lineage">
            Each taxon is identified by its complete lineage, not its bare name, so two
            different organisms that happen to share a name at some rank are never merged.
          </Item>
        </Section>

        {/* ── How Values Are Calculated ── */}
        <Section title="How Values Are Calculated">
          <Item
            title="EGC — Estimated Gene Copies"
            formula="EGC(annotation, sample) = Σ over scaffolds ( genes on the scaffold with this annotation × scaffold average read depth )"
          >
            Each gene is weighted by how deeply its scaffold was sequenced (average fold
            coverage from JGI’s per-sample depth file), so EGC estimates how many copies of
            that gene were present in the community rather than just how many distinct genes
            were assembled. Higher EGC means more copies.
          </Item>
          <Item
            title="Relative Abundance (norm_egc)"
            formula="norm_egc = EGC(annotation, sample) / Σ over every scaffold in the sample ( annotated genes on the scaffold × scaffold average read depth )"
          >
            Divides by the same gene-weighted depth, summed over the whole sample, which
            removes differences in sequencing depth between samples and keeps values in
            [0, 1]. The denominator is one shared total per sample, used by all four
            sources, so KEGG, COG, EC and taxonomy values are comparable on the same plot.
            It counts annotated genes only (27–48% of predicted genes have no hit in any
            source), so relative abundance means “share of the annotated signal”, not of
            every gene in the sample. Use it when comparing across samples.
          </Item>
          <Item title="Z-score Normalisation" formula="Z = ( value − μ ) / σ   where σ = population standard deviation (÷ n)">
            Centres each series at zero and scales it by its own spread. A value of +2 means
            2 standard deviations above that annotation’s mean across the bloom. Best for
            comparing trend shapes of annotations with very different magnitudes. A series
            with fewer than 2 points is left unstandardised (and labelled as such).
          </Item>
          <Item
            title="LOWESS Smoothing"
            formula="local weighted linear fit · window = max(3, ⌈bandwidth × n⌉) nearest points · tricube weight w = (1 − |u|³)³"
          >
            At each timepoint a weighted straight line is fitted to its nearest points in
            time; closer points get more weight. Lower bandwidth follows local fluctuations,
            higher bandwidth shows the overall trend (adjustable from{' '}
            {LOWESS_BANDWIDTH_MIN} to {LOWESS_BANDWIDTH_MAX}). Smoothing changes only the
            drawn line; statistics are always computed on the real values.
          </Item>
          <Item
            title="Descriptive Statistics"
            formula="Median / Q1 / Q3: linear interpolation at h = (n − 1) × p · Std Dev s: sample (÷ n − 1) · CV = s / mean"
          >
            Quartiles match R’s default quantile() and numpy.percentile(). The standard
            deviation is Bessel-corrected and labelled “s” to distinguish it from the
            population σ used for Z-scores.
          </Item>
        </Section>

        {/* ── Correlation ── */}
        <Section title="Correlation">
          <Item title="What is compared">
            The Correlates panel scores a reference annotation against every candidate in a
            family, using only the timepoints where both were detected; a pair needs at
            least 10 such timepoints. Four methods are available: raw Pearson, log-Pearson
            (Pearson on natural-log values), Spearman, and Spearman with a circular-shift
            permutation p-value.
          </Item>
          <Item
            title="Lags"
            formula={`${N_LAGS} lags: 0 to ±${MAX_LAG} samples (0–${MAX_LAG * METHODS_FACTS.lagHoursPerSample} h at ${METHODS_FACTS.lagHoursPerSample} h per sample)`}
          >
            Each candidate is scored at {N_LAGS} lags — every offset from 0 to ±{MAX_LAG}{' '}
            samples, i.e. up to a full day of lead or lag — and the lag with the largest |r|
            is kept. For the first three methods, that lag’s p-value is Bonferroni-corrected
            (× {N_LAGS}) for having searched {N_LAGS} lags.
          </Item>
          <Item
            title="Circular-shift p-value"
            formula="p = ( 1 + shifts at least as extreme ) / ( 1 + evaluable shifts )"
          >
            Samples taken 4 hours apart are not independent, so ordinary p-values are far too
            optimistic for time series (about half of unrelated but autocorrelated pairs
            pass). This method instead shifts the reference series around in a circle, which
            keeps each series’ own autocorrelation but destroys any real relationship, and
            re-runs the full {N_LAGS}-lag search at every shift. Every valid shift is used
            exactly once, excluding shifts too close to the real alignment (within 2 ×{' '}
            {MAX_LAG} + 1 samples, so the lag search can’t reconstruct it). The lag search is
            built into the null, so no Bonferroni correction is applied. When no shift is as
            extreme as the real data, p is the smallest value the test can report for that
            pair — an upper bound, not a precise estimate; the API flags these results
            (at_p_floor).
          </Item>
          <Item title="Shortlist and false discovery rate">
            Because the permutation test is slow, candidates are first ranked by the fast
            method and only the top {METHODS_FACTS.circularShiftScreenTopN} — ranked by
            |r| × √(n − 3), so a strong correlation from few timepoints can’t outrank a
            slightly weaker one backed by all 128 — receive the circular-shift test; the
            panel discloses when this happened. A Benjamini–Hochberg correction is then
            applied across every candidate scored in the request, and only candidates with
            q &lt; 0.05 are shown, capped at the top {METHODS_FACTS.familyLimitDefault} by |r|
            (up to {METHODS_FACTS.familyLimitMax} through the API’s limit parameter). The
            panel shows the true significant count when more than that exist.
          </Item>
        </Section>

        {/* ── Data Sources ── */}
        <Section title="Data Sources">
          <Item title="Samples">
            128 metagenome samples collected roughly every 4 hours (a few gaps of 8–12 h)
            from 27 May to 18 June 2021 at Rosario, Orcas Island, Washington, and sequenced
            and annotated by the DOE Joint Genome Institute (IMG annotation pipeline v5).
            Per sample, the app uses JGI’s per-gene COG, KEGG (KO), EC and taxonomy
            (phylodist) hit files and the scaffold depth file.
          </Item>
          <Item title="Annotation hierarchies">
            KEGG Orthology hierarchy: KEGG BRITE ko00001 (KEGG release dated 22 May 2026).
            EC hierarchy: KEGG BRITE ko01000 (KEGG release dated 12 September 2026,
            downloaded 14 September 2026; a local copy is kept so results are reproducible).
            COG category names: NCBI COG. Taxonomic lineages come from JGI’s phylodist
            assignments.
          </Item>
          <Item title="Environmental overlays">
            Tide heights: NOAA CO-OPS station 9449771. Day/night shading: sunrise and sunset
            computed astronomically for the sampling site (48.65° N, 122.85° W).
          </Item>
        </Section>

      </div>
    </div>
  )
}
