"""
test_download_enzyme_brite.py
===============================
P9 (docs/AUDIT-2026-10-05.md): download_enzyme_brite.py used to write the
HTTP response straight over the good cached ko01000.keg after only
raise_for_status() -- a 200 response carrying an HTML error page or a
truncated body would silently replace it. These tests fake the download
(no network) and point the script at a temp dir (the real cached file is
never touched).

Run:
    pytest tests/test_download_enzyme_brite.py -v
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from scripts import download_enzyme_brite as dl  # pylint: disable=wrong-import-position

CLASSES = [
    "1. Oxidoreductases", "2. Transferases", "3. Hydrolases", "4. Lyases",
    "5. Isomerases", "6. Ligases", "7. Translocases",
]
GOOD_CACHED = "previously cached good file\n"


def _brite(classes=CLASSES, d_lines=dl.MIN_D_LINES):
    """Minimal ko01000.keg-shaped text: header, A/B/C/D lines like the real file."""
    lines = ["+E\tEnzyme", "!"]
    per_class = -(-d_lines // len(classes))  # ceil
    written = 0
    for i, name in enumerate(classes, start=1):
        lines.append(f"A<b>{name}</b>")
        lines.append(f"B  {i}.1  Some subclass")
        lines.append(f"C    {i}.1.1  Some sub-subclass")
        for j in range(per_class):
            if written == d_lines:
                break
            lines.append(f"D      {i}.1.1.{j + 1}  enzyme {j}")
            written += 1
    lines.append("!")
    return "\n".join(lines) + "\n"


class _FakeResponse:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        return None


@pytest.fixture
def fake_env(tmp_path, monkeypatch):
    """Redirect output to tmp_path, seed a 'good' cached file, and let each
    test choose what the fake download returns."""
    out = tmp_path / "ko01000.keg"
    meta = tmp_path / "ko01000.keg.meta.json"
    out.write_text(GOOD_CACHED, encoding="utf-8")
    monkeypatch.setattr(dl, "ENZYME_DIR", str(tmp_path))
    monkeypatch.setattr(dl, "OUTPUT_PATH", str(out))
    monkeypatch.setattr(dl, "META_PATH", str(meta))

    def serve(text):
        monkeypatch.setattr(dl.requests, "get", lambda *a, **k: _FakeResponse(text))

    return out, meta, serve


# ── validate_brite_text on its own ─────────────────────────────────────────

def test_valid_brite_text_passes():
    dl.validate_brite_text(_brite())


def test_real_cached_file_passes_if_present():
    """The real file this guard protects must itself pass the guard."""
    real = os.path.join(os.path.dirname(__file__), "..", "DataStructures", "Enzyme", "ko01000.keg")
    if not os.path.exists(real):
        pytest.skip("real ko01000.keg not present")
    with open(real, encoding="utf-8") as f:
        dl.validate_brite_text(f.read())


@pytest.mark.parametrize("text, why", [
    ("<!DOCTYPE html><html><body>Service Unavailable</body></html>", "html error page"),
    ("", "empty body"),
    (_brite(classes=CLASSES[:6]), "missing class 7 (truncated)"),
    (_brite(classes=CLASSES + ["8. Something New"]), "unexpected 8th class"),
    (_brite(classes=[CLASSES[1], CLASSES[0]] + CLASSES[2:]), "classes out of order"),
    (_brite(d_lines=dl.MIN_D_LINES - 1), "too few EC (D) lines"),
], ids=lambda v: v if isinstance(v, str) and len(v) < 40 else "")
def test_invalid_brite_text_is_rejected(text, why):
    with pytest.raises(ValueError):
        dl.validate_brite_text(text)


# ── download_enzyme_brite end to end ──────────────────────────────────────

def test_valid_download_replaces_file_and_writes_meta(fake_env):
    out, meta, serve = fake_env
    text = _brite()
    serve(text)
    assert dl.download_enzyme_brite() == str(out)
    assert out.read_text(encoding="utf-8") == text
    assert json.loads(meta.read_text(encoding="utf-8"))["source_url"] == dl.BRITE_URL
    assert {p.name for p in out.parent.iterdir()} == {out.name, meta.name}, "temp file left behind"


@pytest.mark.parametrize("bad", [
    "<!DOCTYPE html><html><body>Service Unavailable</body></html>",
    _brite(classes=CLASSES[:6]),
], ids=["html_error_page", "truncated_6_classes"])
def test_bad_download_leaves_cached_file_and_meta_untouched(fake_env, bad):
    out, meta, serve = fake_env
    serve(bad)
    with pytest.raises(ValueError):
        dl.download_enzyme_brite()
    assert out.read_text(encoding="utf-8") == GOOD_CACHED
    assert not meta.exists()
    assert {p.name for p in out.parent.iterdir()} == {out.name}, "temp file left behind"
