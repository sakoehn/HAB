import csv, json
from pathlib import Path

with open(r'C:\Users\sakoehn\Desktop\JGI\sample_names.txt') as f:
    samples = [sample.strip() for sample in f]


allfold = {sample: {} for sample in samples} 

for tp in samples:
    base = Path(r"C:\Users\sakoehn\Desktop\JGI\Metagenome_Samples")
    filename = base / tp / f"{tp}.a.depth.txt"
    total_cov = 0

    seen_scaffolds = set()
    with open(filename, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or not line[0] == 'G':
                continue
                
            parts = line.split('\t')
            if len(parts) < 2:
                continue
                
            gene, cov = parts[0], float(parts[1])
            scaffold = '_'.join(gene.split('_', 2)[:2])
            
            if scaffold not in seen_scaffolds:
                allfold[tp][scaffold] = cov
                total_cov += cov
                seen_scaffolds.add(scaffold)
            

    allfold[tp]['total'] = total_cov
    

    seen_scaffolds.clear()  # Free memory immediately


