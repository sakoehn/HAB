"""
weighted_totals.py
===================
Shared, cross-source norm_egc denominator for the four EGC_*_TREE.ipynb
notebooks (COG, KEGG, Enzyme, Taxonomy).

Each notebook used to compute egc / its own scoped total, built only from
genes annotated by that one source (e.g. KEGG's denominator came only from
KEGG-annotated genes). That means norm_egc could not be compared across
annotation types on the same plot -- KEGG's "% of signal" and Taxonomy's
"% of signal" weren't measuring the same signal. This module fixes that by
computing ONE total per sample, shared by all four notebooks.

Formula
-------
    weighted_total[sample] = Sigma(gene_count_on_scaffold * AvgFold)
        summed over every scaffold in the sample

`gene_count_on_scaffold` comes from DataStructures/Mappings_by_Sample/
<sample>_mapping.tsv -- one row per gene, with an explicit scaffold_id
column (no derivation from gene_id needed). `AvgFold` comes from
Notebooks/All_Coverages.py's `allfold`.

Deliberate scope limitation
----------------------------
The mapping TSV only includes genes with at least one annotation across
taxonomy/KEGG/enzyme/COG -- it is NOT every gene JGI called in the
assembly. Checked against .faa/.gff (the true universe of predicted genes)
for a few samples: 27-48% of all predicted genes have zero hits across all
four sources and are absent from the mapping TSV entirely. That means
norm_egc represents "% of the annotated signal," not "% of all signal in
the sample" -- a deliberate choice (the app never surfaces unannotated
genes as their own category), not an oversight.

Usage
-----
Each of the four EGC notebooks calls this explicitly -- there is no
ready-made module-level variable to import, since `calculate_denominator_egc`
builds a fresh dict per call rather than caching one at import time:

    from weighted_totals import calculate_denominator_egc
    weighted_totals = calculate_denominator_egc(samples)
    # weighted_totals[sample] -> float, the shared denominator

Note importing this module also imports All_Coverages, which reads all 128
real .a.depth.txt files as a side effect of being imported -- there is no
way to import weighted_totals without the real data root present.
"""
from pathlib import Path
from collections import defaultdict
import pandas as pd
import sys
sys.path.append(r"C:\Users\sakoehn\Desktop\JGI\Notebooks")
from All_Coverages import allfold

BASE_DIR = Path(__file__).parent

def get_sample_names():
    """Reads the canonical sample list from sample_names.txt -- the same
    file All_Coverages.py and the four EGC_*_TREE.ipynb notebooks read, so
    this returns the exact same samples they process.

    Returns:
        List of sample ID strings, in file order, whitespace-stripped.
    """
    with open(BASE_DIR.parent / "sample_names.txt") as f:
        samples = [s.strip() for s in f]
    print(f"Loaded {len(samples)} samples")
    return samples

def get_gene_counts(samples: list):
    """Tallies gene count per scaffold per sample from the mapping TSVs.

    Reads DataStructures/Mappings_by_Sample/<sample>_mapping.tsv for each
    sample and counts occurrences of each scaffold_id in that column --
    the column is NOT deduplicated, it's one row per gene, so a scaffold
    with N genes has its scaffold_id repeated N times and tallies to N.

    Args:
        samples: Sample ID strings to process, e.g. from get_sample_names().

    Returns:
        {sample: {scaffold_id: gene_count}} -- gene_count is the number of
        genes on that scaffold with at least one annotation (taxonomy,
        KEGG, enzyme, or COG) across any source, since that's what the
        mapping TSV itself covers (see module docstring's scope
        limitation).
    """
    gene_counts = {}
    for s in samples:
        with open(BASE_DIR.parent / "DataStructures" / "Mappings_by_Sample" / f"{s}_mapping.tsv") as f:
            map = pd.read_csv(f, sep='\t')
        ids = map['scaffold_id']
        gene_counts[s] = {}
        for scaff in ids:
            if scaff not in gene_counts[s].keys():
                gene_counts[s][scaff] = 1
            else:
                gene_counts[s][scaff] += 1
    return gene_counts

def calculate_denominator_egc(samples: list):
    """Computes the shared, cross-source norm_egc denominator per sample.

    weighted_total[sample] = Sigma(gene_count_on_scaffold * AvgFold),
    summed over every scaffold in the sample -- gene_count_on_scaffold
    from get_gene_counts(), AvgFold from All_Coverages.allfold. Builds a
    fresh dict on every call; no state is shared or cached across calls.

    Args:
        samples: Sample ID strings to compute a denominator for.

    Returns:
        {sample: float} -- the shared denominator each of the four
        EGC_*_TREE.ipynb notebooks divides its own egc by to get norm_egc.

    Raises:
        KeyError: if a scaffold present in a sample's mapping TSV has no
            matching entry in allfold[sample]. Deliberate: a missing
            scaffold should fail loudly rather than silently contribute 0
            to the denominator.
    """
    gene_counts = get_gene_counts(samples)
    weighted_totals = {}
    for s in samples:
        weighted_totals[s] = 0
        for scaff, cnt in gene_counts[s].items():
            weighted_totals[s] += cnt * allfold[s][scaff] 
    return weighted_totals

def __main__ ():
    """Entry point for running this file directly: computes the shared
    denominator for every sample and reports completion.

    Only runs when this file is executed as a script (see the
    `if __name__ == '__main__':` guard below) -- not triggered on import,
    so the four notebooks that `import weighted_totals` never run this as
    a side effect of importing.

    Returns:
        {sample: float}, same shape as calculate_denominator_egc().
    """
    samples = get_sample_names()
    weighted_totals = calculate_denominator_egc(samples)
    print("calcuated all sample egc denominators")
    return weighted_totals

if __name__ == '__main__':
    __main__()