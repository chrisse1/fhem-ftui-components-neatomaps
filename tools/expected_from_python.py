#!/usr/bin/env python3
"""Write down what the Python reference makes of a session file.

The component's map is the JavaScript twin of tools/track_map.py in the
neato-FHEM repository. Both sides are only worth anything if they agree, so the
numbers the reference produces are written to a fixture and the JavaScript is
held against them - see test/session.test.mjs.

    python3 tools/expected_from_python.py /path/to/neato-FHEM \\
            [test/fixtures/reference-track-botvac-d6.jsonl] \\
            [test/fixtures/expected-grid.json]

The checksums cover the full set of cells, not just how many there are: a
mirrored convention produces a map with almost the same cell count and a
completely different checksum.
"""

import hashlib
import json
import os
import sys


def digest(cells):
    joined = ";".join("%d,%d" % cell for cell in sorted(cells))
    return hashlib.sha1(joined.encode()).hexdigest()


def main(argv):
    if len(argv) < 2:
        sys.stderr.write(__doc__)
        return 2

    repo = argv[1]
    session = argv[2] if len(argv) > 2 else \
        "test/fixtures/reference-track-botvac-d6.jsonl"
    out = argv[3] if len(argv) > 3 else "test/fixtures/expected-grid.json"

    sys.path.insert(0, os.path.join(repo, "tools"))
    import track_map

    head, poses, scans = track_map.load(session)
    points = [p for scan in scans for p in track_map.world_points(scan)]
    counts = track_map.occupancy(scans, 0.05)
    walls, free = track_map.occupied(counts)

    expected = {
        "source": os.path.basename(session),
        "reference": "tools/track_map.py of chrisse1/neato-FHEM",
        "device": head.get("device"),
        "poses": len(poses),
        "scans": len(scans),
        "points": len(points),
        "bounds": {
            "minX": min(x for x, _ in points),
            "maxX": max(x for x, _ in points),
            "minY": min(y for _, y in points),
            "maxY": max(y for _, y in points),
        },
        "firstPoints": [[round(x, 9), round(y, 9)] for x, y in points[:5]],
        "cell": 0.05,
        "threshold": 0.25,
        "seen": 2,
        "observed": len(counts),
        "walls": len(walls),
        "free": len(free),
        "wallsSha1": digest(walls),
        "freeSha1": digest(free),
    }

    with open(out, "w") as handle:
        json.dump(expected, handle, indent=2, sort_keys=True)
        handle.write("\n")

    print("%s: %d walls, %d free of %d observed cells"
          % (out, len(walls), len(free), len(counts)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
