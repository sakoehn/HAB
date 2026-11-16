"""
test_download_expasy_enzyme.py
================================
download_expasy_enzyme.py must not write an HTTP response straight over
the good saved copies of enzclass.txt / enzyme.dat after only
raise_for_status() -- a 200 response carrying an HTML error page or a
truncated body would silently replace them. These tests fake the download
(no network) and point the script at a temp dir (the real saved files are
never touched).

Run:
    pytest tests/test_download_expasy_enzyme.py -v
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from scripts import download_expasy_enzyme as dl  # pylint: disable=wrong-import-position

CLASSES = [
    "Oxidoreductases", "Transferases", "Hydrolases", "Lyases",
    "Isomerases", "Ligases", "Translocases",
]
GOOD_CACHED = "previously saved good file\n"


def _enzclass(classes=CLASSES, release="04-Nov-2026"):
    """Minimal enzclass.txt-shaped text."""
    lines = ["Description: Definition of enzyme classes", f"Release:     {release}", ""]
    for i, name in enumerate(classes, start=1):
        lines.append(f"{i}. -. -.-  {name}.")
        lines.append(f"{i}. 1. -.-   Some subclass.")
        lines.append(f"{i}. 1. 1.-    Some sub-subclass.")
    return "\n".join(lines) + "\n"


def _enzyme_dat(entries=dl.MIN_ENTRIES, release="04-Nov-2026"):
    """Minimal enzyme.dat-shaped text with `entries` ID records."""
    lines = ["CC   -----", f"CC   Release of {release}", "//"]
    for j in range(entries):
        lines += [f"ID   1.1.1.{j + 1}", f"DE   enzyme {j}.", "//"]
    return "\n".join(lines) + "\n"


class _FakeResponse:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        return None


@pytest.fixture
def fake_env(tmp_path, monkeypatch):
    """Redirect output to tmp_path, seed 'good' saved files, and let each
    test choose what the fake downloads return."""
    paths = {name: tmp_path / name for name in dl.FILES}
    for p in paths.values():
        p.write_text(GOOD_CACHED, encoding="latin-1")
    meta = tmp_path / dl.META_NAME
    monkeypatch.setattr(dl, "ENZYME_DIR", str(tmp_path))

    def serve(enzclass, enzyme_dat):
        bodies = {dl.FILES["enzclass.txt"]: enzclass, dl.FILES["enzyme.dat"]: enzyme_dat}
        monkeypatch.setattr(dl.requests, "get", lambda url, **k: _FakeResponse(bodies[url]))

    return paths, meta, serve


# ── The checks on their own ────────────────────────────────────────────────

def test_valid_files_pass_and_report_their_release():
    assert dl.validate_enzclass(_enzclass()) == "04-Nov-2026"
    assert dl.validate_enzyme_dat(_enzyme_dat()) == "04-Nov-2026"


def test_real_saved_files_pass_if_present():
    """The real files this guard protects must themselves pass it."""
    base = os.path.join(os.path.dirname(__file__), "..", "DataStructures", "Enzyme")
    enzclass = os.path.join(base, "enzclass.txt")
    enzyme_dat = os.path.join(base, "enzyme.dat")
    if not (os.path.exists(enzclass) and os.path.exists(enzyme_dat)):
        pytest.skip("real ExPASy files not present")
    with open(enzclass, encoding="latin-1") as f:
        dl.validate_enzclass(f.read())
    with open(enzyme_dat, encoding="latin-1") as f:
        dl.validate_enzyme_dat(f.read())


@pytest.mark.parametrize("text", [
    "<!DOCTYPE html><html><body>Service Unavailable</body></html>",
    "",
    _enzclass(classes=CLASSES[:6]),
    _enzclass(classes=CLASSES + ["Something New"]),
    _enzclass(classes=[CLASSES[1], CLASSES[0]] + CLASSES[2:]),
    _enzclass(release=""),
], ids=["html", "empty", "six_classes", "eight_classes", "out_of_order", "no_release"])
def test_invalid_enzclass_is_rejected(text):
    with pytest.raises(ValueError):
        dl.validate_enzclass(text)


@pytest.mark.parametrize("text", [
    "<!DOCTYPE html><html><body>Service Unavailable</body></html>",
    "",
    _enzyme_dat(entries=dl.MIN_ENTRIES - 1),
    _enzyme_dat(release=""),
], ids=["html", "empty", "too_few_entries", "no_release"])
def test_invalid_enzyme_dat_is_rejected(text):
    with pytest.raises(ValueError):
        dl.validate_enzyme_dat(text)


# ── download_expasy_enzyme end to end ──────────────────────────────────────

def test_valid_download_replaces_both_files_and_writes_meta(fake_env):
    paths, meta, serve = fake_env
    enzclass, enzyme_dat = _enzclass(), _enzyme_dat()
    serve(enzclass, enzyme_dat)
    dl.download_expasy_enzyme()
    assert paths["enzclass.txt"].read_text(encoding="latin-1") == enzclass
    assert paths["enzyme.dat"].read_text(encoding="latin-1") == enzyme_dat
    m = json.loads(meta.read_text(encoding="utf-8"))
    assert m["release"] == "04-Nov-2026"
    assert m["source_urls"] == list(dl.FILES.values())
    assert m["license"] == "CC BY 4.0"
    assert {p.name for p in meta.parent.iterdir()} == {*dl.FILES, meta.name}, "temp file left behind"


def test_files_from_two_different_releases_are_refused(fake_env):
    paths, meta, serve = fake_env
    serve(_enzclass(release="04-Nov-2026"), _enzyme_dat(release="07-Oct-2026"))
    with pytest.raises(ValueError, match="release"):
        dl.download_expasy_enzyme()
    assert paths["enzclass.txt"].read_text(encoding="latin-1") == GOOD_CACHED
    assert not meta.exists()


@pytest.mark.parametrize("bad", ["enzclass", "enzyme_dat"])
def test_one_bad_file_leaves_both_saved_files_and_meta_untouched(fake_env, bad):
    paths, meta, serve = fake_env
    html = "<!DOCTYPE html><html><body>Service Unavailable</body></html>"
    serve(html if bad == "enzclass" else _enzclass(),
          html if bad == "enzyme_dat" else _enzyme_dat())
    with pytest.raises(ValueError):
        dl.download_expasy_enzyme()
    for p in paths.values():
        assert p.read_text(encoding="latin-1") == GOOD_CACHED
    assert not meta.exists()
    assert {p.name for p in meta.parent.iterdir()} == set(dl.FILES), "temp file left behind"
