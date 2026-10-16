//! Effets shader écrits par un agent (`docs/shader-effects.md`) : du WGSL qui définit
//! `fn effect(uv: vec2<f32>) -> vec4<f32>`, appliqué en une passe plein cadre par `compose_frame`,
//! donc à l'identique en preview et à l'export.
//!
//! Ce module porte ce qui ne dépend d'aucun backend : le contrat (le prélude et la struct des
//! paramètres, générée), la validation, la borne des boucles, l'estimation du coût en paliers, la
//! sélection des régions actives et le remplissage des constant buffers. Chaque backend traduit le
//! module par naga et le compile une fois, hors de la boucle de rendu.
//!
//! L'effet est une fonction PURE de l'image composée, du temps, du curseur et de ses paramètres :
//! pas d'état d'une frame à l'autre. C'est ce qui garde la preview (qui saute d'une frame à
//! l'autre au seek) et l'export (qui les rend dans l'ordre) d'accord.

use crate::frame_geometry::FootageQuad;
use crate::scene::{SceneShaderEffect, ShaderEffectTarget, ShaderParamDecl, ShaderParamType, ShaderParamValue};
use std::hash::{Hash, Hasher};

/// La version du contrat que ce prélude implémente. Un prélude livré ne change plus : une entrée
/// nouvelle s'ajoute à la fin de `FxContext`, un changement de sens crée la version suivante.
pub const CONTRACT: u32 = 1;

/// Les entrées que l'effet lit, en plus de ses paramètres. Placées APRÈS le code de l'agent (et
/// après `FxParams`) : en WGSL l'ordre des déclarations de module est libre, et les erreurs
/// pointent ainsi les lignes que l'agent a écrites. Voir la section C de la spec.
pub const PRELUDE_V1: &str = r#"
struct FxContext {
    resolution: vec2<f32>,
    time: f32,
    aspect: f32,
    region: vec4<f32>,
    cursor: vec4<f32>,
    clicks: array<vec4<f32>, 4>,
    footage: vec4<f32>,
    camera: vec4<f32>,
    footage_corners: array<vec4<f32>, 2>,
    footage_aspect: f32,
    footage_warp: f32,
};
@group(0) @binding(0) var fx_frame: texture_2d<f32>;
@group(0) @binding(1) var fx_sampler: sampler;
@group(0) @binding(2) var<uniform> ctx: FxContext;

fn frame(uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(fx_frame, fx_sampler, uv, 0.0);
}

fn fx_px(n: f32) -> f32 {
    return n / 1080.0;
}

// The recording's surface, wherever the zoom, the layout and the 3D camera put it, through the
// same warp the compositor draws it with. A point of the surface is (0,0) at the recording's
// top-left corner and (1,1) at its bottom-right, extended past its edges. Mirror of
// `quad_forward` in shaders.hlsl.
fn fx_from_footage(p: vec2<f32>) -> vec2<f32> {
    let r = ctx.resolution;
    let c00 = ctx.footage_corners[0].xy * r;
    let c10 = ctx.footage_corners[0].zw * r;
    let c11 = ctx.footage_corners[1].xy * r;
    let c01 = ctx.footage_corners[1].zw * r;
    if (ctx.footage_warp > 0.5) {
        let p1 = c10 - c00;
        let p2 = c11 - c00;
        let p3 = c01 - c00;
        let d1 = p1 - p2;
        let d2 = p3 - p2;
        let d3 = p2 - p1 - p3;
        let den = d1.x * d2.y - d2.x * d1.y;
        let g = (d3.x * d2.y - d2.x * d3.y) / den;
        let h = (d1.x * d3.y - d3.x * d1.y) / den;
        return (c00 + (p1 * (1.0 + g) * p.x + p3 * (1.0 + h) * p.y) / (g * p.x + h * p.y + 1.0)) / r;
    }
    return (c00 + p.x * (c10 - c00) + p.y * (c01 - c00) + p.x * p.y * (c00 - c10 - c01 + c11)) / r;
}

fn fx_footage_root(t: f32, e: vec2<f32>, f: vec2<f32>, g: vec2<f32>, h: vec2<f32>) -> vec3<f32> {
    let dx = e.x + g.x * t;
    let dy = e.y + g.y * t;
    var s = (h.y - f.y * t) / dy;
    if (abs(dx) > abs(dy)) {
        s = (h.x - f.x * t) / dx;
    }
    let inside = s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02;
    return vec3<f32>(s, t, select(0.0, 1.0, inside));
}

// The point of the recording's surface under `uv`: fx_from_footage backwards. Where no point of
// the surface lands (past its horizon), a point far outside 0..1. Mirror of `quad_inverse` in
// shaders.hlsl.
fn fx_to_footage(uv: vec2<f32>) -> vec2<f32> {
    let none = vec2<f32>(-1.0e4);
    let r = ctx.resolution;
    let c00 = ctx.footage_corners[0].xy * r;
    let c10 = ctx.footage_corners[0].zw * r;
    let c11 = ctx.footage_corners[1].xy * r;
    let c01 = ctx.footage_corners[1].zw * r;
    if (ctx.footage_warp > 0.5) {
        let p1 = c10 - c00;
        let p2 = c11 - c00;
        let p3 = c01 - c00;
        let d1 = p1 - p2;
        let d2 = p3 - p2;
        let d3 = p2 - p1 - p3;
        let den = d1.x * d2.y - d2.x * d1.y;
        let g = (d3.x * d2.y - d2.x * d3.y) / den;
        let h = (d1.x * d3.y - d3.x * d1.y) / den;
        let q = uv * r - c00;
        let m00 = p1.x * (1.0 + g) - g * q.x;
        let m01 = p3.x * (1.0 + h) - h * q.x;
        let m10 = p1.y * (1.0 + g) - g * q.y;
        let m11 = p3.y * (1.0 + h) - h * q.y;
        let det = m00 * m11 - m01 * m10;
        let st = vec2<f32>(q.x * m11 - m01 * q.y, m00 * q.y - q.x * m10) / det;
        // Behind the camera: the homography reaches the point, the picture never shows it.
        if (g * st.x + h * st.y + 1.0 <= 0.0) {
            return none;
        }
        return st;
    }
    let e = c10 - c00;
    let f = c01 - c00;
    let g = c00 - c10 - c01 + c11;
    let h = uv * r - c00;
    let k2 = g.x * f.y - g.y * f.x;
    let k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
    let k0 = h.x * e.y - h.y * e.x;
    if (abs(k2) < 1e-5 * abs(k1)) {
        if (abs(k1) < 1e-6) {
            return none;
        }
        return fx_footage_root(-k0 / k1, e, f, g, h).xy;
    }
    let disc = k1 * k1 - 4.0 * k2 * k0;
    if (disc < 0.0) {
        return none;
    }
    let q = -0.5 * (k1 + select(-1.0, 1.0, k1 >= 0.0) * sqrt(disc));
    let r0 = fx_footage_root(q / k2, e, f, g, h);
    let r1 = fx_footage_root(select(q / k2, k0 / q, abs(q) > 0.0), e, f, g, h);
    return select(r1.xy, r0.xy, r0.z > 0.5);
}

fn fx_pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn fx_hash(p: vec2<u32>) -> f32 {
    return f32(fx_pcg(p.x ^ fx_pcg(p.y)) >> 8u) / 16777216.0;
}

