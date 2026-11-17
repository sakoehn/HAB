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
import { LOWESS_MIN_POINTS } from '../utils/signal'
import { METHODS_FACTS } from './methodsFacts'
import { TIDE_MATCH_MAX_MINUTES } from '../utils/solar'

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
    desc:  'KEGG Orthology terms represent functional orthologs across species. The app treats KOs as a flat list, with no pathway hierarchy: each KO links to its own KEGG page, which shows its full name, gene symbol and the pathways it belongs to. KO names come from JGI (see Data Sources).',
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
    desc:  'EC numbers classify enzymes by the chemical reactions they catalyze. Hierarchical: class → subclass → sub-subclass → serial number. The tree follows from the numbers themselves; the names come from ExPASy ENZYME.',
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
            (e.g. an EC number, its sub-subclass, subclass and class), but only once per
            category per sample, even if it has several hits beneath that category. So a
            category’s value always includes everything beneath it. That is why top-level
            categories (COG letters, EC classes, taxonomic domains) are
            shown separately on the Explore page instead of being ranked next to the groups
            they already contain, and why Top EGC Annotations ranks one level at a time,
            starting at the most specific (KOs, COGs, EC numbers, species). Ranking all
            levels together is still available, with the categories necessarily on top.
            KEGG orthologs have no hierarchy here, so a KO counts only toward itself.
          </Item>
          <Item title="Annotations with more than one parent">
            A COG assigned to several categories counts in full toward each one. Each group’s total is therefore correct on its
            own, but totals summed across groups can exceed the overall total.
          </Item>
          <Item title="Renumbered and incomplete EC numbers">
            Some EC numbers in the JGI annotations have since been renumbered by IUBMB, which
            keeps the official enzyme list. These are credited to their new number, per
            IUBMB’s record of where each was transferred (e.g. 1.6.1.2 → 7.1.1.1), and the
            enzyme’s page in the app names the old number JGI’s files use. ExPASy has not yet
            caught up on a few of these (it still lists 3.6.4.10, 3.6.4.12, 3.6.4.13 and
            1.2.99.7 as current); the app follows IUBMB.
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
          <Item title="Downloading the kept taxa">
            On the Taxonomy Explorer, Keep only checked can download the checked taxa, each
            at its own rank. If you check a taxon and also something above it (a family and
            its order), only the higher one is downloaded: its EGC already includes everything
            under it, so listing both would count those genes twice. To get each family
            separately, check only the families.
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
            comparing trend shapes of annotations with very different magnitudes. The mean
            and spread always come from the whole series, so narrowing the date range or
            unticking timepoints hides points without changing any point’s Z. A series
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
            drawn line; statistics are always computed on the real values. A series with
            fewer than {LOWESS_MIN_POINTS} detected points is drawn unsmoothed, since smoothing
            would leave every point where it is; its hover label and CSV say so.
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
            least 10 such timepoints. Three methods are available: raw Pearson, log-Pearson
            (Pearson on natural-log values) and Spearman. All of them use the metric chosen
            in the panel (EGC or relative abundance), and all share the same significance
            test, described below.
          </Item>
          <Item title="Raw Pearson" formula="r = cov(x, y) / (σx · σy)">
            Pearson’s correlation on the values as they are: how closely the two series rise
            and fall together in a straight-line relationship. Because it uses the actual
            values, a few very large ones (e.g. a bloom spike) can dominate r.
          </Item>
          <Item title="Log-Pearson" formula="r = Pearson( ln x, ln y )">
            Pearson’s correlation on the natural log of each value, so it compares relative
            (fold) changes rather than absolute ones, and large values no longer dominate. Only
            timepoints where both annotations were detected are used, so every value is
            positive and has a log.
          </Item>
          <Item title="Spearman" formula="r = Pearson( rank(x), rank(y) )">
            Pearson’s correlation on the values’ ranks: whether one series tends to be higher
            when the other is, in any consistent (monotonic) way, not only a straight line.
            Using ranks makes it robust to outliers and skewed values; tied values share the
            average of their ranks.
          </Item>
          <Item
            title="P-values: effective sample size"
            formula="1 / N_eff = 1/N + (2/N) · Σ j=1…N/5 ( (N − j)/N ) · ρx(j) · ρy(j)    ·    t = r · √( (N_eff − 2) / (1 − r²) )"
          >
            Samples taken 4 hours apart are not independent: each one looks a lot like the
            one before it. A standard p-value counts every timepoint as separate evidence, so
            for smooth time series it is far too optimistic: about 40% of unrelated but
            smooth pairs pass at one lag, and about 80% once the best of the 13 lags is
            kept. Instead, the number of timepoints N is discounted by how
            strongly each series resembles itself at increasing time offsets (its
            autocorrelation ρ), following Pyper &amp; Peterman (1998), and r is tested with
            N_eff − 2 degrees of freedom. The autocorrelation is measured on the same values
            that were correlated (raw, logged or ranked), after dropping timepoints where
            either annotation is missing. N_eff never exceeds the real number of timepoints.
            The correction is close but not exact: in simulations of unrelated smooth pairs
            (including the lag search below), about 6% pass p &lt; 0.05 rather than 5%, up to
            7% when a candidate is detected in only part of the series. Correcting that would
            also miss about half of the real shared trends, so the estimator is kept as
            published, and the false discovery rate correction below is applied on top.
          </Item>
          <Item title="What this means: about 30 independent observations">
            In practice the 128 samples are worth about 30 independent observations (median
            29, middle half 23–37, across one real search of 3,211 enzyme families against
            photosystem II protein D1). With that little evidence, and after the corrections
            below, only strong correlations can be confirmed as significant. How strong
            depends on the pair. Smoother series carry less evidence: in that search
            ferredoxin:thioredoxin reductase (r = 0.60, worth about 54 independent
            observations) was significant, while RuBisCO (r = 0.66, smoother, worth about 24)
            was not significant. Pairs detected at only a few timepoints carry little
            evidence too: an r of 0.90 from 10 shared timepoints was not significant either.
            Trends shared across the bloom count as a
            real relationship and are not removed: how genes behave across bloom states is
            exactly what the correlations are for. A shared trend makes both series smooth, so
            the pair is worth fewer independent observations, but it also gets a smaller lag
            correction (below).
          </Item>
          <Item
            title="Lags"
            formula={`${N_LAGS} lags: 0 to ±${MAX_LAG} samples (0–${MAX_LAG * METHODS_FACTS.lagHoursPerSample} h at ${METHODS_FACTS.lagHoursPerSample} h per sample)`}
          >
            Each candidate is scored at {N_LAGS} lags — every offset from 0 to ±{MAX_LAG}{' '}
            samples, i.e. about a day of lead or lag — and the lag with the largest |r|
            is kept. A lag shifts one series by whole samples, so its hours are nominal
            ({METHODS_FACTS.lagHoursPerSample} h per sample): three gaps in the sampling
            (8 h twice on 10–11 June, 12 h on 12–13 June) put the few pairs that span them
            further apart, by up to 8 h at any lag (e.g. 16–20 h for a 12 h lag, 28–32 h for
            24 h). At the longest lag that is about 1 in 10 of the pairs. For a real
            relationship the kept lag is its delay. When a match is not significant the
            kept lag is mostly chance: the largest of several noisy r values tends to fall at
            the edge of the window, so the panel fades it (in one cached set of 7,848 pairs,
            40% of those with p ≥ 0.05 came out at ±20–24 h, against 10% of those with
            p &lt; 0.05). A lag at the edge of the window is shown as 24h+, since the real delay may
            be longer than the search reaches. Because the best of several tries is kept, that lag’s p-value is
            Bonferroni-corrected — but not always by {N_LAGS}. For smooth series r barely
            changes from one lag to the next, so the {N_LAGS} lags are really only a few
            separate tests. Each pair is charged for the number of separate tests its lags are
            worth (Li &amp; Ji 2005), worked out from how quickly each series changes: close to{' '}
            {N_LAGS} for jumpy series, about 4 for a typical pair, and about 2 for pairs that
            rise or fall together through the bloom. Charging every pair the full {N_LAGS} hid
            real relationships: the five other urease subunits against urease alpha (ureC,
            r = 0.91–0.93, each worth only about 11 independent observations) are significant
            with a correction of 2, but were not with {N_LAGS}.
          </Item>
          <Item title="Which candidates are compared">
            When the reference and the candidates come from the same source, the
            reference’s ancestors and descendants are left out, since their totals contain
            each other’s genes, and so are its siblings (annotations sharing one of its
            immediate parents). KEGG orthologs have no hierarchy here, so a KO leaves out
            only itself: KOs from the same pathway are compared with it, and a top hit may
            simply be a neighbor in the same pathway. Two KOs never count the same gene (in
            every sample, each gene has exactly one KO), so their totals do not contain
            each other.
          </Item>
          <Item title="What a correlation across sources can mean">
            When the candidates come from a different source than the reference, none are
            left out, and the same genes can be behind both annotations: one gene can carry
            a KEGG ortholog, an EC number and a COG at once. A high r then says the two
            annotations count the same genes, not that two separate signals agree.
            Hexokinase (K00844) and EC 2.7.1.1 are the same 154 genes (r = 1.00); every psbA
            gene (K02703) is also counted in EC 1.10.3.9 (r = 0.98), and every ureC gene in
            urease, EC 3.5.1.5 (r = 0.98). (r values here are on EGC; all three methods give
            the same value to within 0.02.)
            <br />
            <br />
            Against taxonomy, a function carried mostly by one group follows that group’s
            abundance: 87% of psbA genes are cyanobacterial, and psbA against Cyanobacteria
            gives r = 0.70 on EGC. That is a real relationship, but it says who carries the
            gene rather than how it is regulated.
            <br />
            <br />
            Relative abundance adds one more effect. Every value in a sample is a share of
            the same total, which varies 6.8-fold between samples, and the taxa at one rank
            make up 94–99% of it. When one group expands (a single genus reaches 21% of the
            annotated signal), the other taxa’s shares fall even if their EGC did not change.
            The same psbA–Cyanobacteria pair drops to r = 0.39–0.53 on relative abundance,
            depending on the method. A negative correlation in relative abundance is worth
            checking against EGC before reading it as a real decline.
          </Item>
          <Item title="False discovery rate and the results list">
            Every candidate in the family is scored unless it shares fewer than 10 detected
            timepoints with the reference at every lag (or does not vary over the ones it
            shares): no correlation can be measured for those, so they are left out of the
            correction, and the panel says how many there were. That can be many: a fifth of
            the KEGG candidates for one KO detected in every sample, a third for one detected
            in only 20 samples. A Benjamini–Hochberg correction is applied across all scored candidates,
            and candidates with q &lt; 0.05 are marked
            significant. The list shows every candidate, significant or not, so weaker
            matches can still be explored: significant candidates first, then the rest, each
            group ranked by |r|. Without that, r values from only a handful of shared
            timepoints could fill the list and push a well-supported significant match out of
            view. It is capped at the top {METHODS_FACTS.familyLimitDefault} (up to{' '}
            {METHODS_FACTS.familyLimitMax} through the API’s limit parameter), and the panel
            shows how many candidates were scored, how many could not be, and how many are
            significant.
          </Item>
        </Section>

        {/* ── Data Sources ── */}
        <Section title="Data Sources">
          <Item title="Samples">
            128 metagenome samples collected roughly every 4 hours (a few gaps of 8–12 h)
            from 27 May to 18 June 2021 at Rosario, Orcas Island, Washington, and sequenced
            and annotated by the DOE Joint Genome Institute (IMG annotation pipeline v5).
            Per sample, the app uses JGI’s per-gene COG, KEGG (KO), EC and taxonomy
            (phylodist) hit files and the scaffold depth file. Sample times, on the charts
            and in every download, are local Pacific Daylight Time (UTC−7) at the sampling
            site; the whole sampling period falls within daylight time.
          </Item>
          <Item title="Annotation names and hierarchies">
            KEGG orthologs: a flat list of the KOs in JGI’s KO hit files, named with the
            product name JGI gives a gene when it names it from that KO. A KO that JGI never
            names that way (its genes were named from a COG or TIGRFAM entry instead) is shown
            by its ID; its KEGG page link gives KEGG’s own name. The app does not use KEGG’s
            pathway hierarchy (BRITE).
            EC hierarchy: built from the EC numbers themselves, named from
            ExPASy ENZYME (release 04-Nov-2026, CC BY 4.0; enzclass.txt and enzyme.dat, with
            a local copy kept so results are reproducible).
            COG category names: NCBI COG. Taxonomic lineages come from JGI’s phylodist
            assignments.
          </Item>
          <Item title="Environmental overlays">
            Tide heights: NOAA CO-OPS station 9449771, predicted every 6 minutes. A chart’s CSV
            gives each sample the tide reading nearest the sample’s time, left blank if none is
            within {TIDE_MATCH_MAX_MINUTES} minutes. Day/night shading: sunrise and sunset
            computed astronomically for the sampling site (48.65° N, 122.85° W).
          </Item>
        </Section>

      </div>
    </div>
  )
}
