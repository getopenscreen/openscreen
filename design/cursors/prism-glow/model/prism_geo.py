"""Prism Glow cursor as a faceted mesh: the facets traced from ../source.png, and their heights.

Coordinates are source-PNG pixels (x right, y down); `z` is the height above the navy rim's top in
the same pixels (unlisted vertices sit on the rim). `outline` is the crystal's edge against the rim,
`facets` are the flat faces of the 2D art, each an ordered polygon.

    python prism_geo.py    # writes prism.json: vertices, facets, their colours in the art, silhouettes

Then build the Blender scene and the glTF from it with build_blend.py.
"""

import json
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent

ARROW = {
    "hotspot": (208, 42),
    "verts": {
        "A": (237, 100), "B": (443, 290), "F": (712, 549), "K": (543, 563), "J": (612, 744),
        "I": (492, 807), "H": (394, 597), "G": (241, 732), "D": (241, 491),
        "C": (366, 374), "E": (458, 539), "X": (515, 449),
    },
    "outline": ["A", "B", "F", "K", "J", "I", "H", "G", "D"],
    "z": {"C": 108, "E": 76, "X": 66},
    "facets": [
        ["A", "C", "D"], ["A", "B", "C"], ["B", "X", "C"], ["B", "F", "X"],
        ["C", "X", "E"], ["X", "F", "E"], ["E", "F", "K"],
        # the notch H sits on the E-G line: one concept facet, folded along C-H
        ["C", "E", "H"], ["C", "H", "G"], ["C", "G", "D"],
        ["E", "I", "H"], ["E", "J", "I"], ["E", "K", "J"],
    ],
}

HAND = {
    "hotspot": (1220, 50),
    "verts": {
        # index finger
        "I1": (1180, 122), "I2": (1221, 85), "I3": (1261, 90), "I4": (1290, 132),
        "IT1": (1224, 118), "IT2": (1274, 135), "IT3": (1191, 262), "IL": (1179, 265),
        "P1": (1292, 427),
        # middle finger
        "W1": (1321, 456), "M1": (1323, 334), "M2": (1356, 302), "M3": (1395, 309),
        "M4": (1415, 340), "MT1": (1354, 334), "MT2": (1390, 344), "P2": (1339, 479),
        "MB1": (1386, 481), "MB2": (1415, 462),
        # ring finger
        "RL": (1441, 467), "R1": (1443, 368), "R2": (1476, 338), "R3": (1515, 345),
        "R4": (1536, 377), "RT1": (1480, 367), "RT2": (1513, 381), "RB": (1448, 475),
        "RB1": (1476, 498), "RB2": (1535, 489),
        # pinky
        "PK": (1567, 502), "K1": (1568, 403), "K2": (1600, 375), "K3": (1637, 382),
        "K4": (1658, 412), "KT1": (1601, 404), "KT2": (1640, 420), "K5": (1658, 608),
        "PR": (1651, 622),
        # palm
        "BR": (1522, 818), "BL": (1208, 820), "HC": (1406, 640), "Q": (1178, 572),
        # thumb
        "TB": (1128, 682), "TT2": (1015, 490), "TL": (1013, 427), "TT": (1069, 402),
        "TR": (1133, 449), "TT1": (1065, 435), "TH": (1144, 541),
    },
    # Each fingertip is cut like a gem: a table (the white facet), crown facets down to the rim.
    # The thumb web (TH, Q) rises above the rim so the thumb's lower facets are not flat.
    "z": {
        "IT1": 46, "IT2": 35, "IT3": 54,
        "MT1": 46, "MT2": 35, "P2": 59, "MB1": 54,
        "RT1": 43, "RT2": 34, "RB": 57, "RB1": 54,
        "KT1": 40, "KT2": 30,
        "TT1": 43, "TH": 40, "Q": 49,
        "HC": 76,
    },
    "outline": [
        "I1", "I2", "I3", "I4", "P1", "W1", "M1", "M2", "M3", "M4", "MB2", "RL", "R1", "R2",
        "R3", "R4", "RB2", "PK", "K1", "K2", "K3", "K4", "K5", "PR", "BR", "BL", "TB", "TT2",
        "TL", "TT", "TR", "TH", "Q", "IL",
    ],
    "facets": [
        # index: table, crown, sides
        ["IT1", "IT2", "IT3"], ["IT1", "I2", "I3", "IT2"], ["I1", "I2", "IT1"],
        ["I1", "IT1", "IT3", "IL"], ["I3", "I4", "IT2"], ["IT2", "I4", "P1", "IT3"],
        ["IL", "IT3", "P1", "Q"],
        # palm under the index (W1 sits on the P1-P2 line)
        ["Q", "P1", "W1"], ["Q", "W1", "P2"], ["Q", "P2", "HC"],
        # middle finger
        ["MT1", "MT2", "P2"], ["MT1", "M2", "M3", "MT2"], ["M1", "M2", "MT1"],
        ["M1", "MT1", "P2", "W1"], ["M3", "M4", "MT2"], ["MT2", "M4", "MB2", "MB1", "P2"],
        # ring finger
        ["RT1", "RT2", "RB"], ["RT1", "R2", "R3", "RT2"], ["R1", "R2", "RT1"],
        ["R1", "RT1", "RB", "RL"], ["R3", "R4", "RT2"], ["RT2", "R4", "RB2", "RB1", "RB"],
        # pinky
        ["KT1", "KT2", "PK"], ["KT1", "K2", "K3", "KT2"], ["K1", "K2", "KT1"],
        ["K1", "KT1", "PK"], ["K3", "K4", "KT2"], ["KT2", "K4", "K5", "PR", "PK"],
        # palm
        ["P2", "MB1", "MB2", "RL", "RB", "RB1", "RB2", "PK", "HC"],
        ["HC", "PK", "BR"], ["PK", "PR", "BR"], ["HC", "BR", "BL"], ["Q", "HC", "BL"],
        # thumb
        ["TT1", "TH", "TT2"], ["TL", "TT", "TT1", "TT2"], ["TT", "TR", "TH", "TT1"],
        ["TT2", "TH", "TB"], ["TH", "Q", "TB"], ["Q", "BL", "TB"],
    ],
}