struct FxVsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn fx_vs(@builtin(vertex_index) i: u32) -> FxVsOut {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var o: FxVsOut;
    o.pos = vec4<f32>(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
    o.uv = p;
    return o;
}

@fragment
fn fx_fs(v: FxVsOut) -> @location(0) vec4<f32> {
    return effect(v.uv);
}
"#;

/// Combien de clics récents l'effet voit (`ctx.clicks`), du plus récent au plus ancien.
pub const MAX_CLICKS: usize = 4;
/// Jusqu'où un clic reste visible des effets : au-delà, son entrée est vide (`w` = 0).
pub const CLICK_WINDOW_S: f32 = 2.0;
/// Le plafond de sécurité du travail par pixel, toutes boucles imbriquées comprises. Ce n'est pas
/// un budget : c'est l'ordre de grandeur où un GPU intégré atteint le TDR en 1080p.
pub const MAX_ITERATIONS_PER_PIXEL: u64 = 4096;
/// Taille du constant buffer des paramètres : le plafond technique (32) de `vec4`.
pub const PARAMS_BUFFER_BYTES: usize = 32 * 16;

/// Le constant buffer `ctx`, au layout de `FxContext` (192 octets).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct FxContext {
    pub resolution: [f32; 2],
    pub time: f32,
    pub aspect: f32,
    pub region: [f32; 4],
    pub cursor: [f32; 4],
    pub clicks: [[f32; 4]; MAX_CLICKS],
    pub footage: [f32; 4],
    pub camera: [f32; 4],
    /// Les coins du métrage, TL et TR puis BR et BL, en uv de sortie : `fx_to_footage`.
    pub footage_corners: [[f32; 4]; 2],
    /// Largeur sur hauteur du métrage dans son propre plan, avant toute inclinaison.
    pub footage_aspect: f32,
    /// 1 : l'homographie des coins (la caméra réelle), 0 : leur warp bilinéaire (`TiltedQuad`).
    pub footage_warp: f32,
    pub _pad: [f32; 2],
}

/// Ce que le plan du curseur et la géométrie de la frame donnent aux effets, en uv de sortie.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FxFrameInputs {
    pub cursor: Option<[f32; 2]>,
    /// Les clics récents, du plus récent au plus ancien : point et âge en secondes.
    pub clicks: Vec<([f32; 2], f32)>,
    pub footage: FootageQuad,
    pub footage_aspect: f32,
    pub camera: Option<[f32; 4]>,
}

/// Le palier de coût d'un effet (section C.7 de la spec) : indicatif, jamais un refus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Light,
    Medium,
    Heavy,
    VeryHeavy,
}

impl Tier {
    /// Les seuils, en lectures de `frame()` par pixel. Sur la RTX 4070 Ti, une lecture coûte
    /// ~4 µs par frame en 1080p : léger ≤ 0,06 ms, moyen ≤ 0,14 ms, lourd ≤ 0,54 ms
    /// (`shader_fx_tier_calibration`, rendering-performance.md).
    pub fn of(frame_reads: u64) -> Tier {
        match frame_reads {
            0..=8 => Tier::Light,
            9..=32 => Tier::Medium,
            33..=128 => Tier::Heavy,
            _ => Tier::VeryHeavy,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Tier::Light => "light",
            Tier::Medium => "medium",
            Tier::Heavy => "heavy",
            Tier::VeryHeavy => "very-heavy",
        }
    }
}

/// Ce que la validation sait d'un effet accepté.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectReport {
    /// Lectures de texture par pixel, boucles multipliées par leur borne (le pire des branches).
    pub frame_reads: u64,
    /// Itérations de boucle par pixel, toutes boucles imbriquées comprises.
    pub iterations: u64,
    pub tier: Tier,
}

impl ShaderParamType {
    fn wgsl(self) -> &'static str {
        match self {
            ShaderParamType::Number | ShaderParamType::Toggle => "f32",
            ShaderParamType::Color => "vec4<f32>",
            ShaderParamType::Point => "vec2<f32>",
        }
    }

    /// (taille, alignement) en octets, règles WGSL de l'espace `uniform`.
    fn size_align(self) -> (usize, usize) {
        match self {
            ShaderParamType::Number | ShaderParamType::Toggle => (4, 4),
            ShaderParamType::Color => (16, 16),
            ShaderParamType::Point => (8, 8),
        }
    }
}

const RESERVED_PARAM_NAMES: &[&str] = &["unused"];

/// La struct `FxParams` et son binding, générés depuis les déclarations. WGSL refuse une struct
/// vide : sans paramètre, un champ `unused` en tient lieu.
fn params_source(params: &[ShaderParamDecl]) -> String {
    let mut out = String::from("struct FxParams {\n");
    if params.is_empty() {
        out.push_str("    unused: f32,\n");
    }
    for p in params {
        out.push_str(&format!("    {}: {},\n", p.name, p.ty.wgsl()));
    }
    out.push_str("};\n@group(0) @binding(3) var<uniform> params: FxParams;\n");
    out
}

/// Le module complet que naga compile : le code de l'agent d'abord, pour que ses lignes gardent
/// leur numéro dans les erreurs.
pub fn module_source(user: &str, params: &[ShaderParamDecl]) -> String {
    format!("{user}\n{}{PRELUDE_V1}", params_source(params))
}

fn check_params(params: &[ShaderParamDecl]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for p in params {
        let valid = p.name.len() <= 32
            && p.name.starts_with(|c: char| c.is_ascii_lowercase())
            && p.name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        if !valid {
            return Err(format!("parameter `{}`: names are snake_case, a-z first, at most 32 characters", p.name));
        }
        if RESERVED_PARAM_NAMES.contains(&p.name.as_str()) || !seen.insert(p.name.as_str()) {
            return Err(format!("parameter `{}` is declared twice or reserved", p.name));
        }
    }
    Ok(())
}

/// Le module parsé, validé, et sa première fonction d'entrée de fragment.
pub struct Parsed {
    pub module: naga::Module,
    pub info: naga::valid::ModuleInfo,
    pub report: EffectReport,
}

/// Valide un effet comme l'agent doit le lire : paramètres, syntaxe et types (naga), bornes des
/// boucles, puis estimation du coût. L'erreur porte la ligne et la colonne du code de l'agent.
pub fn analyze(user: &str, params: &[ShaderParamDecl]) -> Result<Parsed, String> {
    check_params(params)?;
    let src = module_source(user, params);
    let module = naga::front::wgsl::parse_str(&src).map_err(|e| e.emit_to_string(&src))?;
    let info = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .map_err(|e| e.emit_to_string(&src))?;
    // Les bindings sont ceux du prélude, et eux seuls : chaque backend lie ces quatre-là. Linux
    // valide le pipeline contre ce layout, et une erreur de validation wgpu y fait paniquer.
    for (handle, var) in module.global_variables.iter() {
        let name = var.name.as_deref().unwrap_or("?");
        if var.binding.is_some() && !["fx_frame", "fx_sampler", "ctx", "params"].contains(&name) {
            let line = module.global_variables.get_span(handle).location(&src).line_number;
            return Err(format!(
                "`{name}` at line {line}: an effect declares no binding of its own, it reads frame(), ctx and params"
            ));
        }
    }
    let entry = module
        .entry_points
        .iter()
        .find(|e| e.name == "fx_fs")
        .ok_or("the module has no fx_fs entry point")?;
    let mut costs = CostWalk { module: &module, src: &src, by_function: Default::default() };
    let cost = costs.block(&entry.function, &entry.function.body)?;
    if cost.iterations > MAX_ITERATIONS_PER_PIXEL {
        return Err(format!(
            "the loops run {} iterations per pixel, over the safety ceiling of {MAX_ITERATIONS_PER_PIXEL}: \
             past it a GPU can stall long enough for the system to reset it",
            cost.iterations
        ));
    }
    let report = EffectReport { frame_reads: cost.reads, iterations: cost.iterations, tier: Tier::of(cost.reads) };
    Ok(Parsed { module, info, report })
}

/// Ce que coûte un bloc, par pixel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Cost {
    reads: u64,
    iterations: u64,
}

impl Cost {
    fn add(self, o: Cost) -> Cost {
        Cost { reads: self.reads.saturating_add(o.reads), iterations: self.iterations.saturating_add(o.iterations) }
    }
    fn max(self, o: Cost) -> Cost {
        Cost { reads: self.reads.max(o.reads), iterations: self.iterations.max(o.iterations) }
    }
    fn times(self, n: u64) -> Cost {
        Cost { reads: self.reads.saturating_mul(n), iterations: self.iterations.saturating_mul(n) }
    }
}

