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

// KEGG BRITE numeric category/pathway codes → human-readable labels. Every
// real `annotation_catalog`/`annotation_series` kegg `parent` value is a
// bare 5-digit code with no embedded name (confirmed live: 449/449 distinct
// values), so this table is the ONLY source of a readable label for them.
//
// Generated from the real kegg_paths table, not hand-maintained -- every value
// below is each code's own real ko00001.keg name (its ' [PATH:koNNNNN]' /
// ' [BR:koNNNNN]' suffix stripped for display), independently verified
// against every one of the 449 real kegg parent codes in the local db.
//
// Regenerate if ko00001.keg / kegg_paths changes (e.g. a KEGG release
// update): for each distinct bare-code `parent` in `annotation_catalog`
// WHERE source='kegg', look up its own name in `kegg_paths` (try a_id/a_name,
// then b_id/b_name, c_id/c_name, d_id/d_name -- whichever level holds that
// code) and strip the trailing bracketed PATH/BR tag.
export const KEGG_BRITE_CODES: Record<string, string> = {
  '00010': 'Glycolysis / Gluconeogenesis',
  '00020': 'Citrate cycle (TCA cycle)',
  '00030': 'Pentose phosphate pathway',
  '00040': 'Pentose and glucuronate interconversions',
  '00051': 'Fructose and mannose metabolism',
  '00052': 'Galactose metabolism',
  '00053': 'Ascorbate and aldarate metabolism',
  '00061': 'Fatty acid biosynthesis',
  '00062': 'Fatty acid elongation',
  '00071': 'Fatty acid degradation',
  '00073': 'Cutin, suberine and wax biosynthesis',
  '00100': 'Steroid biosynthesis',
  '00121': 'Secondary bile acid biosynthesis',
  '00130': 'Ubiquinone and other terpenoid-quinone biosynthesis',
  '00140': 'Steroid hormone biosynthesis',
  '00190': 'Oxidative phosphorylation',
  '00194': 'Photosynthesis proteins',
  '00199': 'Cytochrome P450',
  '00220': 'Arginine biosynthesis',
  '00230': 'Purine metabolism',
  '00232': 'Caffeine metabolism',
  '00240': 'Pyrimidine metabolism',
  '00250': 'Alanine, aspartate and glutamate metabolism',
  '00260': 'Glycine, serine and threonine metabolism',
  '00261': 'Monobactam biosynthesis',
  '00270': 'Cysteine and methionine metabolism',
  '00280': 'Valine, leucine and isoleucine degradation',
  '00290': 'Valine, leucine and isoleucine biosynthesis',
  '00300': 'Lysine biosynthesis',
  '00310': 'Lysine degradation',
  '00311': 'Penicillin and cephalosporin biosynthesis',
  '00330': 'Arginine and proline metabolism',
  '00331': 'Clavulanic acid biosynthesis',
  '00332': 'Carbapenem biosynthesis',
  '00333': 'Prodigiosin biosynthesis',
  '00340': 'Histidine metabolism',
  '00350': 'Tyrosine metabolism',
  '00360': 'Phenylalanine metabolism',
  '00361': 'Chlorocyclohexane and chlorobenzene degradation',
  '00362': 'Benzoate degradation',
  '00363': 'Bisphenol degradation',
  '00365': 'Furfural degradation',
  '00380': 'Tryptophan metabolism',
  '00400': 'Phenylalanine, tyrosine and tryptophan biosynthesis',
  '00401': 'Novobiocin biosynthesis',
  '00404': 'Staurosporine biosynthesis',
  '00405': 'Phenazine biosynthesis',
  '00410': 'beta-Alanine metabolism',
  '00430': 'Taurine and hypotaurine metabolism',
  '00440': 'Phosphonate and phosphinate metabolism',
  '00450': 'Selenocompound metabolism',
  '00460': 'Cyanoamino acid metabolism',
  '00470': 'D-Amino acid metabolism',
  '00480': 'Glutathione metabolism',
  '00500': 'Starch and sucrose metabolism',
  '00510': 'N-Glycan biosynthesis',
  '00511': 'Other glycan degradation',
  '00513': 'Various types of N-glycan biosynthesis',
  '00520': 'Amino sugar and nucleotide sugar metabolism',
  '00521': 'Streptomycin biosynthesis',
  '00523': 'Polyketide sugar unit biosynthesis',
  '00524': 'Neomycin, kanamycin and gentamicin biosynthesis',
  '00525': 'Acarbose and validamycin biosynthesis',
  '00534': 'Glycosaminoglycan biosynthesis - heparan sulfate / heparin',
  '00535': 'Proteoglycans',
  '00536': 'Glycosaminoglycan binding proteins',
  '00537': 'Glycosylphosphatidylinositol (GPI)-anchored proteins',
  '00541': 'Biosynthesis of various nucleotide sugars',
  '00543': 'Exopolysaccharide biosynthesis',
  '00550': 'Peptidoglycan biosynthesis',
  '00552': 'Teichoic acid biosynthesis',
  '00561': 'Glycerolipid metabolism',
  '00562': 'Inositol phosphate metabolism',
  '00563': 'Glycosylphosphatidylinositol (GPI)-anchor biosynthesis',
  '00564': 'Glycerophospholipid metabolism',
  '00565': 'Ether lipid metabolism',
  '00566': 'Sulfoquinovose metabolism',
  '00571': 'Lipoarabinomannan (LAM) biosynthesis',
  '00572': 'Arabinogalactan biosynthesis - Mycobacterium',
  '00590': 'Arachidonic acid metabolism',
  '00591': 'Linoleic acid metabolism',
  '00592': 'alpha-Linolenic acid metabolism',
  '00600': 'Sphingolipid metabolism',
  '00603': 'Glycosphingolipid biosynthesis - globo and isoglobo series',
  '00620': 'Pyruvate metabolism',
  '00621': 'Dioxin degradation',
  '00622': 'Xylene degradation',
  '00623': 'Toluene degradation',
  '00624': 'Polycyclic aromatic hydrocarbon degradation',
  '00625': 'Chloroalkane and chloroalkene degradation',
  '00626': 'Naphthalene degradation',
  '00627': 'Aminobenzoate degradation',
  '00630': 'Glyoxylate and dicarboxylate metabolism',
  '00633': 'Nitrotoluene degradation',
  '00640': 'Propanoate metabolism',
  '00642': 'Ethylbenzene degradation',
  '00643': 'Styrene degradation',
  '00650': 'Butanoate metabolism',
  '00660': 'C5-Branched dibasic acid metabolism',
  '00670': 'One carbon pool by folate',
  '00680': 'Methane metabolism',
  '00710': 'Carbon fixation by Calvin cycle',
  '00720': 'Other carbon fixation pathways',
  '00730': 'Thiamine metabolism',
  '00740': 'Riboflavin metabolism',
  '00750': 'Vitamin B6 metabolism',
  '00760': 'Nicotinate and nicotinamide metabolism',
  '00770': 'Pantothenate and CoA biosynthesis',
  '00780': 'Biotin metabolism',
  '00785': 'Lipoic acid metabolism',
  '00790': 'Folate biosynthesis',
  '00791': 'Atrazine degradation',
  '00830': 'Retinol metabolism',
  '00860': 'Porphyrin metabolism',
  '00900': 'Terpenoid backbone biosynthesis',
  '00901': 'Indole alkaloid biosynthesis',
  '00902': 'Monoterpenoid biosynthesis',
  '00903': 'Limonene degradation',
  '00904': 'Diterpenoid biosynthesis',
  '00905': 'Brassinosteroid biosynthesis',
  '00906': 'Carotenoid biosynthesis',
  '00907': 'Pinene, camphor and geraniol degradation',
  '00908': 'Zeatin biosynthesis',
  '00909': 'Sesquiterpenoid and triterpenoid biosynthesis',
  '00910': 'Nitrogen metabolism',
  '00920': 'Sulfur metabolism',
  '00930': 'Caprolactam degradation',
  '00940': 'Phenylpropanoid biosynthesis',
  '00941': 'Flavonoid biosynthesis',
  '00943': 'Isoflavonoid biosynthesis',
  '00946': 'Degradation of flavonoids',
  '00960': 'Tropane, piperidine and pyridine alkaloid biosynthesis',
  '00965': 'Betalain biosynthesis',
  '00966': 'Glucosinolate biosynthesis',
  '00970': 'Aminoacyl-tRNA biosynthesis',
  '00975': 'Biosynthesis of various siderophores',
  '00980': 'Metabolism of xenobiotics by cytochrome P450',
  '00982': 'Drug metabolism - cytochrome P450',
  '00983': 'Drug metabolism - other enzymes',
  '00984': 'Steroid degradation',
  '00996': 'Biosynthesis of various alkaloids',
  '00997': 'Biosynthesis of various other secondary metabolites',
  '00998': 'Biosynthesis of various antibiotics',
  '00999': 'Biosynthesis of various plant secondary metabolites',
  '01001': 'Protein kinases',
  '01002': 'Peptidases and inhibitors',
  '01003': 'Glycosyltransferases',
  '01004': 'Lipid biosynthesis proteins',
  '01005': 'Lipopolysaccharide biosynthesis proteins',
  '01006': 'Prenyltransferases',
  '01007': 'Amino acid related enzymes',
  '01008': 'Polyketide biosynthesis proteins',
  '01009': 'Protein phosphatases and associated proteins',
  '01011': 'Peptidoglycan biosynthesis and degradation proteins',
  '01040': 'Biosynthesis of unsaturated fatty acids',
  '01051': 'Biosynthesis of ansamycins',
  '01053': 'Biosynthesis of siderophore group nonribosomal peptides',
  '01055': 'Biosynthesis of vancomycin group antibiotics',
  '01059': 'Biosynthesis of enediyne antibiotics',
  '01501': 'beta-Lactam resistance',
  '01502': 'Vancomycin resistance',
  '01503': 'Cationic antimicrobial peptide (CAMP) resistance',
  '01504': 'Antimicrobial resistance genes',
  '01521': 'EGFR tyrosine kinase inhibitor resistance',
  '01522': 'Endocrine resistance',
  '01523': 'Antifolate resistance',
  '01524': 'Platinum drug resistance',
  '02000': 'Transporters',
  '02010': 'ABC transporters',
  '02020': 'Two-component system',
  '02022': 'Two-component system',
  '02024': 'Quorum sensing',
  '02025': 'Biofilm formation - Pseudomonas aeruginosa',
  '02026': 'Biofilm formation - Escherichia coli',
  '02035': 'Bacterial motility proteins',
  '02042': 'Bacterial toxins',
  '02044': 'Secretion system',
  '02048': 'Prokaryotic defense system',
  '02060': 'Phosphotransferase system (PTS)',
  '03000': 'Transcription factors',
  '03009': 'Ribosome biogenesis',
  '03011': 'Ribosome',
  '03012': 'Translation factors',
  '03013': 'Nucleocytoplasmic transport',
  '03016': 'Transfer RNA biogenesis',
  '03019': 'Messenger RNA biogenesis',
  '03021': 'Transcription machinery',
  '03029': 'Mitochondrial biogenesis',
  '03032': 'DNA replication proteins',
  '03036': 'Chromosome and associated proteins',
  '03037': 'Cilium and associated proteins',
  '03041': 'Spliceosome',
  '03051': 'Proteasome',
  '03060': 'Protein export',
  '03110': 'Chaperones and folding catalysts',
  '03200': 'Viral proteins',
  '03310': 'Nuclear receptors',
  '03320': 'PPAR signaling pathway',
  '03400': 'DNA repair and recombination proteins',
  '03410': 'Base excision repair',
  '04011': 'MAPK signaling pathway - yeast',
  '04013': 'MAPK signaling pathway - fly',
  '04015': 'Rap1 signaling pathway',
  '04016': 'MAPK signaling pathway - plant',
  '04020': 'Calcium signaling pathway',
  '04030': 'G protein-coupled receptors',
  '04031': 'GTP-binding proteins',
  '04040': 'Ion channels',
  '04052': 'Cytokines and neuropeptides',
  '04054': 'Pattern recognition receptors',
  '04070': 'Phosphatidylinositol signaling system',
  '04071': 'Sphingolipid signaling pathway',
  '04072': 'Phospholipase D signaling pathway',
  '04075': 'Plant hormone signal transduction',
  '04090': 'CD molecules',
  '04091': 'Lectins',
  '04111': 'Cell cycle - yeast',
  '04112': 'Cell cycle - Caulobacter',
  '04113': 'Meiosis - yeast',
  '04115': 'p53 signaling pathway',
  '04121': 'Ubiquitin system',
  '04122': 'Sulfur relay system',
  '04131': 'Membrane trafficking',
  '04138': 'Autophagy - yeast',
  '04139': 'Mitophagy - yeast',
  '04140': 'Autophagy - animal',
  '04141': 'Protein processing in endoplasmic reticulum',
  '04142': 'Lysosome biogenesis',
  '04144': 'Endocytosis',
  '04146': 'Peroxisome',
  '04147': 'Exosome',
  '04148': 'Efferocytosis',
  '04150': 'mTOR signaling pathway',
  '04152': 'AMPK signaling pathway',
  '04211': 'Longevity regulating pathway',
  '04212': 'Longevity regulating pathway - worm',
  '04213': 'Longevity regulating pathway - multiple species',
  '04214': 'Apoptosis - fly',
  '04216': 'Ferroptosis',
  '04217': 'Necroptosis',
  '04218': 'Cellular senescence',
  '04260': 'Cardiac muscle contraction',
  '04310': 'Wnt signaling pathway',
  '04320': 'Dorso-ventral axis formation',
  '04340': 'Hedgehog signaling pathway',
  '04341': 'Hedgehog signaling pathway - fly',
  '04360': 'Axon guidance',
  '04361': 'Axon regeneration',
  '04382': 'Cornified envelope formation',
  '04391': 'Hippo signaling pathway - fly',
  '04514': 'Cell adhesion molecule (CAM) interaction',
  '04515': 'Cell adhesion molecules',
  '04517': 'IgSF CAM signaling',
  '04518': 'Integrin signaling',
  '04519': 'Cadherin signaling',
  '04520': 'Adherens junction',
  '04530': 'Tight junction',
  '04550': 'Signaling pathways regulating pluripotency of stem cells',
  '04612': 'Antigen processing and presentation',
  '04621': 'NOD-like receptor signaling pathway',
  '04622': 'RIG-I-like receptor signaling pathway',
  '04623': 'Cytosolic DNA-sensing pathway',
  '04624': 'Toll and Imd signaling pathway',
  '04626': 'Plant-pathogen interaction',
  '04662': 'B cell receptor signaling pathway',
  '04670': 'Leukocyte transendothelial migration',
  '04710': 'Circadian rhythm',
  '04711': 'Circadian rhythm - fly',
  '04712': 'Circadian rhythm - plant',
  '04713': 'Circadian entrainment',
  '04714': 'Thermogenesis',
  '04720': 'Long-term potentiation',
  '04722': 'Neurotrophin signaling pathway',
  '04723': 'Retrograde endocannabinoid signaling',
  '04724': 'Glutamatergic synapse',
  '04725': 'Cholinergic synapse',
  '04727': 'GABAergic synapse',
  '04742': 'Taste transduction',
  '04745': 'Phototransduction - fly',
  '04750': 'Inflammatory mediator regulation of TRP channels',
  '04810': 'Regulation of actin cytoskeleton',
  '04812': 'Cytoskeleton proteins',
  '04820': 'Cytoskeleton in muscle cells',
  '04910': 'Insulin signaling pathway',
  '04913': 'Ovarian steroidogenesis',
  '04916': 'Melanogenesis',
  '04917': 'Prolactin signaling pathway',
  '04918': 'Thyroid hormone synthesis',
  '04919': 'Thyroid hormone signaling pathway',
  '04922': 'Glucagon signaling pathway',
  '04928': 'Parathyroid hormone synthesis, secretion and action',
  '04931': 'Insulin resistance',
  '04932': 'Non-alcoholic fatty liver disease',
  '04933': 'AGE-RAGE signaling pathway in diabetic complications',
  '04934': 'Cushing syndrome',
  '04936': 'Alcoholic liver disease',
  '04940': 'Type I diabetes mellitus',
  '04961': 'Endocrine and other factor-regulated calcium reabsorption',
  '04964': 'Proximal tubule bicarbonate reclamation',
  '04966': 'Collecting duct acid secretion',
  '04970': 'Salivary secretion',
  '04973': 'Carbohydrate digestion and absorption',
  '04974': 'Protein digestion and absorption',
  '04975': 'Fat digestion and absorption',
  '04976': 'Bile secretion',
  '04977': 'Vitamin digestion and absorption',
  '04978': 'Mineral absorption',
  '04979': 'Cholesterol metabolism',
  '04980': 'Cobalamin transport and metabolism',
  '04981': 'Folate transport and metabolism',
  '04990': 'Domain-containing proteins not elsewhere classified',
  '05010': 'Alzheimer disease',
  '05017': 'Spinocerebellar ataxia',
  '05020': 'Prion disease',
  '05022': 'Pathways of neurodegeneration - multiple diseases',
  '05032': 'Morphine addiction',
  '05034': 'Alcoholism',
  '05100': 'Bacterial invasion of epithelial cells',
  '05110': 'Vibrio cholerae infection',
  '05111': 'Biofilm formation - Vibrio cholerae',
  '05120': 'Epithelial cell signaling in Helicobacter pylori infection',
  '05130': 'Pathogenic Escherichia coli infection',
  '05131': 'Shigellosis',
  '05132': 'Salmonella infection',
  '05133': 'Pertussis',
  '05134': 'Legionellosis',
  '05135': 'Yersinia infection',
  '05143': 'African trypanosomiasis',
  '05144': 'Malaria',
  '05145': 'Toxoplasmosis',
  '05146': 'Amoebiasis',
  '05150': 'Staphylococcus aureus infection',
  '05152': 'Tuberculosis',
  '05164': 'Influenza A',
  '05165': 'Human papillomavirus infection',
  '05166': 'Human T-cell leukemia virus 1 infection',
  '05169': 'Epstein-Barr virus infection',
  '05202': 'Transcriptional misregulation in cancer',
  '05203': 'Viral carcinogenesis',
  '05204': 'Chemical carcinogenesis - DNA adducts',
  '05205': 'Proteoglycans in cancer',
  '05207': 'Chemical carcinogenesis - receptor activation',
  '05208': 'Chemical carcinogenesis - reactive oxygen species',
  '05211': 'Renal cell carcinoma',
  '05212': 'Pancreatic cancer',
  '05215': 'Prostate cancer',
  '05216': 'Thyroid cancer',
  '05217': 'Basal cell carcinoma',
  '05219': 'Bladder cancer',
  '05222': 'Small cell lung cancer',
  '05223': 'Non-small cell lung cancer',
  '05225': 'Hepatocellular carcinoma',
  '05230': 'Central carbon metabolism in cancer',
  '05231': 'Choline metabolism in cancer',
  '05320': 'Autoimmune thyroid disease',
  '05322': 'Systemic lupus erythematosus',
  '05323': 'Rheumatoid arthritis',
  '05340': 'Primary immunodeficiency',
  '05414': 'Dilated cardiomyopathy',
  '05415': 'Diabetic cardiomyopathy',
  '05416': 'Viral myocarditis',
  '05417': 'Lipid and atherosclerosis',
  '05418': 'Fluid shear stress and atherosclerosis',
  '09100': 'Metabolism',
  '09101': 'Carbohydrate metabolism',
  '09102': 'Energy metabolism',
  '09103': 'Lipid metabolism',
  '09104': 'Nucleotide metabolism',
  '09105': 'Amino acid metabolism',
  '09106': 'Metabolism of other amino acids',
  '09107': 'Glycan biosynthesis and metabolism',
  '09108': 'Metabolism of cofactors and vitamins',
  '09109': 'Metabolism of terpenoids and polyketides',
  '09110': 'Biosynthesis of other secondary metabolites',
  '09111': 'Xenobiotics biodegradation and metabolism',
  '09120': 'Genetic Information Processing',
  '09121': 'Transcription',
  '09122': 'Translation',
  '09123': 'Folding, sorting and degradation',
  '09124': 'Replication and repair',
  '09125': 'Information processing in viruses',
  '09126': 'Chromosome',
  '09130': 'Environmental Information Processing',
  '09131': 'Membrane transport',
  '09132': 'Signal transduction',
  '09133': 'Signaling molecules and interaction',
  '09140': 'Cellular Processes',
  '09141': 'Transport and catabolism',
  '09142': 'Cell motility',
  '09143': 'Cell growth and death',
  '09144': 'Cellular community - eukaryotes',
  '09145': 'Cellular community - prokaryotes',
  '09149': 'Aging',
  '09150': 'Organismal Systems',
  '09151': 'Immune system',
  '09152': 'Endocrine system',
  '09153': 'Circulatory system',
  '09154': 'Digestive system',
  '09155': 'Excretory system',
  '09156': 'Nervous system',
  '09157': 'Sensory system',
  '09158': 'Development and regeneration',
  '09159': 'Environmental adaptation',
  '09160': 'Human Diseases',
  '09161': 'Cancer: overview',
  '09162': 'Cancer: specific types',
  '09163': 'Immune disease',
  '09164': 'Neurodegenerative disease',
  '09165': 'Substance dependence',
  '09166': 'Cardiovascular disease',
  '09167': 'Endocrine and metabolic disease',
  '09171': 'Infectious disease: bacterial',
  '09172': 'Infectious disease: viral',
  '09174': 'Infectious disease: parasitic',
  '09175': 'Drug resistance: antimicrobial',
  '09176': 'Drug resistance: antineoplastic',
  '09180': 'Brite Hierarchies',
  '09181': 'Protein families: metabolism',
  '09182': 'Protein families: genetic information processing',
  '09183': 'Protein families: signaling and cellular processes',
  '09185': 'Viral protein families',
  '09190': 'Not Included in Pathway or Brite',
  '09191': 'Unclassified: metabolism',
  '09192': 'Unclassified: genetic information processing',
  '09193': 'Unclassified: signaling and cellular processes',
  '09194': 'Poorly characterized',
  '99973': 'Transcription',
  '99974': 'Translation',
  '99975': 'Protein processing',
  '99976': 'Replication and repair',
  '99977': 'Transport',
  '99978': 'Cell growth',
  '99980': 'Enzymes with EC numbers',
  '99981': 'Carbohydrate metabolism',
  '99982': 'Energy metabolism',
  '99983': 'Lipid metabolism',
  '99984': 'Nucleotide metabolism',
  '99985': 'Amino acid metabolism',
  '99986': 'Glycan metabolism',
  '99987': 'Cofactor metabolism',
  '99988': 'Secondary metabolism',
  '99992': 'Structural proteins',
  '99993': 'Cell motility',
  '99994': 'Others',
  '99995': 'Signaling proteins',
  '99996': 'General function prediction only',
  '99997': 'Function unknown',
  '99998': 'Others',
  '99999': 'Others',
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
export function taxonomyRankLabel(depth: number | null, _domain?: string | null): string {
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