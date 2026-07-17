from __future__ import annotations

import json
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class _PopupParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.main_count = 0
        self.tabs: list[dict[str, str | None]] = []
        self.panels: list[dict[str, str | None]] = []
        self.live_regions = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "main":
            self.main_count += 1
        if attributes.get("role") == "tab":
            self.tabs.append(attributes)
        if attributes.get("role") == "tabpanel":
            self.panels.append(attributes)
        if attributes.get("aria-live") == "polite":
            self.live_regions += 1


def test_manifest_uses_least_privilege_mv3_metadata() -> None:
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))

    assert manifest["manifest_version"] == 3
    assert int(manifest["minimum_chrome_version"]) >= 116
    assert "tabs" not in manifest["permissions"]
    assert "host_permissions" not in manifest
    assert set(manifest["optional_host_permissions"]) == {
        "http://localhost/*",
        "http://127.0.0.1/*",
        "http://[::1]/*",
    }
    csp = manifest["content_security_policy"]["extension_pages"]
    assert "script-src 'self'" in csp
    assert "object-src 'none'" in csp


def test_popup_has_one_main_landmark_and_complete_tab_semantics() -> None:
    parser = _PopupParser()
    parser.feed((ROOT / "extension" / "popup.html").read_text(encoding="utf-8"))

    assert parser.main_count == 1
    assert len(parser.tabs) == len(parser.panels) == 4
    assert [tab["aria-selected"] for tab in parser.tabs] == ["true", "false", "false", "false"]
    assert {tab["aria-controls"] for tab in parser.tabs} == {panel["id"] for panel in parser.panels}
    assert all(panel.get("aria-labelledby") for panel in parser.panels)
    assert parser.live_regions >= 3