def area(poly):
    p = np.asarray(poly, float)
    return 0.5 * np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1])


def check(shape, name):
    """The facets tile the outline exactly: no gap, no overlap, no stray vertex."""
    v = shape["verts"]
    outline = abs(area([v[k] for k in shape["outline"]]))
    facets = sum(abs(area([v[k] for k in f])) for f in shape["facets"])
    unused = set(v) - {k for f in shape["facets"] for k in f}
    assert abs(facets / outline - 1) < 1e-9 and not unused, (name, facets / outline, unused)


def facet_colors(shape, img):
    """Median colour of each facet in the art, away from its edges."""
    v = shape["verts"]
    out = []
    for f in shape["facets"]:
        mask = np.zeros(img.shape[:2], np.uint8)
        cv2.fillPoly(mask, [np.array([v[k] for k in f], np.int32)], 255)
        inner = cv2.erode(mask, np.ones((7, 7), np.uint8))
        px = img[(inner if inner.any() else mask) > 0][:, :3]
        b, g, r = np.median(px, axis=0)
        out.append("#%02x%02x%02x" % (int(r), int(g), int(b)))
    return out


def silhouette(img, x0, x1):
    """Outer edge of the navy rim, from the art's alpha."""
    a = (img[:, :, 3] > 127).astype(np.uint8)
    a[:, :x0] = 0
    a[:, x1:] = 0
    contours, _ = cv2.findContours(a, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(contours, key=cv2.contourArea)
    return cv2.approxPolyDP(c, 1.2, True)[:, 0, :].tolist()


if __name__ == "__main__":
    img = cv2.imread(str(HERE.parent / "source.png"), cv2.IMREAD_UNCHANGED)
    out = {}
    for shape, name, (x0, x1) in ((ARROW, "arrow", (0, 887)), (HAND, "hand", (887, 1774))):
        check(shape, name)
        z = shape["z"]
        out[name] = {
            "hotspot": shape["hotspot"],
            "verts": {k: [*p, float(z.get(k, 0))] for k, p in shape["verts"].items()},
            "outline": shape["outline"],
            "facets": shape["facets"],
            "colors": facet_colors(shape, img),
            "silhouette": silhouette(img, x0, x1),
        }
    (HERE / "prism.json").write_text(json.dumps(out, indent=1) + "\n", newline="\n")
    print({k: f"{len(v['facets'])} facets" for k, v in out.items()})