/// Parcourt l'IR de naga depuis `fx_fs` : les fonctions appelées sont dépliées, une branche
/// compte pour la plus chère, une boucle multiplie son corps par sa borne.
struct CostWalk<'a> {
    module: &'a naga::Module,
    src: &'a str,
    by_function: std::collections::HashMap<naga::Handle<naga::Function>, Cost>,
}

impl CostWalk<'_> {
    fn block(&mut self, func: &naga::Function, block: &naga::Block) -> Result<Cost, String> {
        let mut total = Cost::default();
        for (at, (stmt, span)) in block.span_iter().enumerate() {
            let c = match stmt {
                naga::Statement::Emit(range) => {
                    let reads = range
                        .clone()
                        .filter(|&h| {
                            matches!(
                                func.expressions[h],
                                naga::Expression::ImageSample { .. } | naga::Expression::ImageLoad { .. }
                            )
                        })
                        .count() as u64;
                    Cost { reads, iterations: 0 }
                }
                naga::Statement::Block(b) => self.block(func, b)?,
                naga::Statement::If { accept, reject, .. } => {
                    self.block(func, accept)?.max(self.block(func, reject)?)
                }
                naga::Statement::Switch { cases, .. } => {
                    let mut worst = Cost::default();
                    for case in cases {
                        worst = worst.max(self.block(func, &case.body)?);
                    }
                    worst
                }
                naga::Statement::Loop { body, continuing, break_if } => {
                    let trips = self.trip_count(func, (block, at), body, continuing, *break_if, *span)?;
                    let inner = self.block(func, body)?.add(self.block(func, continuing)?);
                    Cost { reads: inner.reads, iterations: inner.iterations.saturating_add(1) }.times(trips)
                }
                naga::Statement::Call { function, .. } => self.function(*function)?,
                _ => Cost::default(),
            };
            total = total.add(c);
        }
        Ok(total)
    }

    fn function(&mut self, h: naga::Handle<naga::Function>) -> Result<Cost, String> {
        if let Some(c) = self.by_function.get(&h) {
            return Ok(*c);
        }
        let module = self.module;
        let f = &module.functions[h];
        let c = self.block(f, &f.body)?;
        self.by_function.insert(h, c);
        Ok(c)
    }

    fn refuse(&self, span: naga::Span, why: &str) -> String {
        let line = span.location(self.src).line_number;
        format!(
            "the loop at line {line} {why}. Write it as `for (var i = 0; i < 16; i++)`: a counter \
             initialised with a literal, compared to a literal, stepped by a literal in the loop header"
        )
    }

    /// Le nombre de tours d'une boucle `for` à bornes littérales. Toute autre forme est refusée :
    /// une boucle qui ne finit pas bloque le GPU jusqu'au TDR. `(parent, at)` : le bloc de la
    /// boucle et son rang dans ce bloc.
    fn trip_count(
        &self,
        func: &naga::Function,
        (parent, at): (&naga::Block, usize),
        body: &naga::Block,
        continuing: &naga::Block,
        break_if: Option<naga::Handle<naga::Expression>>,
        span: naga::Span,
    ) -> Result<u64, String> {
        use naga::{BinaryOperator as B, Expression as E, Statement as S};
        if break_if.is_some() {
            return Err(self.refuse(span, "ends on `break if`"));
        }
        // Le `for` de WGSL devient `loop { if (cond) {} else { break; } … continuing { pas } }`.
        let guard = body.iter().find(|s| !matches!(s, S::Emit(_)));
        let Some(S::If { condition, accept, reject }) = guard else {
            return Err(self.refuse(span, "has no bound in its header"));
        };
        if !accept.is_empty() || reject.len() != 1 || !matches!(reject.iter().next(), Some(S::Break)) {
            return Err(self.refuse(span, "has no bound in its header"));
        }
        let E::Binary { op, left, right } = func.expressions[*condition] else {
            return Err(self.refuse(span, "is not bounded by a comparison"));
        };
        let (var, bound, op) = match (self.counter(func, left), self.literal(func, right)) {
            (Some(v), Some(k)) => (v, k, op),
            _ => match (self.literal(func, left), self.counter(func, right)) {
                // `N > i` se lit `i < N`.
                (Some(k), Some(v)) => (v, k, match op {
                    B::Greater => B::Less,
                    B::GreaterEqual => B::LessEqual,
                    B::Less => B::Greater,
                    B::LessEqual => B::GreaterEqual,
                    other => other,
                }),
                _ => return Err(self.refuse(span, "is not bounded by a literal")),
            },
        };
        let step = self
            .step(func, continuing, var)
            .ok_or_else(|| self.refuse(span, "does not step its counter by a literal in its header"))?;
        if Self::writes(func, body, var) > 0 {
            return Err(self.refuse(span, "changes its counter inside its body"));
        }
        // La valeur à l'entrée : le dernier `Store` qui précède la boucle dans son bloc, sinon
        // l'initialisation. Elle n'est sûre que si rien d'autre n'écrit le compteur : une écriture
        // dans un autre bloc, après la boucle quand son bloc se répète, ou par un pointeur, la
        // changerait sans que le compte le voie, et le plafond de sécurité serait faux.
        let is_var = |h: naga::Handle<naga::Expression>| {
            matches!(func.expressions[h], E::LocalVariable(v) if v == var)
        };
        let before: Vec<_> = parent
            .iter()
            .take(at)
            .filter_map(|s| match s {
                S::Store { pointer, value } if is_var(*pointer) => Some(*value),
                _ => None,
            })
            .collect();
        if Self::writes(func, &func.body, var) != before.len() + 1 {
            return Err(self.refuse(span, "writes its counter outside its header"));
        }
        let init = match before.last() {
            Some(&value) => self.literal(func, value),
            None => func.local_variables[var].init.and_then(|h| self.literal(func, h)),
        }
        .ok_or_else(|| self.refuse(span, "starts its counter from a value that is not a literal"))?;
        let trips = match op {
            B::Less if step > 0.0 => ((bound - init) / step).ceil(),
            B::LessEqual if step > 0.0 => ((bound - init) / step).floor() + 1.0,
            B::Greater if step < 0.0 => ((init - bound) / -step).ceil(),
            B::GreaterEqual if step < 0.0 => ((init - bound) / -step).floor() + 1.0,
            _ => return Err(self.refuse(span, "never reaches its bound")),
        };
        Ok(trips.max(0.0) as u64)
    }

    /// `Load(LocalVariable(v))` : le compteur d'une condition.
    fn counter(&self, func: &naga::Function, h: naga::Handle<naga::Expression>) -> Option<naga::Handle<naga::LocalVariable>> {
        match func.expressions[h] {
            naga::Expression::Load { pointer } => match func.expressions[pointer] {
                naga::Expression::LocalVariable(v) => Some(v),
                _ => None,
            },
            _ => None,
        }
    }

    /// Un littéral, directement ou par une constante de module.
    fn literal(&self, func: &naga::Function, h: naga::Handle<naga::Expression>) -> Option<f64> {
        let lit = |e: &naga::Expression| match *e {
            naga::Expression::Literal(l) => match l {
                naga::Literal::I32(v) => Some(v as f64),
                naga::Literal::U32(v) => Some(v as f64),
                naga::Literal::F32(v) => Some(v as f64),
                naga::Literal::I64(v) => Some(v as f64),
                naga::Literal::U64(v) => Some(v as f64),
                naga::Literal::F64(v) => Some(v),
                naga::Literal::AbstractInt(v) => Some(v as f64),
                naga::Literal::AbstractFloat(v) => Some(v),
                _ => None,
            },
            _ => None,
        };
        match &func.expressions[h] {
            naga::Expression::Constant(c) => lit(&self.module.global_expressions[self.module.constants[*c].init]),
            e => lit(e),
        }
    }

    /// Le pas du compteur dans `continuing` : `i = i + k` ou `i = i - k`, `k` littéral.
    fn step(&self, func: &naga::Function, continuing: &naga::Block, var: naga::Handle<naga::LocalVariable>) -> Option<f64> {
        continuing.iter().find_map(|s| match s {
            naga::Statement::Store { pointer, value }
                if matches!(func.expressions[*pointer], naga::Expression::LocalVariable(v) if v == var) =>
            {
                match func.expressions[*value] {
                    naga::Expression::Binary { op, left, right } if self.counter(func, left) == Some(var) => {
                        let k = self.literal(func, right)?;
                        match op {
                            naga::BinaryOperator::Add => Some(k),
                            naga::BinaryOperator::Subtract => Some(-k),
                            _ => None,
                        }
                    }
                    _ => None,
                }
            }
            _ => None,
        })
    }

    /// Combien d'instructions du bloc écrivent le compteur, directement ou en passant son pointeur
    /// à une fonction, blocs imbriqués compris.
    fn writes(func: &naga::Function, block: &naga::Block, var: naga::Handle<naga::LocalVariable>) -> usize {
        let is_var = |h: naga::Handle<naga::Expression>| {
            matches!(func.expressions[h], naga::Expression::LocalVariable(v) if v == var)
        };
        block
            .iter()
            .map(|s| match s {
                naga::Statement::Store { pointer, .. } => usize::from(is_var(*pointer)),
                naga::Statement::Call { arguments, .. } => usize::from(arguments.iter().any(|&a| is_var(a))),
                naga::Statement::Block(b) => Self::writes(func, b, var),
                naga::Statement::If { accept, reject, .. } => {
                    Self::writes(func, accept, var) + Self::writes(func, reject, var)
                }
                naga::Statement::Switch { cases, .. } => cases.iter().map(|c| Self::writes(func, &c.body, var)).sum(),
                naga::Statement::Loop { body, continuing, .. } => {
                    Self::writes(func, body, var) + Self::writes(func, continuing, var)
                }
                _ => 0,
            })
            .sum()
    }
}

