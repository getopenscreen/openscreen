"""Write the Prism Glow meshes into the compositor: `crates/compositor/src/prism_mesh.rs` and the
matching tables in the three shaders, between their `prism mesh` markers.

    python export_compositor.py    # after build_blend.py has written prism-glow.glb

Everything is expressed in the mode 15 model frame: the unit is the side of the theme's 128 px
sprite (the flat cursor's size), origin on the hotspot, x right, y DOWN, z toward the camera,
rim top at z = 0. The source-to-sprite transform is the one scripts/generate-original-cursor-themes.mjs
applies, so the crystal lands exactly on the flat cursor.
"""

import json
import math
import struct
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
SRC = REPO / "crates" / "compositor" / "src"
SPRITE, INNER, ALPHA_MIN = 128, 112, 28  # generate-original-cursor-themes.mjs
BEVEL_PX = 12.0  # rounding of the rim's edges, source px
EDGE_FOLD_DEG = 25.0


def glb_meshes(path):
    """{node name: (positions (n,3), triangle indices (m,3), colours (n,3))}, glTF frame (y up)."""
    b = path.read_bytes()
    n = struct.unpack_from("<I", b, 12)[0]
    doc = json.loads(b[20 : 20 + n])
    binary = b[20 + n + 8 :]
    comp = {5126: ("f", 4), 5123: ("H", 2), 5125: ("I", 4), 5121: ("B", 1)}
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

    def acc(i):
        a = doc["accessors"][i]
        v = doc["bufferViews"][a["bufferView"]]
        fmt, size = comp[a["componentType"]]
        k = width[a["type"]]
        off = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        data = np.frombuffer(binary, dtype=np.dtype(fmt), count=a["count"] * k, offset=off).reshape(a["count"], k)
        if a.get("normalized"):
            data = data / float(np.iinfo(data.dtype).max)
        return data.astype(np.float64)

    out = {}
    for node in doc["nodes"]:
        if "mesh" not in node:
            continue
        prim = doc["meshes"][node["mesh"]]["primitives"][0]
        pos = acc(prim["attributes"]["POSITION"]) + np.array(node.get("translation", [0, 0, 0]))
        tri = acc(prim["indices"]).astype(int).reshape(-1, 3)
        col = acc(prim["attributes"]["COLOR_0"])[:, :3] if "COLOR_0" in prim["attributes"] else None
        out[node["name"]] = (pos, tri, col)
    return out


def sprite_transform(img, x0, x1, hotspot):
    """Scale (sprite units per source px) and the hotspot, as the theme generator crops and fits."""
    a = img[:, x0:x1, 3] >= ALPHA_MIN
    ys, xs = np.nonzero(a)
    w, h = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    scale = INNER / max(w, h)
    tx, ty = (SPRITE - w * scale) / 2, (SPRITE - h * scale) / 2
    hx = (tx + (hotspot[0] - x0 - xs.min()) * scale) / SPRITE
    hy = (ty + (hotspot[1] - ys.min()) * scale) / SPRITE
    return scale / SPRITE, (hx, hy), ty / SPRITE


