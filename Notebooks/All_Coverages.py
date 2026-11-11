import csv, json
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent  # repo root -- this file lives in Notebooks/

with open(BASE_DIR / 'sample_names.txt') as f:
    samples = [sample.strip() for sample in f]


allfold = {sample: {} for sample in samples}

for tp in samples:
    base = BASE_DIR / "Metagenome_Samples"
    filename = base / tp / f"{tp}.a.depth.txt"
    total_cov = 0

    seen_scaffolds = set()
    with open(filename, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or line == 'ID\tAvgFold':
                continue

            parts = line.split('\t')
            # Every other line must be a gene and its depth: skipping one
            # would lose that scaffold's depth and quietly change its EGC.
            if not line[0] == 'G' or len(parts) < 2:
                raise ValueError(f"{filename}: unexpected line {line[:80]!r}")
                
            gene, cov = parts[0], float(parts[1])
            scaffold = '_'.join(gene.split('_', 2)[:2])
            
            if scaffold not in seen_scaffolds:
                allfold[tp][scaffold] = cov
                total_cov += cov
                seen_scaffolds.add(scaffold)
            

    allfold[tp]['total'] = total_cov
    

    seen_scaffolds.clear()  # Free memory immediately


