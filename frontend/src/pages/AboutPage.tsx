// ── AboutPage ─────────────────────────────────────────────────────────────────
// Static reference page covering annotation types, calculation methods,
// usage guide, and API endpoint reference.
// No props, no state — purely informational.

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
                desc:  'Taxonomic classifications assign genes and contigs to organisms across the tree of life, from domain down to species and strain level. Explore and exclude branches on the Taxonomy Explorer page.',
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
                Relative Abundance (norm_egc)
              </strong>
              <br />
              <code style={{
                fontFamily:  'var(--mono)',
                fontSize:    12,
                background:  'var(--surface2)',
                padding:     '2px 6px',
                borderRadius: 4,
              }}>
                norm_egc = EGC(annotation, sample) / Σ scaffold ( gene_count × coverage ), summed over ALL scaffolds in the sample
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Divides raw EGC by that same gene-weighted depth sum, but computed
                across every scaffold in the sample rather than just this annotation's.
                This bounds norm_egc to [0, 1] — it's the fraction of all annotated gene
                copies in the sample that belong to this annotation — and removes
                sequencing-depth bias without letting high-coverage scaffolds push values
                above 1 (a plain total-coverage denominator could). Use the Relative
                Abundance metric when comparing across samples.
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
                Z = ( EGC − μ ) / σ &nbsp;&nbsp; where σ = population std dev (÷ n)
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
              <strong style={{ color: 'var(--teal)' }}>Correlation (Correlates panel)</strong>
              <br />
              <code style={{
                fontFamily:  'var(--mono)',
                fontSize:    12,
                background:  'var(--surface2)',
                padding:     '2px 6px',
                borderRadius: 4,
              }}>
                4 methods: raw Pearson · log-Pearson · Spearman · Spearman with a circular-shift permutation p-value (n=1000, seed=42) · Benjamini-Hochberg across the family, q &lt; 0.05
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Every candidate is scored against the reference at 9 lags (0, ±1, ±2, ±3, ±6
                samples), keeping whichever lag maximises |r|. The first three methods
                correct that lag's p-value with a Bonferroni factor for the 9-lag search;
                the circular-shift method instead derives its p-value by re-searching all 9
                lags on each of 1000 randomly shifted copies of the reference series, which
                accounts for autocorrelation between nearby timepoints that the other three
                methods don't. A Benjamini-Hochberg correction is then applied across every
                candidate scored in the same family request, and only candidates with
                q &lt; 0.05 are shown.
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
              <strong style={{ color: 'var(--chart-4)' }}>Taxonomy Explorer:</strong>{' '}
              Pick a scope taxon — search by name, or use{' '}
              <strong>or browse</strong> to drill down from the 4 domains
              (Bacteria, Archaea, Eukaryota, Viruses) to any level. Then check
              boxes in the <strong>Exclude branches</strong> tree to remove
              specific phyla, classes, or any other descendant from the
              total — the chart overlays the full scope against the total
              with your exclusions removed, so you can see how much a branch
              is contributing over time. Exclude as many branches as you
              like and re-check a box to add one back in; changing scope
              clears exclusions since they no longer apply.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>
                Metric:
              </strong>{' '}
              <em>EGC</em> — raw values.{' '}
              <em>Relative Abundance</em> — depth-normalised EGC (norm_egc = egc /
              gene-weighted total depth, bounded to [0, 1]), directly comparable across samples.{' '}
              <strong style={{ color: 'var(--text-dim)' }}>
                Standardize:
              </strong>{' '}
              <em>Off</em>, or <em>Z-score</em> — std deviations from mean, best for
              comparing trends across different scales. Independent of Metric, so
              either can be Z-scored.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>LOWESS Smooth:</strong>{' '}
              Locally weighted regression — fits a weighted linear model at each
              point using nearby neighbors. Lower bandwidth = tighter fit; higher
              = smoother trend.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>Reset:</strong> Clears
              all page state across Analyze, Compare, Explore, and Taxonomy
              Explorer simultaneously.
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
              ['/api/search/annotations?q=…&sources=kegg',
               'Cross-sample annotation search (inverted index)'],
              ['/api/series/annotations?source=…&annotation_id=…',
               'EGC time series for one annotation'],
              ['/api/taxonomy/children?parent=…',
               'Direct children of a taxon (name, rank depth, domain category) — parent omitted returns the 4 domains. Powers the Taxonomy Explorer’s browse tree and exclusion picker'],
              ['/api/kegg/children?parent=…',
               'Direct children of a KEGG BRITE node (structure only, no EGC) — parent omitted returns the 8 top-level branches. Backs the hierarchy popup (🌳 Hierarchy button on charts and Explore tables)'],
              ['/api/enzyme/children?parent=…',
               'Direct children of an EC node (structure only, no EGC) — parent omitted returns the 7 top-level enzyme classes'],
              ['/api/cog/children?parent=…',
               'Direct children of a COG node (structure only, no EGC) — parent omitted returns the 26 top-level categories'],
              ['/api/kegg/path?id=…',
               'Every real ancestor path (root to node) for a KEGG node — a node can have multiple real parents (e.g. K00844/hexokinase has 14). Powers the hierarchy popup\'s auto-expand-and-highlight on open (the first real occurrence), plus a picker to switch to any of the others'],
              ['/api/enzyme/path?id=…',
               'Ancestor path (root to node) for an Enzyme (EC) node — every EC id has exactly one real parent, so this is always unambiguous'],
              ['/api/cog/path?id=…',
               'Ancestor path (root to node) for a COG node — every COG id has exactly one real category, so this is always unambiguous'],
              ['/api/mappings/search?annotation_id=…&source=…',
               'Filtered cross-sample mapping rows'],
              ['/api/annotations/top?source=…&limit=25',
               'Top N annotations by mean EGC, optional date_from/date_to'],
              ['/api/correlation?catalog_id_a=…&catalog_id_b=…&metric=egc&method=spearman',
               'Score (or read the cached score for) one specific pair. method: raw_pearson, log_pearson, spearman, or circular_shift. Returns r, p, lag_samples, n_pairs'],
              ['/api/correlations/family?ref_source=…&ref_annotation_id=…&target_source=…&metric=egc&method=spearman&limit=50',
               'Every eligible candidate in target_source scored against the reference (same-source parents/children/siblings excluded), sorted by |r| descending, capped at limit, gated to q < 0.05'],
              ['/api/annotations/scaffolds/summary?source=…&annotation_id=…',
               'Per-sample scaffold and gene counts for one annotation'],
              ['/api/annotations/scaffolds?source=…&annotation_id=…&sample=…&page=1&page_size=500',
               'Individual scaffold names and gene counts, paginated — sample= strongly recommended'],
              ['/api/taxonomy/export?rank=genus',
               'All distinct taxa at a given rank (domain … strain) — powers the Taxonomy page\'s CSV download'],
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