def crystal_triangles(pos, tri, col, sheet, s):
    """Triangles of the crystal (facets and walls; the flat bottom is left to the shader), each
    with its outward normal, its colour in the art and which of its edges are real fold lines."""
    # glTF (x, y up, z) -> Blender (x, y, z up), hotspot at the origin, then the model frame
    blender = np.c_[pos[:, 0], -pos[:, 2], pos[:, 1]] - np.array([sheet[0], sheet[1], 0.0])
    model = np.c_[blender[:, 0], -blender[:, 1], blender[:, 2]] * (1000.0 * s)
    zmin = model[:, 2].min()
    tris = []
    for t in tri:
        a, b, c = model[t]
        nb = np.cross(blender[t[1]] - blender[t[0]], blender[t[2]] - blender[t[0]])
        nb /= np.linalg.norm(nb)
        n = np.array([nb[0], -nb[1], nb[2]])  # the y mirror keeps the normal outward
        if n[2] < -0.9 and abs(a[2] - zmin) < 1e-6:
            continue
        tris.append({"v": (a, b, c), "n": n, "col": col[t[0]], "key": tuple(map(tuple, np.round(model[t], 6)))})
    # real edges: the mesh's boundary, a change of facet colour, or a sharp fold
    owners = {}
    for i, t in enumerate(tris):
        for e in range(3):
            k = tuple(sorted((t["key"][(e + 1) % 3], t["key"][(e + 2) % 3])))
            owners.setdefault(k, []).append(i)
    for i, t in enumerate(tris):
        bits = 0
        for e in range(3):
            k = tuple(sorted((t["key"][(e + 1) % 3], t["key"][(e + 2) % 3])))
            other = [j for j in owners[k] if j != i]
            real = not other or np.abs(tris[other[0]]["col"] - t["col"]).sum() > 1e-3 or (
                tris[other[0]]["n"] @ t["n"] < math.cos(math.radians(EDGE_FOLD_DEG)))
            bits |= int(real) << e
        t["flags"] = (1 if abs(t["n"][2]) < 0.2 else 0) + 2 * bits
    return tris, float(zmin), float(model[:, 2].max()), model


def main():
    img = cv2.imread(str(HERE.parent / "source.png"), cv2.IMREAD_UNCHANGED)
    geo = json.loads((HERE / "prism.json").read_text())
    meshes = glb_meshes(HERE / "prism-glow.glb")
    shapes = []
    for kind, node, (x0, x1), sheet in (
        ("arrow", "prism_arrow_crystal", (0, 887), (0.0, 0.0)),
        ("hand", "prism_hand_crystal", (887, 1774), ((1220 - 208) / 1000, -(50 - 42) / 1000)),
    ):
        hot = geo[kind]["hotspot"]
        s, (hx, hy), top = sprite_transform(img, x0, x1, hot)
        tris, zmin, zmax, model = crystal_triangles(*meshes[node], sheet, s)
        sil = [((x - hot[0]) * s, (y - hot[1]) * s) for x, y in geo[kind]["silhouette"]]
        out = [((geo[kind]["verts"][k][0] - hot[0]) * s, (geo[kind]["verts"][k][1] - hot[1]) * s)
               for k in geo[kind]["outline"]]
        sx = [p[0] for p in sil]
        # the draw box: the sprite's full height (1 unit), the silhouette's width
        bx0, bx1 = min(sx) - 0.01, max(sx) + 0.01
        shapes.append({
            "kind": kind, "tris": tris, "sil": sil, "out": out, "thick": -zmin, "height": zmax,
            "size": (bx1 - bx0, 1.0), "hotspot": (-bx0 / (bx1 - bx0), hy), "top": top,
            "per_px": s,
        })
        print(f"{kind}: {len(tris)} triangles, {len(sil)} silhouette points, "
              f"box {bx1 - bx0:.4f} x 1, hotspot ({-bx0 / (bx1 - bx0):.4f}, {hy:.4f}), "
              f"height {zmax:.4f}, thick {-zmin:.4f}")
    write_rust(shapes)
    write_shaders(shapes)


def f(x):
    return f"{x:.6f}".rstrip("0").rstrip(".") if abs(x) > 5e-7 else "0.0"


def fl(x):  # a float literal every language reads as a float
    s = f(x)
    return s if "." in s else s + ".0"


def bevel(shapes):
    return BEVEL_PX * shapes[0]["per_px"]


def polygons(shapes):
    """Silhouettes, then outlines, in one table; their starts."""
    poly, sil_start, out_start = [], [], []
    for sh in shapes:
        sil_start.append(len(poly))
        poly += sh["sil"]
    for sh in shapes:
        out_start.append(len(poly))
        poly += sh["out"]
    return poly, sil_start, out_start


