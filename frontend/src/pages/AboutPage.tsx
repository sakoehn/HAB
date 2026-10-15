// ── AboutPage ─────────────────────────────────────────────────────────────────
// Static reference page covering annotation types, calculation methods,
// usage guide, and API endpoint reference.
// No props, no state — purely informational.

export function AboutPage() {
  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>About &amp; API</h1>
          <p className="subtitle">What Metatrace is, how to use it, API reference, and who built it</p>
        </div>
      </div>

      <div className="page-body">

        {/* ── About Metatrace ── */}
        <div>
          <div style={{ marginBottom: 12 }}><h2>About Metatrace</h2></div>
          <div className="about-card" style={{ lineHeight: 1.9 }}>
            <p>
              Metatrace is an interactive browser for a high-frequency metagenomic time
              series collected through a harmful algal bloom (HAB) at Rosario, Orcas Island,
              Washington: 128 samples taken roughly every 4 hours from 27 May to 18 June
              2021, sequenced and annotated by the DOE Joint Genome Institute (JGI). It
              lets you follow how the abundance of genes, functions and organisms — KEGG
              orthologs, COGs, enzymes and taxa — changes through the bloom, compare them
              side by side, browse their hierarchies, scaffolds and gene mappings, and find
              annotations whose abundance rises and falls together. How every value is
              calculated is described on the <strong>Methods</strong> page; everything shown
              is also available through the API below.
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
              boxes in the branch tree: in <strong>Remove checked</strong> mode
              the chart overlays the full scope against the total with those
              branches removed; switch to <strong>Keep only checked</strong> to
              see just the checked branches summed instead (your checks carry
              over). Either way you can see how much a branch is contributing
              over time. Check as many branches as you
              like and un-check a box to undo it; changing scope
              clears your checks since they no longer apply.
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
               'Cross-sample annotation search: substring match on ID or name (3+ characters); a 1–2 character query is an exact ID lookup (COG category letters, EC classes)'],
              ['/api/series/annotations?source=…&annotation_id=…',
               'EGC time series for one annotation'],
              ['/api/taxonomy/children?parent=…',
               'Direct children of a taxon (name, rank depth, domain category) — parent omitted returns the 4 domains. Powers the Taxonomy Explorer’s browse tree and exclusion picker'],
              ['/api/kegg/children?parent=…',
               'Direct children of a KEGG BRITE node (structure only, no EGC) — parent omitted returns the 8 top-level branches. Backs the hierarchy popup (🌳 Hierarchy button on charts and Explore tables)'],
              ['/api/enzyme/children?parent=…',
               'Direct children of an EC node (structure only, no EGC) — parent omitted returns the 7 top-level enzyme classes'],
              ['/api/cog/children?parent=…',
               'Direct children of a COG node (structure only, no EGC) — parent omitted returns the 25 top-level categories'],
              ['/api/kegg/path?id=…',
               'Every real ancestor path (root to node) for a KEGG node — a node can have multiple real parents (e.g. K00844/hexokinase has 14). Powers the hierarchy popup\'s auto-expand-and-highlight on open (the first real occurrence), plus a picker to switch to any of the others'],
              ['/api/kegg/parents?ids=…,…',
               'Every real IMMEDIATE (one-level-up) parent for a comma-separated batch of KEGG node ids, in one request instead of one per id. Powers the Explore lookup card and "Annotations by Parent" grouping — a multi-parent KO is filed under every real parent group it belongs to, not just one'],
              ['/api/enzyme/path?id=…',
               'Ancestor path (root to node) for an Enzyme (EC) node — every EC id has exactly one real parent, so this is always unambiguous'],
              ['/api/cog/path?id=…',
               'Every real ancestor path (root to node) for a COG node — a COG id can have multiple real categories (e.g. COG0028 is real under both Amino acid transport and metabolism and Coenzyme transport and metabolism)'],
              ['/api/mappings/search?annotation_id=…&source=…',
               'Filtered cross-sample mapping rows'],
              ['/api/annotations/top?source=…&limit=25',
               'Top N annotations by mean EGC, optional date_from/date_to'],
              ['/api/correlation?catalog_id_a=…&catalog_id_b=…&metric=egc&method=spearman',
               'Score (or read the cached score for) one specific pair. method: raw_pearson, log_pearson, spearman, or circular_shift. Returns r, p, lag_samples, n_pairs'],
              ['/api/correlations/family?ref_source=…&ref_annotation_id=…&target_source=…&metric=egc&method=spearman&limit=50',
               'Returns {results, significant_count, prescreened, prescreen_pool_size, prescreen_top_n}. results: every eligible candidate in target_source scored against the reference (same-source parents/children/siblings excluded), sorted by |r| descending, capped at limit, gated to q < 0.05. significant_count is the true q<0.05 total before limit truncates results. For method=circular_shift on a large family, only the strongest prescreen_top_n of prescreen_pool_size candidates (by a fast method) get the full permutation test — prescreened is true when that happened.'],
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

        {/* ── Authors & Contributors ── */}
        <div>
          <div style={{ marginBottom: 12 }}><h2>Authors &amp; Contributors</h2></div>
          <div className="about-card" style={{ lineHeight: 1.9 }}>
            {/* Left blank on purpose for now -- names/roles/affiliations to be added. */}
          </div>
        </div>

      </div>
    </div>
  )
}
