#!/usr/bin/env python3
"""repro-zip.py <stage-dir> <out.zip>

Zips a staged tree reproducibly: sorted entries, fixed mtime (1980-01-01), fixed
permissions (0644). No OS or timestamp entropy, so the same content always gives
the same SHA-1 - which is how the update site authenticates a package. Shared by
build-update-package.sh and sign-package.sh, so a signed zip is laid out exactly
like the unsigned one it replaces.
"""
import os
import sys
import zipfile

stage, out = sys.argv[1], sys.argv[2]
files = []
for root, _, names in os.walk(stage):
    for n in names:
        full = os.path.join(root, n)
        arc = os.path.relpath(full, stage).replace(os.sep, "/")
        files.append((arc, full))
files.sort(key=lambda x: x[0])
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for arc, full in files:
        zi = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
        zi.external_attr = (0o644 & 0xFFFF) << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        with open(full, "rb") as f:
            z.writestr(zi, f.read())
