"""Where the server finds the built UI and its data dir: installed wheel vs source checkout."""

from pathlib import Path

from deltadeck import config
from deltadeck.config import default_data_dir, find_ui_dir


def _checkout(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    (repo / "server" / "deltadeck").mkdir(parents=True)
    (repo / "pyproject.toml").write_text("[project]\n")
    return repo


def test_ui_bundled_in_package_wins(tmp_path):
    pkg, repo = tmp_path / "pkg", _checkout(tmp_path)
    (pkg / "ui").mkdir(parents=True)
    (pkg / "ui" / "index.html").write_text("<html>")
    (repo / "web" / "out").mkdir(parents=True)
    (repo / "web" / "out" / "index.html").write_text("<html>")
    assert find_ui_dir(pkg, repo) == str(pkg / "ui")


def test_ui_falls_back_to_checkout_web_out(tmp_path):
    pkg, repo = tmp_path / "pkg", _checkout(tmp_path)
    (pkg / "ui").mkdir(parents=True)  # empty: no index.html, not a build
    assert find_ui_dir(pkg, repo) == str(repo / "web" / "out")


def test_ui_missing_everywhere_names_web_out(tmp_path):
    """The 503 hint then points at web/out."""
    assert find_ui_dir(tmp_path / "pkg", tmp_path / "repo") == str(tmp_path / "repo" / "web" / "out")


def test_data_dir_in_checkout_is_dot_data(tmp_path):
    repo = _checkout(tmp_path)
    assert default_data_dir(repo) == str(repo / ".data")


def test_data_dir_when_installed_is_per_user(tmp_path, monkeypatch):
    monkeypatch.setattr(config.sys, "platform", "linux")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    site = tmp_path / "site-packages"  # an installed package: no pyproject.toml above it
    assert default_data_dir(site) == str(tmp_path / "xdg" / "deltadeck")
