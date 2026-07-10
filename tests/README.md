# HAB Portal — EGC Validation Test Suite

Tests that verify your computed EGC values match JGI's published
estimated-gene-copy files for both COG and KEGG annotation systems.

---

## What's being tested, in plain language

The backend has a folder of automated checks ("tests") that run without any
human clicking around the website. Each check either passes or fails, and
together they catch mistakes before they reach real users. Here's what each
file is responsible for:

- **`conftest.py`** — Not a test by itself. This is the shared setup file:
  it tells all the other checks where to find the data on disk, what counts
  as an acceptable rounding difference, and provides some reusable helper
  logic. Think of it as the shared toolbox the other files borrow from.

- **`test_jgi_file_parsing.py`** — Before comparing anything, this makes
  sure JGI's own original data files (the outside "ground truth" the rest of
  the system is judged against) can actually be opened, aren't empty or
  corrupted, and are laid out the way everything downstream expects. If
  these fail, no other comparison in the suite can be trusted.

- **`test_annotation_trees.py`** — Checks the per-sample data files the
  backend builds for each classification system (KEGG, COG, Enzyme, and
  Taxonomy). It confirms those files are structured correctly and that the
  gene-abundance numbers inside them match JGI's original published numbers,
  within a small acceptable margin of rounding error.

- **`test_egc_api_vs_jgi.py`** — Same idea as above, but tests the *live*
  website/API instead of the files on disk. It asks the running backend for
  gene-abundance values the way a user's browser would, and checks the
  answers match JGI's originals. This one only runs when the backend server
  is actually running; it skips itself automatically otherwise.

- **`test_mappings_notebook_matches.py`** — The system builds lookup tables
  that connect each gene to its taxonomy, KEGG, enzyme, and COG
  classifications. This check independently redoes that matching process
  from the original source data and compares the result to the lookup
  tables the system actually produced, to make sure nothing got dropped or
  mismatched along the way.

- **`test_correlation_output.py`** — Verifies the math behind the "find
  related genes/organisms" feature. It checks the statistical steps
  (normalizing values, calculating correlation, detecting time lags between
  two signals, and estimating how likely a result is due to random chance)
  by comparing this project's calculations against a well-established,
  independent statistics library.

- **`test_main_scaffolds.py`** — Checks the parts of the website that show
  which DNA fragments ("scaffolds") a given annotation was found on, and the
  summary counts for those. It runs the real backend logic against safe,
  made-up sample data rather than the live dataset, so it can check exact,
  predictable answers.

- **`test_batch2_backend.py`** — A collection of checks tied to a specific
  round of bug fixes: that the date range shown on the status page is
  correct, that mapping search results come back quickly and include a
  timestamp, and that the correlation feature doesn't break or give wrong
  answers when multiple requests come in at the same time.

- **`test_unit_backend.py`** — The broadest set of checks, covering many
  small individual building blocks across the backend: reading and sorting
  dates, pulling names/values out of annotation records, searching,
  calculating sunrise/sunset times, paging through result lists, and most of
  the website's API endpoints. It uses safe made-up sample data so it runs
  fast and doesn't depend on the real dataset, and its main job is catching
  accidental breakage whenever the backend code is restructured.

Note: two earlier files referenced later in this document
(`test_egc_json_vs_jgi.py` and `test_tides_and_suntimes.py`) have since been
removed/consolidated — the list above reflects the current set of files.

---

## Directory layout

```
project-root/
├── pytest.ini                          ← pytest config (place here)
├── tests/
│   ├── conftest.py                     ← shared fixtures & path config
│   ├── test_jgi_file_parsing.py        ← Phase 1: ground-truth files are valid
│   ├── test_egc_json_vs_jgi.py         ← Phase 2/3: JSON files vs JGI (no server)
│   └── test_egc_api_vs_jgi.py          ← Phase 3: live API vs JGI (server needed)
```

---

## Setup

```bash
pip install pytest pytest-asyncio httpx
```

---

## Configuration

The default data path is `C:/Users/sakoehn/Desktop/JGI`.
Override without editing files via environment variables:

```bat
# Windows
set HAB_DATA_ROOT=C:\path\to\your\JGI
set HAB_API_URL=http://localhost:8000
set HAB_EGC_TOLERANCE=0.5

# Mac / Linux
export HAB_DATA_ROOT=/path/to/your/JGI
export HAB_API_URL=http://localhost:8000
export HAB_EGC_TOLERANCE=0.5
```

The test suite expects this structure inside `HAB_DATA_ROOT`:

```
JGI/
├── COG_genes/
│   ├── cog_estimatedgenecopies_1.txt   ← samples 1–64   (JGI ground truth)
│   ├── cog_estimatedgenecopies_2.txt   ← samples 65–128 (JGI ground truth)
│   └── data/                           ← your backend's COG JSON files
│       ├── 3300060410.json
│       └── ...
└── KEGG/
    ├── kegg_estimatedgenecopies_1.txt  ← samples 1–64   (JGI ground truth)
    ├── kegg_estimatedgenecopies_2.txt  ← samples 65–128 (JGI ground truth)
    └── data/                           ← your backend's KEGG JSON files
        ├── 3300060410.json
        └── ...
```

---

## Running tests

### All tests (server optional — API tests auto-skip if offline)
```bash
pytest
```

### Phase 1 only — verify JGI files parse correctly (no server, no JSON needed)
```bash
pytest tests/test_jgi_file_parsing.py -v
```

### Phase 2/3 disk — verify JSON files match JGI (no server needed)
```bash
pytest tests/test_egc_json_vs_jgi.py -v
```

### Phase 3 API — verify live API matches JGI (server must be running)
```bash
# Start your FastAPI server first:
#   cd FastAPI && uvicorn main:app --reload
pytest tests/test_egc_api_vs_jgi.py -v
```

### Run only COG or KEGG tests
```bash
pytest -k "cog" -v
pytest -k "kegg" -v
```

### Run only spot-check tests (fast subset)
```bash
pytest -k "spot_check" -v
```

---

## What each phase tests

| Phase | File | Requires | What it checks |
|-------|------|----------|----------------|
| 1 | `test_jgi_file_parsing.py` | JGI `.txt` files on disk | Files exist, parse cleanly, correct IDs, 128 samples after merge, known values match screenshot |
| 2/3 disk | `test_egc_json_vs_jgi.py` | JGI files + backend JSON | Every annotation × sample EGC matches JGI within tolerance |
| 3 API | `test_egc_api_vs_jgi.py` | JGI files + running server | `/series/annotations` and `/samples/<id>/<source>` return correct EGC values |

---

## Tolerance

`EGC_TOLERANCE` (default `0.5`) is the maximum allowed absolute difference
between a backend EGC value and the JGI value.  JGI files store integers;
your backend may carry minor floating-point rounding.  `0.5` is conservative
— tighten to `0.01` once you confirm exact integer storage.

---

## Adding more tests

- **New annotation spot-check**: add a method to `TestCOGJsonVsJGI` or
  `TestKEGGApiSeriesVsJGI` following the existing pattern.
- **New endpoint**: add a helper in `test_egc_api_vs_jgi.py` that calls the
  endpoint and feeds the result through the same JGI comparison loop.
- **Enzyme / Taxonomy**: duplicate `conftest.py` fixtures and a new test file
  following the same three-phase structure.
