# HAB Portal — EGC Validation Test Suite

Tests that verify your computed EGC values match JGI's published
estimated-gene-copy files for both COG and KEGG annotation systems.

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
