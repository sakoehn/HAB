// ── AboutPage ─────────────────────────────────────────────────────────────────
// Static reference page covering annotation types, calculation methods,
// usage guide, and API endpoint reference.
// No props, no state — purely informational.

import React from 'react'

export function AboutPage() {
  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>About HAB Portal</h1>
          <p className="subtitle">Annotation types, usage guide, and API reference</p>
        </div>
      </div>

      <div className="page-body">

        {/* ── Annotation Types ── */}
        <div>
          <div style={{ marginBottom: 12 }}><h2>Annotation Types</h2></div>
          <div className="about-grid">
            {[
              {
                label: 'Functional',
                title: 'KEGG Orthology (KO)',
                desc:  'KEGG Orthology terms represent functional orthologs across species and link genes to metabolic pathways, biological processes, and molecular functions.',
                ex:    'K02014 · K00001 · K16950',
              },
              {
                label: 'Functional',
                title: 'COG',
                desc:  'Clusters of Orthologous Groups — a classification system for proteins that assigns genes to functional categories conserved across bacteria, archaea, and eukaryotes.',
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
                desc:  'Taxonomic classifications assign genes and contigs to organisms across the tree of life, from phylum down to species level.',
                ex:    'Tenacibaculum maritimum',
              },
            ].map(c => (
              <div className="about-card" key={c.title}>
                <div className="card-type-label">{c.label}</div>
                <h3>{c.title}</h3>
                <p>{c.desc}</p>
                <div className="card-id-example">{c.ex}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── How Values Are Calculated ── */}
        <div>
          <div style={{ marginBottom: 12 }}><h2>How Values Are Calculated</h2></div>
          <div className="about-card" style={{ lineHeight: 1.9 }}>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>EGC — Estimated Gene Copies</strong>
              <br />
              <code style={{
                fontFamily:  'var(--mono)',
                fontSize:    12,
                background:  'var(--surface2)',
                padding:     '2px 6px',
                borderRadius: 4,
              }}>
                EGC(annotation, sample) = Σ scaffold ( gene_count × coverage )
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                For each scaffold contributing genes to an annotation, the gene count
                is multiplied by the scaffold's sequencing coverage (read depth). EGC
                is the sum across all contributing scaffolds. Higher EGC indicates more
                copies of that functional gene in the community.
              </span>
            </p>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>
                norm_egc — Depth-Normalised EGC (L1 mode)
              </strong>
              <br />
              <code style={{
                fontFamily:  'var(--mono)',
                fontSize:    12,
                background:  'var(--surface2)',
                padding:     '2px 6px',
                borderRadius: 4,
              }}>
                norm_egc = EGC(annotation, sample) / total_coverage(sample)
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Divides raw EGC by the total sequencing depth of the sample. Removes
                sequencing effort bias — samples sequenced more deeply are directly
                comparable to shallower ones. Use L1 mode when comparing relative
                abundance across samples.
              </span>
            </p>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>Z-score Normalisation</strong>
              <br />
              <code style={{
                fontFamily:  'var(--mono)',
                fontSize:    12,
                background:  'var(--surface2)',
                padding:     '2px 6px',
                borderRadius: 4,
              }}>
                Z = ( EGC − μ ) / s &nbsp;&nbsp; where s = sample std dev (÷ n−1, Bessel-corrected)
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Centres each series at zero and scales by its standard deviation.
                A value of +2 means 2 std deviations above that annotation's mean across
                the bloom. Best for comparing trend shapes across annotations with very
                different EGC magnitudes.
              </span>
            </p>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>LOWESS Smoothing</strong>
              <br />
              <code style={{
                fontFamily:  'var(--mono)',
                fontSize:    12,
                background:  'var(--surface2)',
                padding:     '2px 6px',
                borderRadius: 4,
              }}>
                ŷᵢ = local weighted linear regression · span = ⌈bandwidth × n⌉ neighbors · tricube kernel w = (1 − |u|³)³
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Locally Weighted Scatterplot Smoothing. At each timepoint, a weighted
                linear model is fit using the nearest fraction (bandwidth) of data points.
                Closer points receive higher weight. Lower bandwidth = tighter fit to local
                fluctuations; higher = smoother global trend. Range: 0.05 (tight) → 0.75
                (near-linear).
              </span>
            </p>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>Spearman CLR Correlation</strong>
              <br />
              <code style={{
                fontFamily:  'var(--mono)',
                fontSize:    12,
                background:  'var(--surface2)',
                padding:     '2px 6px',
                borderRadius: 4,
              }}>
                rₛ = Spearman rank correlation on CLR-transformed EGC · p-value via circular-shift permutation (n=1000, seed=42)
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                EGC values are first transformed using Centred Log Ratio (CLR) to handle
                the compositional nature of metagenomic data. Lag is the time offset (in
                4-hour steps) that maximises |r|. The p-value is the fraction of 1000
                circular-shifted permutations that exceed the observed |r|.
              </span>
            </p>

            <p>
              <strong style={{ color: 'var(--teal)' }}>Descriptive Statistics</strong>
              <br />
              <code style={{
                fontFamily:  'var(--mono)',
                fontSize:    12,
                background:  'var(--surface2)',
                padding:     '2px 6px',
                borderRadius: 4,
              }}>
                Median / Q1 / Q3: Type 7 linear interpolation (R default, numpy default) · Std Dev s: sample (÷ n−1) · CV = s / mean
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Quartiles use linear interpolation at index h = (n−1) × p — matches
                R's quantile() and numpy.percentile(). Std dev is Bessel-corrected
                (÷ n−1) and labelled "s" to distinguish from population σ.
              </span>
            </p>

          </div>
        </div>

        {/* ── How to Use ── */}
        <div>
          <div style={{ marginBottom: 12 }}><h2>How to Use</h2></div>
          <div className="about-card" style={{ lineHeight: 1.9 }}>
            <p>
              <strong style={{ color: 'var(--teal)' }}>
                Analyze (two-column workspace):
              </strong>{' '}
              Enter one or more search terms — each gets its own tab in the left
              column. Check rows to select annotations, then click{' '}
              <strong>+ Add N</strong> to add individual time-series chart cards
              to the right column, or <strong>∑ Group</strong> to sum their EGC
              into one chart. The <strong>Compare drawer</strong> (bottom of right
              column) overlays multiple series for direct visual comparison — drag
              the top edge to resize it.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--violet)' }}>
                Compare (dedicated overlay page):
              </strong>{' '}
              Search and bulk-select up to 4 annotations to overlay on a shared
              chart. Selections persist when switching pages. Use{' '}
              <strong>Z-score normalize</strong> when series have very different
              EGC magnitudes.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--amber)' }}>Explore:</strong> Five
              views — <em>Dataset Overview</em>, <em>Top EGC Annotations</em>,{' '}
              <em>Annotations by Parent</em>, <em>Annotation Lookup</em>, and{' '}
              <em>Scaffold Information</em>. Click any card to open that view.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>
                Normalize modes:
              </strong>{' '}
              <em>Off</em> — raw EGC.{' '}
              <em>L1</em> — depth-normalised EGC (norm_egc = egc / total sample
              sequencing depth), directly comparable across samples.{' '}
              <em>Z-score</em> — std deviations from mean, best for comparing
              trends across different scales.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>LOWESS Smooth:</strong>{' '}
              Locally weighted regression — fits a weighted linear model at each
              point using nearby neighbors. Lower bandwidth = tighter fit; higher
              = smoother trend.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>EGC</strong> (Estimated
              Gene Copies per liter) — normalized for sequencing depth across all
              128 samples collected at 4-hour intervals.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>Reset:</strong> Clears
              all page state across Analyze, Compare, and Explore simultaneously.
            </p>
          </div>
        </div>

        {/* ── API Reference ── */}
        <div>
          <div style={{ marginBottom: 12 }}><h2>API Reference</h2></div>
          <div className="api-ref">
            {([
              ['/api/timepoints',
               'List all 128 sample timepoints with dates'],
              ['/api/samples',
               'List all samples with timepoint metadata'],
              ['/api/samples/{id}/mappings',
               'Gene mappings for one sample'],
              ['/api/samples/{id}/kegg',
               'KEGG annotations for one sample'],
              ['/api/samples/{id}/cog',
               'COG annotations for one sample'],
              ['/api/samples/{id}/enzyme',
               'Enzyme annotations for one sample'],
              ['/api/samples/{id}/taxonomy',
               'Taxonomy annotations for one sample'],
              ['/api/search/annotations?q=…&sources=kegg',
               'Cross-sample annotation search (inverted index)'],
              ['/api/series/annotations?source=…&annotation_id=…',
               'EGC time series for one annotation'],
              ['/api/mappings/search?annotation_id=…&source=…',
               'Filtered cross-sample mapping rows'],
              ['/api/annotations/top?source=…&limit=25',
               'Top N annotations by mean EGC, optional date_from/date_to'],
              ['/api/annotations/correlate?source=kegg&annotation_id=K02014&mode=cross',
               'Spearman+lag correlation, cross-source or within-source parent-filtered. Returns spearman_r, lag_hours, p_value, n_pairs. Add &skip_pvalue=true for instant exploratory results.'],
              ['/api/annotations/scaffolds/summary?source=…&annotation_id=…',
               'Per-sample scaffold and gene counts for one annotation'],
              ['/api/annotations/scaffolds?source=…&annotation_id=…',
               'Individual scaffold names and gene counts across all samples'],
              ['/api/status',
               'Index build status and dataset date range (date_min, date_max)'],
            ] as [string, string][]).map(([path, desc], i) => (
              <div className="api-ref-row" key={i}>
                <span className="api-method">GET</span>
                <div>
                  <div className="api-ref-path">{path}</div>
                  <div className="api-ref-desc">{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}
