"""Build the Prism Glow cursor in Blender from prism.json, then save prism-glow.blend and export
prism-glow.glb next to this script.

    blender --background --python build_blend.py

Per cursor, two objects: the faceted crystal (a closed mesh, one flat face per facet of the 2D art,
with its colour in the face attribute `concept`) and the navy rim (a filled 2D curve with a hole,
extruded and rounded). Units: 1 = 1000 px of source.png, origin on the hotspot, y up, z toward the
viewer, rim top at z = 0, everything's underside at z = -0.04.
"""

import json
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = globals().get("HERE") or os.path.dirname(os.path.abspath(__file__))
S = 0.001
T_RIM = 40.0  # rim and crystal-body thickness, px
BEVEL = 5.0  # rim edge rounding, px
HAND_AT = ((1220 - 208) * S, -(50 - 42) * S)  # the hand stands where it is in source.png

D = json.load(open(os.path.join(HERE, "prism.json")))


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(h):
    return tuple(srgb_to_linear(int(h[i : i + 2], 16) / 255) for i in (1, 3, 5)) + (1.0,)


def signed_area(pts):
    return 0.5 * sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1]))


def model_xy(sh, x, y):
    hx, hy = sh["hotspot"]
    return ((x - hx) * S, -(y - hy) * S)


def fresh_collection(name):
    col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if col.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(col)
    for ob in list(col.objects):
        bpy.data.objects.remove(ob)
    return col


def build_crystal(name, sh):
    V = sh["verts"]
    bm = bmesh.new()
    concept = bm.faces.layers.float_color.new("concept")
    top = {k: bm.verts.new((*model_xy(sh, x, y), z * S)) for k, (x, y, z) in V.items()}
    outline = list(sh["outline"])
    if signed_area([model_xy(sh, *V[k][:2]) for k in outline]) < 0:
        outline.reverse()
    bot = {k: bm.verts.new((*model_xy(sh, *V[k][:2]), -T_RIM * S)) for k in outline}
    for f, hexcol in zip(sh["facets"], sh["colors"]):
        vs = [top[k] for k in f]
        if signed_area([v.co.xy[:] for v in vs]) < 0:
            vs.reverse()
        bm.faces.new(vs)[concept] = hex_rgba(hexcol)
    side = hex_rgba("#1a3cc8")
    for a, b in zip(outline, outline[1:] + outline[:1]):
        bm.faces.new((top[a], bot[a], bot[b], top[b]))[concept] = side
    bm.faces.new([bot[k] for k in reversed(outline)])[concept] = side
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3],
                          quad_method="BEAUTY", ngon_method="BEAUTY")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.get(name) or bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    # glTF carries colours per corner: mirror the face colour there
    corner = me.attributes.get("Col") or me.attributes.new("Col", "FLOAT_COLOR", "CORNER")
    for p in me.polygons:
        p.use_smooth = False
        for li in p.loop_indices:
            corner.data[li].color = me.attributes["concept"].data[p.index].color
    me.color_attributes.active_color = corner
    return bpy.data.objects.new(name, me)


def inset(loop, d):
    """Offset a closed counter-clockwise loop inward by d (mitred)."""
    out = []
    for i in range(len(loop)):
        p0, p1, p2 = Vector(loop[i - 1]), Vector(loop[i]), Vector(loop[(i + 1) % len(loop)])
        e0, e1 = (p1 - p0).normalized(), (p2 - p1).normalized()
        n0, n1 = Vector((-e0.y, e0.x)), Vector((-e1.y, e1.x))
        m = (n0 + n1).normalized() if (n0 + n1).length > 1e-6 else n0
        out.append(tuple(p1 + m * (d / max(m.dot(n0), 0.25))))
    return out


def build_rim(name, sh):
    outer = [model_xy(sh, x, y) for x, y in sh["silhouette"]]
    if signed_area(outer) < 0:
        outer.reverse()
    inner = [model_xy(sh, *sh["verts"][k][:2]) for k in sh["outline"]]
    # the bevel rounds outward from the spline: pull the outer loop in so the silhouette stays exact
    outer = inset(outer, BEVEL * S)
    cu = bpy.data.curves.get(name) or bpy.data.curves.new(name, "CURVE")
    cu.splines.clear()
    cu.dimensions = "2D"
    cu.fill_mode = "BOTH"
    cu.extrude = (T_RIM / 2 - BEVEL) * S
    cu.bevel_depth = BEVEL * S
    cu.bevel_resolution = 3
    for loop in (outer, inner):
        sp = cu.splines.new("POLY")
        sp.points.add(len(loop) - 1)
        for p, (x, y) in zip(sp.points, loop):
            p.co = (x, y, 0.0, 1.0)
        sp.use_cyclic_u = True
    ob = bpy.data.objects.new(name, cu)
    ob.location.z = -T_RIM / 2 * S
    return ob


