#!/usr/bin/env python3
"""Generate the macOS .icns from the canonical app PNGs.

The PNG set in src-tauri/icons is the source of truth (the same artwork used by
the Windows ICO). This script only packages it into the ICNS container; it does
not redraw the icon. Requires Pillow:

    python tools/gen-icns.py
"""
from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"

# type, size, optional exact source file (otherwise resize the 256px master)
SLOTS = [
    ("icp4", 16, None),
    ("icp5", 32, "32x32.png"),
    ("icp6", 64, None),
    ("ic07", 128, "128x128.png"),
    ("ic08", 256, "128x128@2x.png"),
    ("ic09", 512, None),
    ("ic10", 1024, None),
    ("ic11", 32, "32x32.png"),
    ("ic12", 64, None),
    ("ic13", 256, "128x128@2x.png"),
    ("ic14", 512, None),
]


def png_bytes(master: Image.Image, size: int, exact: str | None) -> bytes:
    if exact:
        return (ICONS / exact).read_bytes()
    image = master if master.width == size else master.resize((size, size), Image.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def main() -> None:
    master = Image.open(ICONS / "128x128@2x.png").convert("RGBA")
    elements = []
    for type_name, size, exact in SLOTS:
        data = png_bytes(master, size, exact)
        elements.append(type_name.encode("ascii") + struct.pack(">I", 8 + len(data)) + data)
    body = b"".join(elements)
    payload = b"icns" + struct.pack(">I", 8 + len(body)) + body
    (ICONS / "icon.icns").write_bytes(payload)
    print(f"wrote {ICONS / 'icon.icns'} ({len(payload)} bytes)")


if __name__ == "__main__":
    main()