/// HLSL SM 5.0 pour D3D11/FXC. naga 24 est la dernière version dont la sortie HLSL passe FXC :
/// à partir de la 25 elle déclare les samplers dans un tas D3D12 (`register(s0, space0)`), que
/// `ps_5_0` refuse (X3721). Ne pas monter naga sans faire passer ce module.
pub fn to_hlsl(parsed: &Parsed) -> Result<String, String> {
    let options = naga::back::hlsl::Options {
        shader_model: naga::back::hlsl::ShaderModel::V5_0,
        ..Default::default()
    };
    let mut out = String::new();
    naga::back::hlsl::Writer::new(&mut out, &options)
        .write(&parsed.module, &parsed.info, None)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Les index de buffer Metal de `ctx` et de `params`, ceux que `to_msl` donne au module et que
/// `compositor_macos::apply_shader_effect` passe à `set_fragment_bytes`. Les mêmes numéros que les
/// registres HLSL (b2, b3).
#[cfg(target_os = "macos")]
pub const MSL_CTX_BUFFER: u64 = 2;
#[cfg(target_os = "macos")]
pub const MSL_PARAMS_BUFFER: u64 = 3;

/// Le module traduit en MSL, et les noms que naga a donnés à ses deux étages.
#[cfg(target_os = "macos")]
pub struct Msl {
    pub source: String,
    pub vs: String,
    pub fs: String,
}

/// MSL pour Metal. Les bindings du prélude sont liés explicitement : la texture en 0, le sampler
/// en `constexpr` (linéaire, bords répétés, comme `sampNV` de `shaders.metal` : le dépôt n'a aucun
/// `MTLSamplerState`), `ctx` et `params` en buffers. Sans cette carte, naga invente les bindings
/// (`fake_missing_bindings`) et émet `[[user(fake0)]]`, qui n'est pas du MSL.
#[cfg(target_os = "macos")]
pub fn to_msl(parsed: &Parsed) -> Result<Msl, String> {
    use naga::back::msl;
    use naga::proc::BoundsCheckPolicy::ReadZeroSkipWrite;
    let at = |binding| naga::ResourceBinding { group: 0, binding };
    let resources = msl::BindingMap::from([
        (at(0), msl::BindTarget { texture: Some(0), ..Default::default() }),
        (at(1), msl::BindTarget { sampler: Some(msl::BindSamplerTarget::Inline(0)), ..Default::default() }),
        (at(2), msl::BindTarget { buffer: Some(MSL_CTX_BUFFER as u8), ..Default::default() }),
        (at(3), msl::BindTarget { buffer: Some(MSL_PARAMS_BUFFER as u8), ..Default::default() }),
    ]);
    let options = msl::Options {
        lang_version: (2, 0),
        per_entry_point_map: ["fx_vs", "fx_fs"]
            .into_iter()
            .map(|name| {
                (name.to_string(), msl::EntryPointResources { resources: resources.clone(), ..Default::default() })
            })
            .collect(),
        inline_samplers: vec![msl::sampler::InlineSampler {
            address: [msl::sampler::Address::ClampToEdge; 3],
            mag_filter: msl::sampler::Filter::Linear,
            min_filter: msl::sampler::Filter::Linear,
            ..Default::default()
        }],
        fake_missing_bindings: false,
        // naga borne sinon chaque boucle par une lecture `volatile` à chaque tour, contre un
        // compilateur qui supposerait qu'elle finit. `analyze` l'a déjà prouvé (bornes
        // littérales, 4 096 itérations au plus) : la garde coûtait 7 à 10 % de la passe sur M1.
        force_loop_bounding: false,
        // Un index hors bornes lit 0, comme sous D3D11, au lieu de lire au-delà du buffer.
        bounds_check_policies: naga::proc::BoundsCheckPolicies {
            index: ReadZeroSkipWrite,
            buffer: ReadZeroSkipWrite,
            image_load: ReadZeroSkipWrite,
            binding_array: ReadZeroSkipWrite,
        },
        ..Default::default()
    };
    let (source, info) =
        msl::write_string(&parsed.module, &parsed.info, &options, &msl::PipelineOptions::default())
            .map_err(|e| format!("MSL: {e}"))?;
    let name = |entry: &str| -> Result<String, String> {
        let i = parsed
            .module
            .entry_points
            .iter()
            .position(|e| e.name == entry)
            .ok_or_else(|| format!("the module has no {entry} entry point"))?;
        info.entry_point_names[i].clone().map_err(|e| format!("MSL {entry}: {e}"))
    };
    Ok(Msl { vs: name("fx_vs")?, fs: name("fx_fs")?, source })
}

/// La pipeline de l'effet, prête pour la passe : MSL compilé par Metal, puis le pipeline state
/// RGBA8 sans blending (l'effet rend le pixel final).
#[cfg(target_os = "macos")]
pub type CompiledFx = metal::RenderPipelineState;

/// Compile pour Metal. Hors du thread de rendu, donc sous un pool d'autorelease à soi : un thread
/// lancé par Rust n'en a pas, et les objets autoreleased de Metal (l'erreur de compilation, les
/// fonctions de la bibliothèque) fuiraient.
#[cfg(target_os = "macos")]
pub fn compile_metal(device: &metal::Device, code: &str, params: &[ShaderParamDecl]) -> Result<CompiledFx, String> {
    let msl = to_msl(&analyze(code, params)?)?;
    objc::rc::autoreleasepool(|| {
        let library = device
            .new_library_with_source(&msl.source, &metal::CompileOptions::new())
            .map_err(|e| format!("Metal: {e}"))?;
        crate::compositor_macos::make_pipeline(
            device,
            &library,
            &msl.vs,
            &msl.fs,
            metal::MTLPixelFormat::RGBA8Unorm,
            crate::compositor_macos::Blend::Replace,
        )
        .map_err(|e| format!("Metal: {e:#}"))
    })
}

/// Compile sur un thread à part ; le résultat arrive par le canal. Le pendant de la version
/// Windows : `Device`, `Library` et `RenderPipelineState` de metal-rs sont `Send` et `Sync`.
#[cfg(target_os = "macos")]
pub fn spawn_compile(
    effect: &SceneShaderEffect,
    device: &metal::Device,
) -> std::sync::mpsc::Receiver<Result<CompiledFx, String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let (code, params, device) = (effect.code.clone(), effect.params.clone(), device.clone());
    std::thread::Builder::new()
        .name("shader-fx".into())
        .spawn(move || {
            let _ = tx.send(compile_metal(&device, &code, &params));
        })
        .expect("thread shader-fx");
    rx
}