def records(shapes):
    """Per triangle, four float4: (v0, flags), (e1, r), (e2, g), (n, b)."""
    rows = []
    for sh in shapes:
        for t in sh["tris"]:
            a, b, c = t["v"]
            e1, e2 = b - a, c - a
            r, g, bl = t["col"]
            rows += [(*a, t["flags"]), (*e1, r), (*e2, g), (*t["n"], bl)]
    return rows


def write_rust(shapes):
    tri_start, rows = [], records(shapes)
    k = 0
    for sh in shapes:
        tri_start.append(k)
        k += len(sh["tris"])
    poly, sil_start, out_start = polygons(shapes)
    lines = [
        "//! Les deux curseurs de Prism Glow en MAILLAGE : les facettes tracées sur l'art 2D",
        "//! (`design/cursors/prism-glow/model`), taillées en cristal. Fichier GÉNÉRÉ par",
        "//! `design/cursors/prism-glow/model/export_compositor.py` : ne pas l'éditer à la main.",
        "//!",
        "//! Repère du modèle du mode 15 : unité = côté du sprite 128 px du thème, origine au hotspot,",
        "//! x à droite, y vers le bas, z vers la caméra, dessus du serti en z = 0. Chaque triangle du",
        "//! cristal tient en quatre float4 : (v0, drapeaux), (e1, r), (e2, g), (normale, b) ; drapeaux =",
        "//! paroi (1) + 2 × arêtes réelles (bit k : l'arête opposée au sommet k). Le fond plat, en",
        "//! z = -épaisseur, est laissé au shader. `POLYS` tient les silhouettes (bord extérieur du",
        "//! serti) puis les contours du cristal (son bord intérieur).",
        "",
        "/// Un des deux modèles : ses triangles et sa silhouette dans les tables, sa boîte de dessin.",
        "pub struct PrismModel {",
        "    pub tri_start: usize,",
        "    pub tri_count: usize,",
        "    pub sil_start: usize,",
        "    pub sil_count: usize,",
        "    pub out_start: usize,",
        "    pub out_count: usize,",
        "    /// Largeur de la boîte, hauteur 1 (le sprite), en unités du modèle.",
        "    pub size: [f32; 2],",
        "    /// Hotspot, fraction de la boîte.",
        "    pub hotspot: [f32; 2],",
        "    /// Haut de la silhouette, fraction de la hauteur.",
        "    pub top: f32,",
        "    /// Sommet du cristal au-dessus de z = 0, et épaisseur sous z = 0.",
        "    pub height: f32,",
        "    pub thick: f32,",
        "}",
        "",
        "/// Arrondi des arêtes du serti, en unités du modèle (`PRISM_BEVEL` des shaders).",
        f"pub const BEVEL: f32 = {fl(bevel(shapes))};",
        "",
        "/// Flèche puis main, dans l'ordre des identifiants du shader.",
        "pub const MODELS: [PrismModel; 2] = [",
    ]
    for i, sh in enumerate(shapes):
        lines += [
            "    PrismModel {",
            f"        tri_start: {tri_start[i]},",
            f"        tri_count: {len(sh['tris'])},",
            f"        sil_start: {sil_start[i]},",
            f"        sil_count: {len(sh['sil'])},",
            f"        out_start: {out_start[i]},",
            f"        out_count: {len(sh['out'])},",
            f"        size: [{fl(sh['size'][0])}, {fl(sh['size'][1])}],",
            f"        hotspot: [{fl(sh['hotspot'][0])}, {fl(sh['hotspot'][1])}],",
            f"        top: {fl(sh['top'])},",
            f"        height: {fl(sh['height'])},",
            f"        thick: {fl(sh['thick'])},",
            "    },",
        ]
    lines += ["];", "", f"pub const TRIS: [[f32; 4]; {len(rows)}] = ["]
    lines += [f"    [{', '.join(fl(v) for v in r)}]," for r in rows]
    lines += ["];", "", f"pub const POLYS: [[f32; 2]; {len(poly)}] = ["]
    lines += [f"    [{fl(x)}, {fl(y)}]," for x, y in poly]
    lines += ["];", ""]
    (SRC / "prism_mesh.rs").write_text("\n".join(lines), encoding="utf-8", newline="\n")