def nodes_of(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes.clear()
    return m, m.node_tree, m.node_tree.nodes.new("ShaderNodeOutputMaterial")


def material_crystal():
    """Clear glass whose facets glow with their colour in the art (the look chosen on 30/09/2026)."""
    m, nt, out = nodes_of("Prism Crystal")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "concept"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
    bsdf.inputs["Emission Strength"].default_value = 0.45
    bsdf.inputs["Transmission Weight"].default_value = 1.0
    bsdf.inputs["IOR"].default_value = 1.61
    bsdf.inputs["Roughness"].default_value = 0.0
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return m


def material_rim():
    m, nt, out = nodes_of("Prism Rim")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = hex_rgba("#040c5a")
    bsdf.inputs["Roughness"].default_value = 0.22
    bsdf.inputs["Coat Weight"].default_value = 1.0
    bsdf.inputs["Coat Roughness"].default_value = 0.05
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return m


def build():
    col = fresh_collection("Prism Glow")
    crystal, rim = material_crystal(), material_rim()
    obs = []
    for key, at in (("arrow", (0.0, 0.0)), ("hand", HAND_AT)):
        c = build_crystal(f"prism_{key}_crystal", D[key])
        r = build_rim(f"prism_{key}_rim", D[key])
        c.data.materials.clear()
        c.data.materials.append(crystal)
        r.data.materials.clear()
        r.data.materials.append(rim)
        for ob in (c, r):
            ob.location.x, ob.location.y = at
            col.objects.link(ob)
        obs += [c, r]
    return obs


def studio():
    """Studio HDRI for light and reflections, the editor screenshot as the screen, a 3/4 camera."""
    sc = bpy.context.scene
    w = sc.world or bpy.data.worlds.new("World")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(os.path.join(bpy.utils.system_resource("DATAFILES"), "studiolights", "world", "studio.exr"), check_existing=True)
    env.image.pack()  # the install path differs per machine; 100 KB inside the .blend does not
    bg, flat = nt.nodes.new("ShaderNodeBackground"), nt.nodes.new("ShaderNodeBackground")
    flat.inputs["Color"].default_value = (0.06, 0.06, 0.07, 1)
    lp, mix, out = nt.nodes.new("ShaderNodeLightPath"), nt.nodes.new("ShaderNodeMixShader"), nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(bg.outputs["Background"], mix.inputs[1])
    nt.links.new(flat.outputs["Background"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])

    shot = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "public", "preview4.png"))
    screen = bpy.data.objects.get("screen")
    if screen is None and os.path.exists(shot):
        me = bpy.data.meshes.new("screen")
        me.from_pydata([(-3, -1.66, 0), (3, -1.66, 0), (3, 1.66, 0), (-3, 1.66, 0)], [], [(0, 1, 2, 3)])
        uv = me.uv_layers.new()
        for li, st in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
            uv.data[li].uv = st
        m, mnt, mout = nodes_of("screen")
        em, tex = mnt.nodes.new("ShaderNodeEmission"), mnt.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(shot, check_existing=True)
        mnt.links.new(tex.outputs["Color"], em.inputs["Color"])
        mnt.links.new(em.outputs["Emission"], mout.inputs["Surface"])
        me.materials.append(m)
        screen = bpy.data.objects.new("screen", me)
        screen.location = (1.9, -1.0, -T_RIM * S - 0.0005)
        sc.collection.objects.link(screen)

    target = Vector((0.679, -0.43, 0.0))
    cam = bpy.data.objects.get("cam_34") or bpy.data.objects.new("cam_34", bpy.data.cameras.new("cam_34"))
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    eye = target + Matrix.Rotation(math.radians(-28), 3, "Y") @ Matrix.Rotation(math.radians(-38), 3, "X") @ Vector((0, 0, 4.4))
    f = (target - eye).normalized()
    r = f.cross(Vector((0, 1, 0))).normalized()
    cam.location = eye
    cam.rotation_euler = Matrix((r, r.cross(f), -f)).transposed().to_euler()
    cam.data.lens = 85
    sc.camera = cam
    sc.render.engine = "CYCLES"
    sc.cycles.device = "GPU"
    sc.cycles.samples = 128
    sc.cycles.transmission_bounces = sc.cycles.max_bounces = 24
    sc.render.resolution_x, sc.render.resolution_y = 1600, 1000
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"


def export_glb(obs, path):
    """The rims are curves; glTF wants meshes: bake them into temporary twins for the export."""
    dg = bpy.context.evaluated_depsgraph_get()
    twins = []
    for ob in obs:
        if ob.type == "CURVE":
            name = ob.name
            me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
            ob.name = name + "_curve"  # the twin takes the name the glTF node should carry
            tw = bpy.data.objects.new(name, me)
            tw.matrix_world = ob.matrix_world
            me.materials.append(ob.data.materials[0])
            bpy.context.scene.collection.objects.link(tw)
            twins.append((tw, ob, name))
    bpy.ops.object.select_all(action="DESELECT")
    for ob in [o for o in obs if o.type == "MESH"] + [tw for tw, _, _ in twins]:
        ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_vertex_color="ACTIVE", export_apply=True)
    for tw, ob, name in twins:
        me = tw.data
        bpy.data.objects.remove(tw)
        bpy.data.meshes.remove(me)
        ob.name = name


obs = build()
studio()
export_glb(obs, os.path.join(HERE, "prism-glow.glb"))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "prism-glow.blend"), relative_remap=True)