/// Clé du cache des shaders compilés : ce qui change le binaire, et rien d'autre.
pub fn source_hash(effect: &SceneShaderEffect) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    effect.contract.hash(&mut h);
    effect.code.hash(&mut h);
    for p in &effect.params {
        p.name.hash(&mut h);
        p.ty.hash(&mut h);
    }
    h.finish()
}

/// L'entrée à évincer d'un cache plein, parmi `(clé, dernier usage)` : la moins récemment utilisée
/// de celles que la scène n'emploie pas. Aucune si elle les emploie toutes : le cache dépasse alors
/// sa taille plutôt que de recompiler à chaque frame un effet qu'elle montre.
pub fn eviction_victim(entries: impl Iterator<Item = (u64, u64)>, scene: &[SceneShaderEffect]) -> Option<u64> {
    let shown: std::collections::HashSet<u64> = scene.iter().map(source_hash).collect();
    entries.filter(|(key, _)| !shown.contains(key)).min_by_key(|&(_, used)| used).map(|(key, _)| key)
}

/// Les régions actives au temps source `t`. Le document n'en tient qu'une à la fois ; une scène
/// écrite à la main qui en superpose les applique dans son ordre.
pub fn active_effects(effects: &[SceneShaderEffect], t: f32) -> Vec<&SceneShaderEffect> {
    // En f32 comme `t` et comme les annotations : `0.7_f32 as f64` tombe sous `0.7_f64`, et la
    // frame posée sur le début de la région la manquerait.
    effects.iter().filter(|e| t >= e.start_sec as f32 && t < e.end_sec as f32).collect()
}

/// La boîte englobante (x, y, w, h) d'un quad, en uv de sortie : `ctx.footage` sous un tilt 3D.
pub fn bounds(corners: &[[f32; 2]; 4]) -> [f32; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for [x, y] in corners {
        (x0, y0, x1, y1) = (x0.min(*x), y0.min(*y), x1.max(*x), y1.max(*y));
    }
    [x0, y0, x1 - x0, y1 - y0]
}

/// `ctx.region` : progression sur la pilule entière en temps programme quand l'app la donne, sur
/// le fragment en temps source sinon.
fn region(effect: &SceneShaderEffect, source_t: f32, programme_t: f32) -> [f32; 4] {
    let (start, end, now) = match (effect.programme_start_sec, effect.programme_end_sec) {
        (Some(s), Some(e)) => (s, e, programme_t as f64),
        _ => (effect.start_sec, effect.end_sec, source_t as f64),
    };
    let span = (end - start).max(1e-6);
    let since = (now - start).max(0.0);
    [(since / span).clamp(0.0, 1.0) as f32, span as f32, since as f32, 0.0]
}

pub fn context(
    effect: &SceneShaderEffect,
    source_t: f32,
    programme_t: f32,
    resolution: [f32; 2],
    inputs: &FxFrameInputs,
) -> FxContext {
    let [tl, tr, br, bl] = inputs.footage.corners;
    let mut clicks = [[0.0; 4]; MAX_CLICKS];
    for (slot, ([x, y], age)) in clicks.iter_mut().zip(&inputs.clicks) {
        *slot = [*x, *y, *age, 1.0];
    }
    FxContext {
        resolution,
        time: programme_t,
        aspect: resolution[0] / resolution[1].max(1.0),
        region: region(effect, source_t, programme_t),
        cursor: inputs.cursor.map_or([0.0; 4], |[x, y]| [x, y, 1.0, 0.0]),
        clicks,
        footage: bounds(&inputs.footage.corners),
        camera: inputs.camera.unwrap_or([0.0; 4]),
        footage_corners: [[tl[0], tl[1], tr[0], tr[1]], [br[0], br[1], bl[0], bl[1]]],
        footage_aspect: inputs.footage_aspect,
        footage_warp: if inputs.footage.projective { 1.0 } else { 0.0 },
        _pad: [0.0; 2],
    }
}

/// Les paramètres de la région, rangés comme la struct `FxParams` générée (règles d'alignement de
/// WGSL), en mots de 4 octets. Une valeur absente vaut 0 : l'app envoie déjà les défauts.
pub fn pack_params(effect: &SceneShaderEffect) -> Vec<f32> {
    let mut words: Vec<f32> = Vec::new();
    let mut offset = 0usize;
    for p in &effect.params {
        let (size, align) = p.ty.size_align();
        offset = offset.div_ceil(align) * align;
        let end = offset + size;
        words.resize(end / 4, 0.0);
        let value: Vec<f32> = match effect.values.get(&p.name) {
            Some(ShaderParamValue::Scalar(v)) => vec![*v],
            Some(ShaderParamValue::Vector(v)) => v.clone(),
            None => Vec::new(),
        };
        for (i, v) in value.into_iter().take(size / 4).enumerate() {
            words[offset / 4 + i] = v;
        }
        offset = end;
    }
    words.resize(offset.div_ceil(16).max(1) * 4, 0.0);
    words
}

/// Le bytecode DXBC des deux étages, prêt pour `CreateVertexShader` / `CreatePixelShader`.
#[cfg(windows)]
pub struct CompiledFx {
    pub vs: Vec<u8>,
    pub ps: Vec<u8>,
}

#[cfg(windows)]
pub fn compile_dxbc(code: &str, params: &[ShaderParamDecl]) -> Result<CompiledFx, String> {
    let parsed = analyze(code, params)?;
    let hlsl = to_hlsl(&parsed)?;
    Ok(CompiledFx {
        vs: d3d_compile(&hlsl, "fx_vs", "vs_5_0")?,
        ps: d3d_compile(&hlsl, "fx_fs", "ps_5_0")?,
    })
}

#[cfg(windows)]
fn d3d_compile(hlsl: &str, entry: &str, profile: &str) -> Result<Vec<u8>, String> {
    use windows::core::PCSTR;
    use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
    use windows::Win32::Graphics::Direct3D::ID3DBlob;

    fn bytes(blob: &ID3DBlob) -> Vec<u8> {
        unsafe {
            std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize())
                .to_vec()
        }
    }
    let (entry_z, profile_z) = (format!("{entry}\0"), format!("{profile}\0"));
    let (mut code, mut errors): (Option<ID3DBlob>, Option<ID3DBlob>) = (None, None);
    let compiled = unsafe {
        D3DCompile(
            hlsl.as_ptr().cast(),
            hlsl.len(),
            PCSTR(b"effect.hlsl\0".as_ptr()),
            None,
            None,
            PCSTR(entry_z.as_ptr()),
            PCSTR(profile_z.as_ptr()),
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    match (compiled, code) {
        (Ok(()), Some(code)) => Ok(bytes(&code)),
        (result, _) => {
            let log = errors.as_ref().map(bytes).unwrap_or_default();
            Err(format!("{entry}: {result:?}\n{}", String::from_utf8_lossy(&log)))
        }
    }
}

/// Compile sur un thread à part ; le résultat arrive par le canal. naga + FXC prennent ~10 ms
/// pour un effet de 60 lignes, soit une frame de preview : jamais sur le thread de rendu.
#[cfg(windows)]
pub fn spawn_compile(effect: &SceneShaderEffect) -> std::sync::mpsc::Receiver<Result<CompiledFx, String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let (code, params) = (effect.code.clone(), effect.params.clone());
    std::thread::Builder::new()
        .name("shader-fx".into())
        .spawn(move || {
            let _ = tx.send(compile_dxbc(&code, &params));
        })
        .expect("thread shader-fx");
    rx
}

