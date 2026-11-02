"""Wheel build hook: ship the built web UI (web/out) as deltadeck/ui.

Editable installs (uv sync) skip this and read web/out in place."""

import os

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class UiBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version, build_data):
        if version == "editable":
            return
        out = os.path.join(self.root, "web", "out")
        if not os.path.isfile(os.path.join(out, "index.html")):
            raise RuntimeError(f"web UI not built ({out}/index.html missing): "
                               "run 'npm ci && npm run build' in web/ before building the wheel")
        build_data["force_include"][out] = "deltadeck/ui"