def table_lines(shapes, lang):
    rows = records(shapes)
    poly, sil_start, out_start = polygons(shapes)
    counts = [len(sh["tris"]) for sh in shapes]
    scounts = [len(sh["sil"]) for sh in shapes]
    ocounts = [len(sh["out"]) for sh in shapes]
    if lang == "hlsl":
        v4 = lambda r: f"float4({', '.join(fl(v) for v in r)})"
        v2 = lambda p: f"float2({fl(p[0])}, {fl(p[1])})"
        head4 = f"static const float4 PRISM_TRIS[{len(rows)}] = {{"
        head2 = f"static const float2 PRISM_POLY[{len(poly)}] = {{"
        tail = "};"
        ints = lambda name, vals: f"static const int {name}[2] = {{ {vals[0]}, {vals[1]} }};"
        scalar = f"static const float PRISM_BEVEL = {fl(bevel(shapes))};"
    elif lang == "metal":
        v4 = lambda r: f"float4({', '.join(fl(v) for v in r)})"
        v2 = lambda p: f"float2({fl(p[0])}, {fl(p[1])})"
        head4 = f"constant float4 PRISM_TRIS[{len(rows)}] = {{"
        head2 = f"constant float2 PRISM_POLY[{len(poly)}] = {{"
        tail = "};"
        ints = lambda name, vals: f"constant int {name}[2] = {{ {vals[0]}, {vals[1]} }};"
        scalar = f"constant float PRISM_BEVEL = {fl(bevel(shapes))};"
    else:
        ints = lambda name, vals: f"var<private> {name} = array<i32, 2>({vals[0]}, {vals[1]});"
        scalar = f"const PRISM_BEVEL: f32 = {fl(bevel(shapes))};"
    out = [ints("PRISM_TRI_START", [0, counts[0]]), ints("PRISM_TRI_COUNT", counts),
           ints("PRISM_SIL_START", sil_start), ints("PRISM_SIL_COUNT", scounts),
           ints("PRISM_OUT_START", out_start), ints("PRISM_OUT_COUNT", ocounts)]
    if lang == "wgsl":
        # The triangles and polygons themselves go in a uniform buffer that compositor_linux.rs
        # fills from prism_mesh.rs (a polygon point per vec4, the stride of a uniform array). As
        # a `const` or `var<private>` table, lavapipe copies them into every invocation of every
        # layer: a frame without any cursor rendered 3.4 times slower.
        return out + ["struct PrismMesh {", f"    tris: array<vec4<f32>, {len(rows)}>,",
                      f"    poly: array<vec4<f32>, {len(poly)}>,", "}", scalar]
    out.append(head4)
    out += [f"    {v4(r)}," for r in rows]
    out[-1] = out[-1].rstrip(",")
    out += [tail, head2]
    out += [f"    {v2(p)}," for p in poly]
    out[-1] = out[-1].rstrip(",")
    out += [tail, scalar]
    return out


BEGIN = "prism mesh: generated by design/cursors/prism-glow/model/export_compositor.py"
END = "end of the prism mesh"


def write_shaders(shapes):
    for name, lang in (("shaders.hlsl", "hlsl"), ("shaders.metal", "metal"), ("vk_shaders/layer.wgsl", "wgsl")):
        path = SRC / name
        text = path.read_text(encoding="utf-8")
        a, b = text.find(BEGIN), text.find(END)
        if a < 0 or b < 0:
            print(f"{name}: no markers yet, tables not written")
            continue
        start = text.index("\n", a) + 1
        stop = text.rindex("\n", 0, b) + 1
        text = text[:start] + "\n".join(table_lines(shapes, lang)) + "\n" + text[stop:]
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"{name}: tables written")


if __name__ == "__main__":
    main()