/// Le SPIR-V que wgpu tirera du même module pour Vulkan. Le compositeur Linux passe le WGSL à
/// wgpu, qui refait cette traduction lui-même : celle-ci ne sert qu'à la vérifier d'avance.
#[cfg(target_os = "linux")]
fn to_spirv(parsed: &Parsed) -> Result<Vec<u32>, String> {
    naga::back::spv::write_vec(&parsed.module, &parsed.info, &naga::back::spv::Options::default(), None)
        .map_err(|e| e.to_string())
}

/// Ce que l'outil de l'agent demande avant d'accepter un code : la validation, la compilation
/// réelle pour le backend de la machine quand elle existe, et le palier.
pub fn check_for_agent(code: &str, params: &[ShaderParamDecl]) -> Result<EffectReport, String> {
    let parsed = analyze(code, params)?;
    #[cfg(windows)]
    compile_dxbc(code, params)?;
    #[cfg(target_os = "linux")]
    to_spirv(&parsed)?;
    #[cfg(target_os = "macos")]
    compile_metal(&metal::Device::system_default().ok_or("no Metal device")?, code, params)?;
    Ok(parsed.report)
}

/// `check_for_agent`, les paramètres reçus en JSON (`[{ "name", "type" }, …]`) depuis l'addon.
pub fn check_for_agent_json(code: &str, params_json: &str) -> Result<EffectReport, String> {
    let params: Vec<ShaderParamDecl> =
        serde_json::from_str(params_json).map_err(|e| format!("params: {e}"))?;
    check_for_agent(code, &params)
}

/// Un effet tel que les tests et les bancs le construisent.
#[cfg(test)]
pub(crate) fn test_effect(code: &str, params: Vec<ShaderParamDecl>, values: &[(&str, ShaderParamValue)]) -> SceneShaderEffect {
    SceneShaderEffect {
        clip_index: Some(0),
        start_sec: 1.0,
        end_sec: 3.0,
        programme_start_sec: None,
        programme_end_sec: None,
        target: ShaderEffectTarget::Image,
        contract: CONTRACT,
        code: code.into(),
        params,
        values: values.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl(name: &str, ty: ShaderParamType) -> ShaderParamDecl {
        ShaderParamDecl { name: name.into(), ty }
    }

    const VIGNETTE: &str = "fn effect(uv: vec2<f32>) -> vec4<f32> {\n    let c = frame(uv);\n    let d = distance(uv, vec2<f32>(0.5));\n    return vec4<f32>(c.rgb * (1.0 - d * params.strength * ctx.region.x), c.a);\n}\n";

    #[test]
    fn a_valid_effect_becomes_hlsl_that_d3d11_accepts() {
        let parsed = analyze(VIGNETTE, &[decl("strength", ShaderParamType::Number)]).expect("analyze");
        let hlsl = to_hlsl(&parsed).expect("translate");
        assert!(hlsl.contains("fx_vs") && hlsl.contains("fx_fs"));
        // Les registres que les backends lient : t0, s1, b2 (ctx), b3 (params), sans `space`.
        for reg in ["register(t0)", "register(s1)", "register(b2)", "register(b3)"] {
            assert!(hlsl.contains(reg), "{reg} missing:\n{hlsl}");
        }
        assert!(!hlsl.contains("space"), "FXC ps_5_0 refuse les espaces de registres");
    }

    #[test]
    fn an_error_points_at_the_line_the_agent_wrote() {
        let broken = "fn effect(uv: vec2<f32>) -> vec4<f32> {\n    return frame(uv) * nope;\n}\n";
        let err = analyze(broken, &[]).err().expect("must fail");
        assert!(err.contains("nope") && err.contains(":2:"), "{err}");
    }

    #[test]
    fn an_effect_without_the_entry_function_is_refused() {
        assert!(analyze("fn other() {}", &[]).is_err());
    }

    #[test]
    fn an_effect_declares_no_binding_of_its_own() {
        let code = "@group(0) @binding(4) var extra: texture_2d<f32>;\n\
                    fn effect(uv: vec2<f32>) -> vec4<f32> { return textureLoad(extra, vec2<i32>(0), 0); }\n";
        let err = analyze(code, &[]).err().expect("refusé");
        assert!(err.contains("`extra` at line 1"), "{err}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_valid_effect_becomes_spirv() {
        let parsed = analyze(VIGNETTE, &[decl("strength", ShaderParamType::Number)]).expect("analyze");
        assert!(!to_spirv(&parsed).expect("spirv").is_empty());
    }

    #[test]
    fn parameter_names_are_checked() {
        for bad in ["Strength", "2x", "unused", "a-b"] {
            assert!(analyze(VIGNETTE, &[decl(bad, ShaderParamType::Number)]).is_err(), "{bad}");
        }
        let twice = [decl("a", ShaderParamType::Number), decl("a", ShaderParamType::Color)];
        assert!(analyze(VIGNETTE, &twice).is_err());
    }

    /// Le packer et la struct générée doivent placer chaque paramètre au même octet : un écart lirait
    /// une couleur là où l'app a écrit une force.
    #[test]
    fn the_packer_matches_the_offsets_naga_gives_the_generated_struct() {
        let params = vec![
            decl("a", ShaderParamType::Number),
            decl("tint", ShaderParamType::Color),
            decl("on", ShaderParamType::Toggle),
            decl("at", ShaderParamType::Point),
            decl("b", ShaderParamType::Number),
        ];
        let code = "fn effect(uv: vec2<f32>) -> vec4<f32> { return frame(uv) * params.a + params.tint * params.on + vec4<f32>(params.at, params.b, 0.0); }";
        let parsed = analyze(code, &params).expect("analyze");
        let ty = parsed
            .module
            .types
            .iter()
            .find(|(_, t)| t.name.as_deref() == Some("FxParams"))
            .expect("FxParams")
            .1;
        let naga::TypeInner::Struct { members, span } = &ty.inner else { panic!("struct") };
        let values = [
            ("a", ShaderParamValue::Scalar(1.0)),
            ("tint", ShaderParamValue::Vector(vec![2.0, 3.0, 4.0, 5.0])),
            ("on", ShaderParamValue::Scalar(6.0)),
            ("at", ShaderParamValue::Vector(vec![7.0, 8.0])),
            ("b", ShaderParamValue::Scalar(9.0)),
        ];
        let words = pack_params(&test_effect(code, params, &values));
        assert_eq!(words.len() * 4, (*span as usize).div_ceil(16) * 16);
        let first = |name: &str| members.iter().find(|m| m.name.as_deref() == Some(name)).unwrap().offset as usize / 4;
        assert_eq!(words[first("a")], 1.0);
        assert_eq!(&words[first("tint")..first("tint") + 4], &[2.0, 3.0, 4.0, 5.0]);
        assert_eq!(words[first("on")], 6.0);
        assert_eq!(&words[first("at")..first("at") + 2], &[7.0, 8.0]);
        assert_eq!(words[first("b")], 9.0);
    }

    #[test]
    fn the_context_matches_its_wgsl_struct() {
        let parsed = analyze(VIGNETTE, &[decl("strength", ShaderParamType::Number)]).unwrap();
        let ty = parsed.module.types.iter().find(|(_, t)| t.name.as_deref() == Some("FxContext")).unwrap().1;
        let naga::TypeInner::Struct { members, span } = &ty.inner else { panic!("struct") };
        assert_eq!(std::mem::size_of::<FxContext>(), *span as usize);
        let offset = |name: &str| members.iter().find(|m| m.name.as_deref() == Some(name)).unwrap().offset as usize;
        let c = FxContext::default();
        let base = &c as *const FxContext as usize;
        assert_eq!(offset("region"), &c.region as *const _ as usize - base);
        assert_eq!(offset("clicks"), &c.clicks as *const _ as usize - base);
        assert_eq!(offset("camera"), &c.camera as *const _ as usize - base);
        assert_eq!(offset("footage_corners"), &c.footage_corners as *const _ as usize - base);
        assert_eq!(offset("footage_warp"), &c.footage_warp as *const _ as usize - base);
    }

    #[test]
    fn a_for_loop_with_literal_bounds_is_counted() {
        let code = "fn effect(uv: vec2<f32>) -> vec4<f32> {\n    var acc = vec4<f32>(0.0);\n    for (var i = 0; i < 16; i++) {\n        acc += frame(uv + vec2<f32>(f32(i) * 0.001, 0.0));\n    }\n    return acc / 16.0;\n}\n";
        let r = analyze(code, &[]).expect("analyze").report;
        assert_eq!((r.frame_reads, r.iterations, r.tier), (16, 16, Tier::Medium));
    }

    #[test]
    fn nested_loops_multiply_and_called_functions_are_unfolded() {
        let code = "fn tap(uv: vec2<f32>) -> vec4<f32> { return frame(uv) + frame(uv * 0.5); }\nfn effect(uv: vec2<f32>) -> vec4<f32> {\n    var acc = vec4<f32>(0.0);\n    for (var y = 0u; y <= 7u; y += 1u) {\n        for (var x = 8; x > 0; x--) {\n            acc += tap(uv);\n        }\n    }\n    return acc;\n}\n";
        let r = analyze(code, &[]).expect("analyze").report;
        assert_eq!(r.frame_reads, 8 * 8 * 2);
        assert_eq!(r.iterations, 8 * (8 + 1));
        assert_eq!(r.tier, Tier::Heavy);
    }

    #[test]
    fn a_branch_counts_for_the_dearer_side() {
        let code = "fn effect(uv: vec2<f32>) -> vec4<f32> {\n    if (uv.x > 0.5) { return frame(uv) + frame(uv) + frame(uv); }\n    return frame(uv);\n}\n";
        assert_eq!(analyze(code, &[]).unwrap().report.frame_reads, 4, "branche chère + suite");
    }

    #[test]
    fn loops_without_a_literal_bound_are_refused_with_their_line() {
        let refused = [
            ("fn effect(uv: vec2<f32>) -> vec4<f32> {\n    var i = 0;\n    loop {\n        i++;\n        if (i > 4) { break; }\n    }\n    return frame(uv);\n}\n", 3),
            ("fn effect(uv: vec2<f32>) -> vec4<f32> {\n    var i = 0;\n    while (i < 4) {\n        i++;\n    }\n    return frame(uv);\n}\n", 3),
            ("fn effect(uv: vec2<f32>) -> vec4<f32> {\n    let n = i32(uv.x * 100.0);\n    for (var i = 0; i < n; i++) {}\n    return frame(uv);\n}\n", 3),
            ("fn effect(uv: vec2<f32>) -> vec4<f32> {\n    for (var i = 0; i < 4; i++) { i = 0; }\n    return frame(uv);\n}\n", 2),
            ("fn effect(uv: vec2<f32>) -> vec4<f32> {\n    for (var i = 0; i < 4; i--) {}\n    return frame(uv);\n}\n", 2),
        ];
        for (code, line) in refused {
            let err = analyze(code, &[]).err().unwrap_or_else(|| panic!("accepted: {code}"));
            assert!(err.contains(&format!("line {line}")) && err.contains("for (var i = 0"), "{err}");
        }
    }

    /// Le compteur part de la valeur qu'il a à l'entrée de SA boucle : le dernier `Store` qui la
    /// précède dans son bloc, pas une écriture plus loin. Une écriture ailleurs le rendrait
    /// inconnu : refusée, pour que le plafond de sécurité ne compte jamais trop peu de tours.
    #[test]
    fn the_counter_starts_from_its_value_at_the_loop() {
        let wrap = |body: &str| format!("fn effect(uv: vec2<f32>) -> vec4<f32> {{\n    var i = 0;\n{body}\n    return frame(uv);\n}}\n");
        let reused = wrap("    i = 2;\n    for (; i < 6; i++) {}");
        assert_eq!(analyze(&reused, &[]).expect("analyze").report.iterations, 4);
        let refused = [
            // Écrit après la boucle : si son bloc se répète, la valeur d'entrée n'est plus 0.
            wrap("    for (; i < 4; i++) {}\n    i = -100000;"),
            // Écrit dans un autre bloc avant la boucle : 100 004 tours, pas 4.
            wrap("    if (uv.x > 0.5) { i = -100000; }\n    for (; i < 4; i++) {}"),
            // Deux boucles sur le même compteur : chacune voit le pas de l'autre.
            wrap("    for (; i < 4; i++) { }\n    for (; i < 8; i++) { }"),
        ];
        for code in refused {
            let err = analyze(&code, &[]).err().unwrap_or_else(|| panic!("accepted: {code}"));
            assert!(err.contains("writes its counter outside its header"), "{err}");
        }
    }

    #[test]
    fn a_module_constant_is_a_literal_bound() {
        let code = "const TAPS = 12;\nfn effect(uv: vec2<f32>) -> vec4<f32> {\n    var acc = vec4<f32>(0.0);\n    for (var i = 0; i < TAPS; i += 3) { acc += frame(uv); }\n    return acc;\n}\n";
        assert_eq!(analyze(code, &[]).expect("analyze").report.iterations, 4);
    }

    #[test]
    fn the_safety_ceiling_refuses_runaway_work() {
        let code = "fn effect(uv: vec2<f32>) -> vec4<f32> {\n    var a = 0.0;\n    for (var i = 0; i < 100; i++) { for (var j = 0; j < 100; j++) { a += 1.0; } }\n    return frame(uv) * a;\n}\n";
        let err = analyze(code, &[]).err().expect("must fail");
        assert!(err.contains("10100") && err.contains("4096"), "{err}");
    }

    /// Le ripple de l'exemple C.6 de la spec, et ses paramètres.
    fn spec_ripple() -> (&'static str, Vec<ShaderParamDecl>) {
        let code = include_str!("../../../docs/shader-effects.md")
            .split("```wgsl\n")
            .nth(2)
            .and_then(|s| s.split("```").next())
            .expect("l'exemple C.6");
        let params = vec![
            decl("strength", ShaderParamType::Number),
            decl("radius", ShaderParamType::Number),
            decl("duration", ShaderParamType::Number),
        ];
        (code, params)
    }

    #[test]
    fn the_ripple_of_the_spec_is_light() {
        let (code, params) = spec_ripple();
        let r = analyze(code, &params).expect("l'exemple de la spec compile").report;
        assert_eq!((r.frame_reads, r.tier), (1, Tier::Light));
    }

    /// The examples agents read in the MCP resource (`electron/mcp/effects-contract.ts`) compile
    /// against this prelude, at the tier the resource promises.
    #[test]
    fn the_examples_of_the_mcp_contract_compile() {
        let [(ripple, ripple_params), (vignette, vignette_params)] = mcp_examples();
        assert_eq!(analyze(&ripple, &ripple_params).expect("ripple").report.tier, Tier::Light);
        assert_eq!(analyze(&vignette, &vignette_params).expect("vignette").report.tier, Tier::Light);
    }

    /// Les deux exemples de la ressource MCP (`electron/mcp/effects-contract.ts`), le ripple et la
    /// vignette, avec leurs paramètres.
    fn mcp_examples() -> [(String, Vec<ShaderParamDecl>); 2] {
        let src = include_str!("../../../electron/mcp/effects-contract.ts");
        let examples: Vec<String> = src
            .split("## Example")
            .skip(1)
            .map(|section| {
                section
                    .lines()
                    .filter_map(|l| l.strip_prefix("    "))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect();
        let [ripple, vignette]: [String; 2] = examples.try_into().expect("le ripple et la vignette");
        [
            (
                ripple,
                vec![
                    decl("strength", ShaderParamType::Number),
                    decl("radius", ShaderParamType::Number),
                    decl("duration", ShaderParamType::Number),
                ],
            ),
            (vignette, vec![decl("depth", ShaderParamType::Number), decl("tint", ShaderParamType::Color)]),
        ]
    }

    #[test]
    fn the_active_regions_and_their_progress() {
        let mut a = test_effect(VIGNETTE, vec![], &[]);
        (a.start_sec, a.end_sec) = (3.0, 4.0);
        let b = test_effect(VIGNETTE, vec![], &[]);
        let effects = [a, b];
        assert!(active_effects(&effects, 0.5).is_empty());
        let during = active_effects(&effects, 2.0);
        assert!(during.len() == 1 && std::ptr::eq(during[0], &effects[1]));
        let after = active_effects(&effects, 3.0);
        assert!(after.len() == 1 && std::ptr::eq(after[0], &effects[0]), "fin exclusive");
        let mut c = test_effect(VIGNETTE, vec![], &[]);
        (c.start_sec, c.end_sec) = (0.7, 1.3);
        let fractional = [c];
        assert_eq!(active_effects(&fractional, 0.7).len(), 1, "début fractionnaire inclus");
        assert!(active_effects(&fractional, 1.3).is_empty(), "fin fractionnaire exclue");

        let ctx = context(&effects[1], 2.0, 10.0, [1920.0, 1080.0], &FxFrameInputs::default());
        assert_eq!(ctx.region, [0.5, 2.0, 1.0, 0.0], "fragment, temps source");
        let mut whole = effects[1].clone();
        (whole.programme_start_sec, whole.programme_end_sec) = (Some(8.0), Some(12.0));
        let ctx = context(&whole, 2.0, 10.0, [1920.0, 1080.0], &FxFrameInputs::default());
        assert_eq!(ctx.region, [0.5, 4.0, 2.0, 0.0], "pilule entière, temps programme");
        assert_eq!((ctx.cursor[2], ctx.clicks[0][3], ctx.camera), (0.0, 0.0, [0.0; 4]));

        let inputs = FxFrameInputs {
            cursor: Some([0.25, 0.5]),
            clicks: vec![([0.3, 0.6], 0.2), ([0.1, 0.1], 1.5)],
            footage: FootageQuad {
                corners: [[0.25, 0.5], [0.75, 0.25], [0.625, 0.75], [0.25, 0.625]],
                projective: true,
            },
            footage_aspect: 16.0 / 9.0,
            camera: Some([0.7, 0.7, 0.2, 0.2]),
        };
        let ctx = context(&whole, 2.0, 10.0, [1920.0, 1080.0], &inputs);
        assert_eq!(ctx.cursor, [0.25, 0.5, 1.0, 0.0]);
        assert_eq!(ctx.clicks[..3], [[0.3, 0.6, 0.2, 1.0], [0.1, 0.1, 1.5, 1.0], [0.0; 4]]);
        assert_eq!((ctx.footage, ctx.camera), ([0.25, 0.25, 0.5, 0.5], [0.7, 0.7, 0.2, 0.2]));
        assert_eq!(ctx.footage_corners, [[0.25, 0.5, 0.75, 0.25], [0.625, 0.75, 0.25, 0.625]]);
        assert_eq!((ctx.footage_aspect, ctx.footage_warp), (16.0 / 9.0, 1.0));
    }

    #[test]
    fn eviction_spares_the_effects_the_scene_shows() {
        let scene = [test_effect(VIGNETTE, vec![], &[]), test_effect("fn effect(uv: vec2<f32>) -> vec4<f32> { return frame(uv); }", vec![], &[])];
        let (a, b) = (source_hash(&scene[0]), source_hash(&scene[1]));
        let entries = || [(a, 1), (b, 2), (7, 5), (9, 3)].into_iter();
        assert_eq!(eviction_victim(entries(), &scene), Some(9), "la plus ancienne hors de la scène");
        assert_eq!(eviction_victim(entries(), &[]), Some(a), "sans scène, la plus ancienne");
        assert_eq!(eviction_victim([(a, 1), (b, 2)].into_iter(), &scene), None, "tout est montré");
    }

    #[test]
    fn the_cache_key_follows_code_and_layout_not_values() {
        let p = vec![decl("strength", ShaderParamType::Number)];
        let a = test_effect(VIGNETTE, p.clone(), &[("strength", ShaderParamValue::Scalar(1.0))]);
        let mut b = test_effect(VIGNETTE, p, &[("strength", ShaderParamValue::Scalar(2.0))]);
        assert_eq!(source_hash(&a), source_hash(&b), "une valeur ne recompile rien");
        b.params[0].ty = ShaderParamType::Color;
        assert_ne!(source_hash(&a), source_hash(&b), "un layout différent est un autre binaire");
    }

    #[cfg(windows)]
    #[test]
    fn fxc_compiles_both_stages() {
        let c = compile_dxbc(VIGNETTE, &[decl("strength", ShaderParamType::Number)]).expect("compile");
        assert!(!c.vs.is_empty() && !c.ps.is_empty());
    }

    /// Les bindings que `compositor_macos` lie sont ceux du MSL : la texture en 0, `ctx` et
    /// `params` aux buffers 2 et 3, le sampler en `constexpr`, et aucun binding inventé.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_valid_effect_becomes_msl_with_the_bindings_metal_binds() {
        let parsed = analyze(VIGNETTE, &[decl("strength", ShaderParamType::Number)]).expect("analyze");
        let msl = to_msl(&parsed).expect("translate");
        assert!(msl.source.contains(&msl.vs) && msl.source.contains(&msl.fs));
        for binding in ["[[texture(0)]]", "[[buffer(2)]]", "[[buffer(3)]]", "constexpr metal::sampler"] {
            assert!(msl.source.contains(binding), "{binding} missing:\n{}", msl.source);
        }
        assert!(!msl.source.contains("fake"), "binding inventé :\n{}", msl.source);
    }

    /// « Accepté » veut dire « se dessinera » : le compilateur de Metal et le pipeline state
    /// acceptent l'exemple de la spec, les deux de la ressource MCP et un effet qui lit chaque
    /// type de paramètre.
    #[cfg(target_os = "macos")]
    #[test]
    fn metal_compiles_the_examples() {
        let Some(device) = metal::Device::system_default() else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let (ripple, ripple_params) = spec_ripple();
        compile_metal(&device, ripple, &ripple_params).expect("le ripple de la spec");
        for (code, params) in mcp_examples() {
            compile_metal(&device, &code, &params).expect("un exemple de la ressource MCP");
        }
        let every_type = [
            decl("a", ShaderParamType::Number),
            decl("tint", ShaderParamType::Color),
            decl("on", ShaderParamType::Toggle),
            decl("at", ShaderParamType::Point),
        ];
        let code = "fn effect(uv: vec2<f32>) -> vec4<f32> {\n    let n = fx_hash(vec2<u32>(uv * ctx.resolution));\n    let d = distance(uv, params.at) * ctx.aspect + fx_px(4.0) + n * 0.0;\n    return mix(frame(uv), params.tint, params.on * params.a * ctx.clicks[0].w * d);\n}\n";
        compile_metal(&device, code, &every_type).expect("chaque type de paramètre");
        check_for_agent(VIGNETTE, &[decl("strength", ShaderParamType::Number)]).expect("check_for_agent");
    }
}
