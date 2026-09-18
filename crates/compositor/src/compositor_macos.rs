//! Moteur de composition macOS — Metal + VideoToolbox.
//!
//! Ce module EST l'équivalent macOS de `compositor_windows.rs`. Il exporte la
//! même surface publique (`Compositor`, `LiveParams`, les helpers `webcam_shape_code`/
//! `live_params_from_scene`, et les constantes `OUT_W`/`OUT_H`/`FIXTURE_FRAMES`) pour
//! que `live.rs`, `pipeline.rs` et `compositor-view-napi` restent portables.
//!
//! # Frame seam — `nv12_srvs` + `tex_dims`
//!
//! Le seam que `compositor_windows.rs` couvre avec deux `ID3D11ShaderResourceView`
//! (Y R8 + UV R8G8 sur l'array-slice d'une texture D3D11VA) est ici couvert par
//! deux `MTLTexture` produits par `CVMetalTextureCacheCreateTextureFromImage` à
//! partir d'un `CVPixelBufferRef` (le buffer natif macOS, IOSurface-backed).
//! Les 4 champs AVFrame lus sont identiques : `data[0]` (texture native), `data[1]`
//! (toujours 0 — pas d'array côté CoreVideo), `width`/`height` (visibles).
//!
//! # Chemin de lecture CPU
//!
//! Metal n'a pas d'équivalent de `ID3D11DeviceContext::Map` sur une ressource
//! `Private`. Les cibles de rendu (`rt`, `nv12_y`, `nv12_uv`) sont donc en
//! `StorageMode::Private`, et chaque passe se termine par un `MTLBlitCommandEncoder`
//! vers un miroir `Shared` (`rt_read`, `nv12_read_y`, `nv12_read_uv`) sur lequel
//! `getBytes` est légal. Le `waitUntilCompleted` qui suit est ce qui rend
//! `readback_direct` synchrone, comme son homologue Windows : sans lui, la preview
//! lirait le contenu de la frame précédente (ou du noir au premier tour).

use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::ffi::AVFrame;
// Le constant buffer est le MÊME struct des deux côtés — cf. `frame_geometry`.
// Constant buffer, params runtime et constantes de sortie : une seule définition pour
// les deux backends — cf. `frame_geometry`, qui documente les divergences que
// l'unification a corrigées.
pub use crate::frame_geometry::{
    live_params_from_scene, webcam_shape_code, FIXTURE_FRAMES, LayerCB, LiveParams, OUT_H, OUT_W,
};
use crate::frame_geometry::{parse_hex, FrameGeometryInput, ShadowCaster,
    SCREEN_SHADOW_SPREAD_FRAC, WEBCAM_SHADOW_OFFSET_FRAC, WEBCAM_SHADOW_OPACITY,
    WEBCAM_SHADOW_SPREAD_FRAC};
use crate::scene::{Scene, SceneBackground};
use anyhow::{anyhow, Result};
use metal::foreign_types::ForeignType;
use std::cell::RefCell;

/// Budget du cache de textures image (`img_cache`), en octets. Même valeur et même raison que
/// `compositor_windows::IMG_CACHE_BUDGET_BYTES`.
///
/// Doit tenir le JEU ACTIF d'une frame — au pire un wallpaper d'écran ET un fond de caméra, que
/// rien n'empêche d'être deux 7680x7680 à 225 Mo pièce. Sous ce seuil l'éviction ne peut plus
/// rendre de mémoire sans toucher au jeu actif, ce qu'elle refuse de faire. 512 Mo borne la fuite
/// (1 774 Mo mesurés en parcourant les 18 wallpapers livrés) en laissant le jeu actif résident.
const IMG_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// CVMetalTextureCache — le pont CVPixelBuffer → MTLTexture
// ---------------------------------------------------------------------------

/// Newtype safe Rust pour `CVMetalTextureCacheRef` (`*mut __CVMetalTextureCache`).
pub(crate) struct CVMetalTextureCache(std::ptr::NonNull<std::ffi::c_void>);

unsafe impl Send for CVMetalTextureCache {}
unsafe impl Sync for CVMetalTextureCache {}

#[link(name = "CoreVideo", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
#[link(name = "Metal", kind = "framework")]
extern "C" {
    fn CVMetalTextureCacheCreate(
        allocator: *const std::ffi::c_void,
        cache_attributes: *const std::ffi::c_void,
        metal_device: *const std::ffi::c_void, // id<MTLDevice>
        texture_attributes: *const std::ffi::c_void,
        cache_out: *mut *mut std::ffi::c_void, // CVMetalTextureCacheRef*
    ) -> i32; // CVReturn

    fn CVMetalTextureCacheCreateTextureFromImage(
        allocator: *const std::ffi::c_void,
        cache: *mut std::ffi::c_void,
        pixel_buffer: *mut std::ffi::c_void,
        texture_attributes: *const std::ffi::c_void,
        // `MTLPixelFormat` est un `NSUInteger`, donc 64 bits sur arm64/x86_64. Le
        // déclarer `u32` laissait la moitié haute du registre indéfinie côté appelé.
        pixel_format: u64,
        width: usize,
        height: usize,
        plane_index: usize,
        texture_out: *mut *mut std::ffi::c_void, // CVMetalTextureRef*
    ) -> i32; // CVReturn

    fn CVMetalTextureCacheFlush(cache: *mut std::ffi::c_void, options: u64);
    fn CVMetalTextureGetTexture(cv_texture: *mut std::ffi::c_void) -> *mut std::ffi::c_void;

    fn CFRelease(cf: *const std::ffi::c_void);

    fn CVPixelBufferGetWidthOfPlane(p: *mut std::ffi::c_void, plane_index: usize) -> usize;
    fn CVPixelBufferGetHeightOfPlane(p: *mut std::ffi::c_void, plane_index: usize) -> usize;
    fn CVPixelBufferGetWidth(p: *mut std::ffi::c_void) -> usize;
    fn CVPixelBufferGetHeight(p: *mut std::ffi::c_void) -> usize;
}

/// `retain` ObjC sur un `id`. `CVMetalTextureGetTexture` rend une référence
/// *empruntée* au `CVMetalTextureRef` qui la porte : relâcher ce dernier sans
/// retenir la texture donne un `id<MTLTexture>` mort. Et ne jamais le relâcher —
/// ce que faisait la première version — fuit un objet CoreVideo par plan et par
/// frame, soit 120 fuites par seconde en preview 60 fps.
extern "C" {
    fn objc_retain(obj: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

impl CVMetalTextureCache {
    /// Crée un `CVMetalTextureCache` lié au `MTLDevice` donné.
    pub(crate) fn new(metal_device: *const std::ffi::c_void) -> Result<Self> {
        let mut cache: *mut std::ffi::c_void = std::ptr::null_mut();
        let status = unsafe {
            CVMetalTextureCacheCreate(
                std::ptr::null(),
                std::ptr::null(), // default cache attributes
                metal_device,
                std::ptr::null(), // default texture attributes
                &mut cache,
            )
        };
        if status != 0 || cache.is_null() {
            return Err(anyhow!(
                "CVMetalTextureCacheCreate a échoué (CVReturn={status}, cache={cache:?})"
            ));
        }
        Ok(CVMetalTextureCache(unsafe {
            std::ptr::NonNull::new_unchecked(cache)
        }))
    }

    /// Wrappe le plan `plane_index` d'un `CVPixelBufferRef` en `MTLTexture`, zéro copie
    /// (le `MTLTexture` partage l'IOSurface du `CVPixelBuffer`).
    ///
    /// Pas de cache `(pixel_buffer, plane)` côté Rust : `CVMetalTextureCache` EST déjà
    /// ce cache — il rend la même texture pour le même IOSurface. Un second cache indexé
    /// sur l'ADRESSE du `CVPixelBufferRef` est en plus faux dès que le pool VideoToolbox
    /// recycle une adresse, et ne se vide jamais.
    pub(crate) fn make_texture_from_pixel_buffer(
        &self,
        pixel_buffer: *mut std::ffi::c_void,
        plane_index: usize,
        pixel_format: metal::MTLPixelFormat,
    ) -> Result<metal::Texture> {
        let (w, h) = unsafe {
            (
                CVPixelBufferGetWidthOfPlane(pixel_buffer, plane_index),
                CVPixelBufferGetHeightOfPlane(pixel_buffer, plane_index),
            )
        };
        if w == 0 || h == 0 {
            return Err(anyhow!(
                "CVPixelBuffer plan {plane_index} vide ({w}x{h}) — buffer non planaire ?"
            ));
        }
        let mut cv_texture: *mut std::ffi::c_void = std::ptr::null_mut();
        let status = unsafe {
            CVMetalTextureCacheCreateTextureFromImage(
                std::ptr::null(),
                self.0.as_ptr(),
                pixel_buffer,
                std::ptr::null(),
                pixel_format as u64,
                w,
                h,
                plane_index,
                &mut cv_texture,
            )
        };
        if status != 0 || cv_texture.is_null() {
            return Err(anyhow!(
                "CVMetalTextureCacheCreateTextureFromImage a échoué (CVReturn={status}, plane={plane_index}, {w}x{h}, fmt={pixel_format:?})"
            ));
        }
        let borrowed = unsafe { CVMetalTextureGetTexture(cv_texture) };
        if borrowed.is_null() {
            unsafe { CFRelease(cv_texture) };
            return Err(anyhow!(
                "CVMetalTextureGetTexture a renvoyé un id<MTLTexture> nul (plane={plane_index})"
            ));
        }
        // retain la texture, puis relâche le CVMetalTextureRef : la `metal::Texture`
        // rendue possède désormais sa propre référence, et son `Drop` fera le release.
        let owned = unsafe { objc_retain(borrowed) };
        unsafe { CFRelease(cv_texture) };
        Ok(unsafe { metal::Texture::from_ptr(owned as *mut metal::MTLTexture) })
    }

    /// Libère les textures que CoreVideo garde en cache. À appeler quand les
    /// `CVPixelBuffer` sources changent de dimensions (les entrées cachées pointent
    /// alors sur l'IOSurface précédent).
    pub(crate) fn flush(&self) {
        unsafe { CVMetalTextureCacheFlush(self.0.as_ptr(), 0) };
    }
}

impl Drop for CVMetalTextureCache {
    fn drop(&mut self) {
        unsafe {
            CVMetalTextureCacheFlush(self.0.as_ptr(), 0);
            // `CVMetalTextureCacheRef` est un CFType : c'est `CFRelease` qui le libère.
            // La version précédente ne faisait que le flush et fuitait le cache lui-même.
            CFRelease(self.0.as_ptr());
        }
    }
}

// ---------------------------------------------------------------------------
// Segmentation du sujet webcam
// ---------------------------------------------------------------------------

/// Cadence de l'inférence. Même valeur et même raison que
/// `compositor_windows::SEGMENTATION_HZ` : une silhouette ne bouge pas de façon
/// perceptible en 16 ms, et c'est le seul levier mesuré qui divise le coût par deux sans
/// toucher au modèle.
const SEGMENTATION_HZ: u32 = 30;

/// Cible RGBA + miroir de lecture pour extraire la frame webcam à la résolution du modèle.
///
/// Deux textures, pas une : `rt` est `Private` parce que c'est une cible de rendu, et
/// `get_bytes` n'est légal que sur du `Shared`. C'est exactement le couple
/// `nv12_y`/`nv12_read_y` du chemin d'encodage, en RGBA et à 256x144 — cf. l'en-tête du
/// module. `Managed` n'a pas sa place ici : rien dans ce fichier n'en utilise, et c'est le
/// seul mode de stockage qui exigerait un `synchronizeResource` avant la lecture.
struct SegCapture {
    /// Cible de la passe de capture. `Private` : écrite par le GPU, jamais lue par le CPU.
    rt: metal::Texture,
    /// Miroir `Shared` de `rt`, rempli par blit dans le même command buffer.
    read: metal::Texture,
    width: u32,
    height: u32,
}

/// Texture du masque de segmentation, recréée seulement quand la résolution du modèle
/// change — c'est-à-dire jamais, en régime établi. Pendant Metal de
/// `compositor_windows::WebcamMask` : pas de vue à côté de la texture, un `MTLTexture` est
/// déjà ce que `set_fragment_texture` prend.
struct WebcamMask {
    tex: metal::Texture,
    width: u32,
    height: u32,
}

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

/// Le moteur de composition. Chaque frame décodée arrive comme un `CVPixelBufferRef`
/// IOSurface-backed (`mac_frames::CpuFrames::present` / VideoToolbox hwaccel), et
/// `nv12_srvs` le convertit en deux `MTLTexture` zéro-copie via `CVMetalTextureCache`.
///
/// **First-pass engine** : `compose_frame` rend la couche écran en plein cadre (mode 0
/// du méga-shader `ps_main`). Les couches suivantes — webcam, coins arrondis, ombres,
/// pyramide Kawase, motion blur — existent déjà dans `shaders.metal` mais ne sont pas
/// encore pilotées ici ; c'est ce que couvre le commit « couches » à suivre.
pub struct Compositor {
    gpu: Gpu,
    render_w: u32,
    render_h: u32,
    scene: RefCell<Option<Scene>>,
    cursor: RefCell<Option<crate::cursor::CursorTrack>>,
    cursor_time: RefCell<Option<f32>>,
    timeline_time: RefCell<Option<f32>>,
    /// Temps programme (secondes de sortie) — cf. `FrameGeometryInput::programme_time`.
    programme_time: RefCell<Option<f32>>,
    live_params: RefCell<LiveParams>,
    metal_texture_cache: CVMetalTextureCache,
    /// Dernier command buffer soumis, gardé pour pouvoir l'attendre AU MOMENT où le CPU lit
    /// vraiment. Soumettre puis attendre tout de suite vide le pipeline à chaque frame :
    /// le GPU finit, le CPU décode et encode pendant que le GPU dort, et on paie la latence
    /// d'un aller-retour complet par passe au lieu de laisser les deux se recouvrir.
    last_cmd: RefCell<Option<metal::CommandBuffer>>,
    /// Wallpapers décodés, indexés par chemin (ou par data-URI pour les annotations image).
    /// Le décode + upload coûte des millisecondes ; le faire à chaque frame ferait chuter la
    /// preview sur un fond image. L'entrée reste néanmoins évinçable dès qu'elle sort du jeu
    /// actif d'une frame — cf. `cached_image`.
    img_cache: RefCell<std::collections::HashMap<String, (metal::Texture, u32, u32, u64)>>,
    /// Compteur d'accès de `img_cache`, pour l'ordre LRU. Un compteur plutôt que l'index de
    /// frame : une frame touche plusieurs entrées, et il faut pouvoir les ordonner entre elles.
    img_tick: std::cell::Cell<u64>,
    /// Valeur de `img_tick` au début de la frame en cours. Tout ce qui a été touché depuis
    /// appartient au jeu actif et ne peut pas être évincé — voir `cached_image`.
    img_frame_start: std::cell::Cell<u64>,
    /// Champs de distance des sprites de curseur (mode 15), R16F, par chemin, avec leur forme.
    /// Pas d'éviction : seuls les seize sprites du thème par défaut y passent (~2,6 Mo en tout).
    sdf_cache: RefCell<
        std::collections::HashMap<String, (metal::Texture, crate::frame_geometry::SpriteShape)>,
    >,

    // --- Engine : render targets ---
    /// Render target principal RGBA8. Cible de `compose_frame`. `Private` : c'est une
    /// cible de rendu pure, jamais lue par le CPU (c'est `rt_read` qui l'est).
    rt: metal::Texture,
    /// Miroir `Shared` de `rt`, rempli par blit à la fin de `compose_frame` — la seule
    /// façon d'atteindre `getBytes` depuis une cible `Private`.
    rt_read: metal::Texture,
    /// NV12 interne : plan Y `R8Unorm`, plan UV `RG8Unorm` (demi-résolution).
    nv12_y: metal::Texture,
    nv12_uv: metal::Texture,
    /// Miroirs `Shared` des deux plans, pour `read_nv12_scaled`.
    nv12_read_y: metal::Texture,
    nv12_read_uv: metal::Texture,

    // --- Engine : shaders compilés ---
    /// MSL library compilée dans `new_sized`. Conservée : les pipeline states en
    /// dépendent, et un futur commit recompilera des variantes à partir d'elle.
    _library: metal::Library,
    /// Pipeline state pour la passe principale (`vs_main` + `ps_main`).
    pipeline_main: metal::RenderPipelineState,
    /// Pipeline states pour les passes fullscreen (`vs_fs` + `ps_y`/`ps_uv`/`ps_tex`).
    pipeline_fs_y: metal::RenderPipelineState,
    pipeline_fs_uv: metal::RenderPipelineState,
    /// Composite plein écran d'une texture sur le RT (`vs_fs` + `ps_tex`), en « over ».
    /// C'est la passe qui rapatrie l'accumulation de traînée sur la scène.
    pipeline_fs_tex: metal::RenderPipelineState,
    /// `vs_main` + `ps_main` en additif : les échantillons de traînée du curseur.
    pipeline_add: metal::RenderPipelineState,
    /// Buffer d'accumulation ISOLÉ (transparent) pour la traînée. Accumuler directement sur
    /// le RT reviendrait à AJOUTER du blanc à ce qui est déjà dessous : sur un fond clair,
    /// le curseur disparaît. Même raisonnement que côté D3D11.
    accum: metal::Texture,
    /// Pyramide dual-Kawase du flou de fond : demi, quart, huitième de la taille de rendu.
    /// Dérivée de la taille de rendu et non d'une constante — sinon le rayon effectif du
    /// flou changerait avec la résolution de sortie.
    blur_half: metal::Texture,
    blur_quarter: metal::Texture,
    blur_eighth: metal::Texture,
    pipeline_kdown: metal::RenderPipelineState,
    pipeline_kup: metal::RenderPipelineState,
    /// Copie MIPMAPPÉE du render target, pour les annotations « flou ». On ne peut pas
    /// échantillonner la cible sur laquelle on dessine, et le mode 10 lit un niveau de mip
    /// pour flouter à coût constant.
    ann_copy: metal::Texture,
    /// Pyramide de profondeur de champ (mode 8) : la vidéo en RGBA8 à demi-résolution de la
    /// texture DÉCODEUR, mips compris. Allouée au premier écran incliné, recréée quand la
    /// texture décodeur change de taille. Cf. `compositor_windows::DofPyramid`.
    dof_pyramid: RefCell<Option<metal::Texture>>,
    /// Images d'annotation, indexées par ID d'annotation (pas par data-URL : celle-ci pèse
    /// souvent des mégaoctets et la hacher à chaque frame coûterait plus que le décodage).
    /// La longueur sert de garde-fou quand l'utilisateur change l'image.
    ann_img_cache: RefCell<std::collections::HashMap<String, (metal::Texture, u32, u32, usize)>>,
    /// Textes rastérisés, indexés par ID, avec la `cache_key` du spec pour invalider.
    text_cache: RefCell<std::collections::HashMap<String, (metal::Texture, u64)>>,
    text_raster: Option<crate::text::TextRasterizer>,

    // --- Segmentation du sujet webcam (cf. `pump_segmentation`) ---
    /// Masque du sujet, R8 à la résolution du modèle. Écrit par `set_webcam_mask`, lu au
    /// moment de dessiner la webcam. `None` tant qu'aucune frame n'a été segmentée — l'effet
    /// reste alors éteint plutôt que de rendre une webcam invisible en mode détourage.
    webcam_mask: RefCell<Option<WebcamMask>>,
    /// Cible + miroir de la capture, créés à la première capture et jamais redimensionnés :
    /// le modèle a une entrée fixe.
    seg_capture: RefCell<Option<SegCapture>>,
    /// Worker d'inférence, absent tant que `enable_segmentation` n'a pas été appelé.
    seg_worker: RefCell<Option<crate::segmentation::SegmentationWorker>>,
    /// Segmenteur tenu SUR LE THREAD DE RENDU, utilisé à la place du worker en mode
    /// déterministe. Voir `set_segmentation_deterministic`.
    seg_sync: RefCell<Option<crate::segmentation::Segmenter>>,
    /// Export : cadence par frame et inférence synchrone, au lieu de l'horloge et du worker.
    seg_deterministic: std::cell::Cell<bool>,
    /// Boîte aux lettres du worker. Le masque est déposé depuis le thread d'inférence et
    /// téléversé depuis le thread de rendu : aucun appel Metal ne traverse de thread.
    seg_inbox: std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>,
    seg_rate: RefCell<crate::segmentation::RateLimiter>,
    /// Frame RGB réutilisée d'une capture à l'autre.
    seg_scratch: RefCell<Vec<u8>>,
    /// Le chargement du modèle a échoué : ne pas réessayer à chaque frame.
    seg_failed: RefCell<bool>,
}

/// Descripteur de texture — les six cibles ne diffèrent que par format, taille et
/// storage, donc autant ne l'écrire qu'une fois.
fn make_texture(
    device: &metal::Device,
    format: metal::MTLPixelFormat,
    w: u32,
    h: u32,
    storage: metal::MTLStorageMode,
    usage: metal::MTLTextureUsage,
) -> metal::Texture {
    let desc = metal::TextureDescriptor::new();
    desc.set_texture_type(metal::MTLTextureType::D2);
    desc.set_pixel_format(format);
    desc.set_width(w as u64);
    desc.set_height(h as u64);
    desc.set_storage_mode(storage);
    desc.set_usage(usage);
    device.new_texture(&desc)
}

/// Comment un draw se mélange à ce qui est déjà dans la cible.
#[derive(Clone, Copy, PartialEq)]
enum Blend {
    /// Opaque : la conversion NV12 et le composite fullscreen écrasent.
    Replace,
    /// « over » alpha prémultiplié — la passe de composition normale.
    Over,
    /// Additif pondéré par la couleur de blend : chaque échantillon de traînée entre pour
    /// `1/taps`. C'est `OMSetBlendState(blend_add, [w,w,w,w])` côté D3D11.
    Add,
}

/// Un pipeline state à une seule pièce jointe couleur.
fn make_pipeline(
    device: &metal::Device,
    library: &metal::Library,
    vs: &str,
    fs: &str,
    format: metal::MTLPixelFormat,
    blend: Blend,
) -> Result<metal::RenderPipelineState> {
    let vs_fn = library
        .get_function(vs, None)
        .map_err(|e| anyhow!("MTLLibrary::get_function('{vs}') : {e}"))?;
    let fs_fn = library
        .get_function(fs, None)
        .map_err(|e| anyhow!("MTLLibrary::get_function('{fs}') : {e}"))?;

    let desc = metal::RenderPipelineDescriptor::new();
    desc.set_vertex_function(Some(&vs_fn));
    desc.set_fragment_function(Some(&fs_fn));
    // metal-rs n'expose pas de constructeur pour
    // `RenderPipelineColorAttachmentDescriptor` : la pièce jointe 0 se configure sur
    // le tableau que le descripteur possède déjà.
    let ca = desc
        .color_attachments()
        .object_at(0)
        .ok_or_else(|| anyhow!("RenderPipelineDescriptor::color_attachments(0) est nul"))?;
    ca.set_pixel_format(format);
    if blend != Blend::Replace {
        ca.set_blending_enabled(true);
        ca.set_rgb_blend_operation(metal::MTLBlendOperation::Add);
        ca.set_alpha_blend_operation(metal::MTLBlendOperation::Add);
        let (src, dst) = match blend {
            Blend::Over => (metal::MTLBlendFactor::One, metal::MTLBlendFactor::OneMinusSourceAlpha),
            Blend::Add => (metal::MTLBlendFactor::BlendColor, metal::MTLBlendFactor::One),
            Blend::Replace => unreachable!(),
        };
        ca.set_source_rgb_blend_factor(src);
        ca.set_destination_rgb_blend_factor(dst);
        ca.set_source_alpha_blend_factor(src);
        ca.set_destination_alpha_blend_factor(dst);
    }
    device
        .new_render_pipeline_state(&desc)
        .map_err(|e| anyhow!("new_render_pipeline_state({vs}+{fs}) : {e}"))
}

impl Compositor {
    /// Crée le moteur sur le GPU donné. Équivalent Metal de
    /// `compositor_windows::Compositor::new`.
    pub fn new(gpu: &Gpu) -> Result<Compositor> {
        Self::new_sized(gpu, OUT_W, OUT_H)
    }

    /// Comme `new`, mais avec une taille de rendu explicite. Câble le moteur Metal :
    ///   - `CVMetalTextureCache` (zero-copy CVPixelBuffer → MTLTexture),
    ///   - render targets (RT RGBA, RT NV12 Y/UV, miroirs `Shared`),
    ///   - compilation MSL (`shaders.metal` → `MTLLibrary`),
    ///   - pipeline states (principal + passes fullscreen).
    pub fn new_sized(gpu: &Gpu, w: u32, h: u32) -> Result<Compositor> {
        let (rw, rh) = Self::normalize_render_size(w, h);
        let cache = CVMetalTextureCache::new(gpu.device.as_ptr() as *const std::ffi::c_void)?;

        let device = &gpu.device;
        let rt_usage = metal::MTLTextureUsage::RenderTarget | metal::MTLTextureUsage::ShaderRead;

        let rt = make_texture(
            device,
            metal::MTLPixelFormat::RGBA8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Private,
            rt_usage,
        );
        let rt_read = make_texture(
            device,
            metal::MTLPixelFormat::RGBA8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );
        let nv12_y = make_texture(
            device,
            metal::MTLPixelFormat::R8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Private,
            rt_usage,
        );
        // NV12 : le plan chroma est entrelacé ET demi-résolution dans les deux axes.
        // Le dimensionner comme le plan luma — ce que faisait la première version —
        // produisait un UV 4x trop grand, donc un `read_nv12_scaled` qui lit au-delà
        // de ce que la passe a écrit.
        let nv12_uv = make_texture(
            device,
            metal::MTLPixelFormat::RG8Unorm,
            rw / 2,
            rh / 2,
            metal::MTLStorageMode::Private,
            rt_usage,
        );
        let nv12_read_y = make_texture(
            device,
            metal::MTLPixelFormat::R8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );
        let nv12_read_uv = make_texture(
            device,
            metal::MTLPixelFormat::RG8Unorm,
            rw / 2,
            rh / 2,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );

        // --- Compilation MSL ---
        let msl_source = include_str!("shaders.metal");
        let library = device
            .new_library_with_source(msl_source, &metal::CompileOptions::new())
            .map_err(|e| anyhow!("MTLDevice::new_library_with_source a échoué : {e}"))?;

        let pipeline_main = make_pipeline(
            device,
            &library,
            "vs_main",
            "ps_main",
            metal::MTLPixelFormat::RGBA8Unorm,
            Blend::Over,
        )?;
        let pipeline_fs_y = make_pipeline(
            device,
            &library,
            "vs_fs",
            "ps_y",
            metal::MTLPixelFormat::R8Unorm,
            Blend::Replace,
        )?;
        let pipeline_fs_uv = make_pipeline(
            device,
            &library,
            "vs_fs",
            "ps_uv",
            metal::MTLPixelFormat::RG8Unorm,
            Blend::Replace,
        )?;
        let pipeline_fs_tex = make_pipeline(
            device,
            &library,
            "vs_fs",
            "ps_tex",
            metal::MTLPixelFormat::RGBA8Unorm,
            Blend::Over,
        )?;
        let pipeline_add = make_pipeline(
            device,
            &library,
            "vs_main",
            "ps_main",
            metal::MTLPixelFormat::RGBA8Unorm,
            Blend::Add,
        )?;
        let accum = make_texture(
            device,
            metal::MTLPixelFormat::RGBA8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Private,
            rt_usage,
        );
        let mut pyramid = [2u32, 4, 8].map(|d| {
            make_texture(
                device,
                metal::MTLPixelFormat::RGBA8Unorm,
                (rw / d).max(1),
                (rh / d).max(1),
                metal::MTLStorageMode::Private,
                rt_usage,
            )
        });
        let blur_eighth = pyramid[2].clone();
        let blur_quarter = pyramid[1].clone();
        let blur_half = std::mem::replace(&mut pyramid[0], blur_quarter.clone());
        let pipeline_kdown = make_pipeline(
            device, &library, "vs_fs", "ps_kawase_down",
            metal::MTLPixelFormat::RGBA8Unorm, Blend::Replace,
        )?;
        let pipeline_kup = make_pipeline(
            device, &library, "vs_fs", "ps_kawase_up",
            metal::MTLPixelFormat::RGBA8Unorm, Blend::Replace,
        )?;
        let ann_copy = {
            let d = metal::TextureDescriptor::new();
            d.set_texture_type(metal::MTLTextureType::D2);
            d.set_pixel_format(metal::MTLPixelFormat::RGBA8Unorm);
            d.set_width(rw as u64);
            d.set_height(rh as u64);
            d.set_storage_mode(metal::MTLStorageMode::Private);
            d.set_usage(rt_usage);
            // Assez de niveaux pour que `log2(rayon)` du mode 10 en trouve toujours un.
            d.set_mipmap_level_count(
                (32 - rw.max(rh).max(1).leading_zeros()).max(1) as u64,
            );
            device.new_texture(&d)
        };

        Ok(Compositor {
            gpu: Gpu {
                device: gpu.device.clone(),
                context: gpu.context.clone(),
                backend: gpu.backend,
                feature_level: gpu.feature_level,
            },
            render_w: rw,
            render_h: rh,
            scene: RefCell::new(None),
            cursor: RefCell::new(None),
            cursor_time: RefCell::new(None),
            timeline_time: RefCell::new(None),
            programme_time: RefCell::new(None),
            live_params: RefCell::new(LiveParams::default()),
            metal_texture_cache: cache,
            last_cmd: RefCell::new(None),
            img_cache: RefCell::new(std::collections::HashMap::new()),
            img_tick: std::cell::Cell::new(0),
            img_frame_start: std::cell::Cell::new(0),
            sdf_cache: RefCell::new(std::collections::HashMap::new()),
            rt,
            rt_read,
            nv12_y,
            nv12_uv,
            nv12_read_y,
            nv12_read_uv,
            _library: library,
            pipeline_main,
            pipeline_fs_y,
            pipeline_fs_uv,
            pipeline_fs_tex,
            pipeline_add,
            accum,
            blur_half,
            blur_quarter,
            blur_eighth,
            pipeline_kdown,
            pipeline_kup,
            ann_copy,
            dof_pyramid: RefCell::new(None),
            ann_img_cache: RefCell::new(std::collections::HashMap::new()),
            text_cache: RefCell::new(std::collections::HashMap::new()),
            text_raster: crate::text::TextRasterizer::new().ok(),
            webcam_mask: RefCell::new(None),
            seg_capture: RefCell::new(None),
            seg_worker: RefCell::new(None),
            seg_sync: RefCell::new(None),
            seg_deterministic: std::cell::Cell::new(false),
            seg_inbox: std::sync::Arc::new(std::sync::Mutex::new(None)),
            seg_rate: RefCell::new(crate::segmentation::RateLimiter::new(SEGMENTATION_HZ)),
            seg_scratch: RefCell::new(Vec::new()),
            seg_failed: RefCell::new(false),
        })
    }

    /// Arrondit `(w, h)` au multiple de 2 supérieur — nécessaire pour NV12 4:2:0.
    pub fn normalize_render_size(w: u32, h: u32) -> (u32, u32) {
        ((w.max(1) + 1) & !1, (h.max(1) + 1) & !1)
    }

    pub fn render_size(&self) -> (u32, u32) {
        (self.render_w, self.render_h)
    }

    pub fn set_live_params(&self, p: LiveParams) {
        *self.live_params.borrow_mut() = p;
    }

    /// Cf. `compositor_windows::set_has_webcam` — le seul champ de `LiveParams` qui dépend du
    /// clip courant, rebranché par `walk_composited_timeline` sans écraser le reste.
    pub fn set_has_webcam(&self, v: bool) {
        self.live_params.borrow_mut().has_webcam = v;
    }

    pub fn set_scene(&self, s: Option<Scene>) {
        *self.scene.borrow_mut() = s;
    }

    pub fn set_cursor(&self, track: crate::cursor::CursorTrack) {
        *self.cursor.borrow_mut() = Some(track);
    }

    pub fn set_cursor_time(&self, t: Option<f32>) {
        *self.cursor_time.borrow_mut() = t;
    }

    pub fn set_timeline_time(&self, t: Option<f32>) {
        *self.timeline_time.borrow_mut() = t;
    }

    pub fn set_programme_time(&self, t: Option<f32>) {
        *self.programme_time.borrow_mut() = t;
    }

    /// Dernier temps programme reçu : pour que les tests vérifient ce qui atteint vraiment
    /// `FrameGeometryInput`, pas seulement ce que l'appelant croit envoyer.
    #[doc(hidden)]
    pub fn programme_time(&self) -> Option<f32> {
        *self.programme_time.borrow()
    }

    pub fn clear_cursor(&self) {
        *self.cursor.borrow_mut() = None;
    }

    pub fn scene_snapshot(&self) -> Option<Scene> {
        self.scene.borrow().clone()
    }

    /// Le `CVPixelBufferRef` porté par une frame, quel que soit le chemin de décodage :
    ///   - `AV_PIX_FMT_VIDEOTOOLBOX` : frame brute VideoToolbox, `data[3]` (convention ffmpeg) ;
    ///   - `AV_PIX_FMT_D3D11` : sentinel posé par `mac_frames::CpuFrames::present`, `data[0]`.
    ///
    /// Les deux aboutissent au même buffer IOSurface-backed ; `CVMetalTextureCache` n'a
    /// pas de préférence.
    unsafe fn pixel_buffer_of(frame: *const AVFrame) -> Option<*mut std::ffi::c_void> {
        if frame.is_null() {
            return None;
        }
        let pb = match (*frame).format {
            f if f == crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32 => {
                (*frame).data[3] as *mut std::ffi::c_void
            }
            f if f == crate::ffi::AVPixelFormat::AV_PIX_FMT_D3D11 as i32 => {
                (*frame).data[0] as *mut std::ffi::c_void
            }
            _ => return None,
        };
        if pb.is_null() {
            None
        } else {
            Some(pb)
        }
    }

    /// Dimensions réelles (texture, alignée pair) du `CVPixelBufferRef` posé dans la
    /// frame. API symétrique de `compositor_windows::tex_dims`.
    pub unsafe fn tex_dims(&self, frame: *const AVFrame) -> (u32, u32) {
        match Self::pixel_buffer_of(frame) {
            Some(pb) => (
                CVPixelBufferGetWidth(pb) as u32,
                CVPixelBufferGetHeight(pb) as u32,
            ),
            None => (0, 0),
        }
    }

    /// Crée les `MTLTexture` Y (`R8Unorm`) et UV (`RG8Unorm`) de la frame. Zéro copie :
    /// les textures Metal partagent l'IOSurface du `CVPixelBuffer`. API symétrique de
    /// `compositor_windows::nv12_srvs`.
    pub unsafe fn nv12_srvs(
        &self,
        frame: *const AVFrame,
    ) -> Result<(metal::Texture, metal::Texture)> {
        let pb = Self::pixel_buffer_of(frame).ok_or_else(|| {
            anyhow!(
                "nv12_srvs: pas de CVPixelBufferRef (format={}, ni sentinel D3D11 ni VIDEOTOOLBOX)",
                if frame.is_null() { -1 } else { (*frame).format }
            )
        })?;
        let cache = &self.metal_texture_cache;
        let y = cache.make_texture_from_pixel_buffer(pb, 0, metal::MTLPixelFormat::R8Unorm)?;
        let uv = cache.make_texture_from_pixel_buffer(pb, 1, metal::MTLPixelFormat::RG8Unorm)?;
        Ok((y, uv))
    }

    /// Vide le `CVMetalTextureCache` — API symétrique de
    /// `compositor_windows::Compositor::clear_srv_cache`, même contrat côté appelant
    /// (`live.rs` l'appelle sans savoir sur quelle plateforme il tourne) : à invoquer
    /// quand un jeu de décodeurs vient d'être fermé, pour ne pas garder de textures
    /// pointant sur un IOSurface déjà libéré.
    ///
    /// Pas de `HashMap` keyée par adresse à vider ici (contrairement à Windows) — voir
    /// la doc de `CVMetalTextureCache` : CoreVideo est déjà ce cache et le réutilise par
    /// IOSurface, pas par pointeur Rust. `flush()` est donc la vidange elle-même.
    pub fn clear_srv_cache(&self) {
        self.metal_texture_cache.flush();
    }

    /// Les verbes de dessin, côté Metal. Mêmes noms et mêmes paramètres que leurs
    /// homologues de `compositor_windows.rs` — c'est ce qui rend les deux moitiés
    /// « dessin » comparables ligne à ligne.
    ///
    /// `ps_main` lit `LayerCB` au fragment ET `vs_main` le lit au vertex (il en tire le
    /// quad), donc les deux étages sont liés à chaque draw.
    unsafe fn draw_layer(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        cb: &LayerCB,
        tex: Option<(&metal::Texture, &metal::Texture)>,
    ) {
        let bytes = std::mem::size_of::<LayerCB>() as u64;
        let ptr = cb as *const LayerCB as *const std::ffi::c_void;
        enc.set_vertex_bytes(0, bytes, ptr);
        enc.set_fragment_bytes(0, bytes, ptr);
        if let Some((y, uv)) = tex {
            enc.set_fragment_texture(0, Some(y));
            enc.set_fragment_texture(1, Some(uv));
        }
        enc.draw_primitives(metal::MTLPrimitiveType::TriangleStrip, 0, 4);
    }

    /// Quad de couleur pleine / gradient / ombre — tout ce qui n'échantillonne pas la vidéo.
    unsafe fn draw_solid(&self, enc: &metal::RenderCommandEncoderRef, cb: &LayerCB) {
        self.draw_layer(enc, cb, None);
    }

    /// Quad vidéo NV12 (mode 0) : les deux plans de la frame décodée.
    unsafe fn draw_video(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        cb: &LayerCB,
        y: &metal::Texture,
        uv: &metal::Texture,
    ) {
        self.draw_layer(enc, cb, Some((y, uv)));
    }

    /// Ombre portée (mode 2) — port mot pour mot de `compositor_windows::draw_shadow` :
    /// le quad est élargi de `spread` de chaque côté et décalé de `offset_px`, et le
    /// shader dérive la pénombre de la SDF du rect arrondi inscrit.
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_shadow(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        dst: [f32; 4],
        size_px: [f32; 2],
        radius: f32,
        spread: f32,
        offset_px: [f32; 2],
        opacity: f32,
    ) {
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let (sx, sy) = (spread / rw, spread / rh);
        let (ox, oy) = (offset_px[0] / rw, offset_px[1] / rh);
        let cb = LayerCB {
            dst: [dst[0] - sx + ox, dst[1] - sy + oy, dst[2] + 2.0 * sx, dst[3] + 2.0 * sy],
            quad_px: [size_px[0] + 2.0 * spread, size_px[1] + 2.0 * spread],
            radius_px: radius,
            mode: 2.0,
            color: [0.0, 0.0, 0.0, opacity],
            fx: [spread, 0.0, 0.0, 0.0],
            mb: [0.0, 1.0, 1.0, 0.0],
            ..Default::default()
        };
        self.draw_solid(enc, &cb);
    }


    /// Décode un fichier image (jpg/png) — ou une data-URI — en `MTLTexture` RGBA8.
    ///
    /// Miroir de `compositor_windows::load_image_srv`. Les annotations image stockent une
    /// data URL plutôt qu'un chemin (cf. `types.ts`), d'où les deux entrées.
    fn load_image_texture(&self, path: &str) -> Result<(metal::Texture, u32, u32)> {
        let img = if let Some(bytes) = crate::frame_geometry::decode_data_uri(path) {
            image::load_from_memory(&bytes)
                .map_err(|e| anyhow!("data URI image ({} octets) : {e}", bytes.len()))?
                .to_rgba8()
        } else {
            image::open(path)
                .map_err(|e| anyhow!("wallpaper {path} : {e}"))?
                .to_rgba8()
        };
        let (w, h) = (img.width(), img.height());
        let pixels = img.into_raw();
        let tex = make_texture(
            &self.gpu.device,
            metal::MTLPixelFormat::RGBA8Unorm,
            w,
            h,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );
        tex.replace_region(
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize { width: w as u64, height: h as u64, depth: 1 },
            },
            0,
            pixels.as_ptr() as *const std::ffi::c_void,
            (w * 4) as u64,
        );
        Ok((tex, w, h))
    }

    /// Champ de distance du sprite `path` (texture(4) du mode 15) et sa forme, calculés au
    /// premier appel. Parité `compositor_windows::cursor_sdf`. R16Float : filtrable sur tous
    /// les GPU Apple, contrairement au R32Float.
    fn cursor_sdf(
        &self,
        path: &str,
    ) -> Result<(metal::Texture, crate::frame_geometry::SpriteShape)> {
        if let Some(hit) = self.sdf_cache.borrow().get(path) {
            return Ok(hit.clone());
        }
        let sdf = crate::cursor_sdf::CursorSdf::load(path)?;
        let texels = sdf.f16_bytes();
        let tex = make_texture(
            &self.gpu.device,
            metal::MTLPixelFormat::R16Float,
            sdf.width,
            sdf.height,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );
        tex.replace_region(
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize { width: sdf.width as u64, height: sdf.height as u64, depth: 1 },
            },
            0,
            texels.as_ptr() as *const std::ffi::c_void,
            (sdf.width * 2) as u64,
        );
        let entry = (tex, sdf.shape);
        self.sdf_cache.borrow_mut().insert(path.to_string(), entry.clone());
        Ok(entry)
    }

    /// Ouvre une frame du point de vue de `img_cache` : tout ce qui sera touché après cet appel
    /// est le jeu actif, et devient inévinçable jusqu'à la frame suivante.
    fn begin_image_frame(&self) {
        // `+ 1` : la première entrée de cette frame recevra `img_tick + 1`, et la protection
        // porte sur `tick >= img_frame_start`. Sans le décalage on protégerait aussi la
        // DERNIÈRE entrée de la frame précédente, qui n'appartient plus au jeu actif — le
        // résident pourrait alors dépasser le budget d'une texture entière.
        self.img_frame_start.set(self.img_tick.get() + 1);
    }

    /// Texture d'un fichier image, décodée une seule fois puis réutilisée.
    ///
    /// Le cache était NON BORNÉ, et c'est un vrai coût : les wallpapers livrés pèsent 23,7 Mo sur
    /// disque mais 1 774 Mo une fois décodés en RGBA8 — `wallpaper8.jpg` fait 7680x7680, soit
    /// 225 Mo à lui seul. Parcourir le sélecteur les chargeait tous et n'en libérait aucun.
    ///
    /// L'éviction est LRU sous un budget en octets, et ne touche jamais une texture que la frame
    /// EN COURS a déjà servie : sans ça, un fond d'écran et un fond de caméra un peu gros se
    /// chasseraient l'un l'autre à chaque frame, et un décodage coûte 129 ms contre les ~3,5 ms
    /// d'une frame. Si le jeu actif dépasse à lui seul le budget, on dépasse le budget.
    fn cached_image(&self, path: &str) -> Result<(metal::Texture, u32, u32)> {
        let tick = self.img_tick.get() + 1;
        self.img_tick.set(tick);
        // Emprunt isolé dans un `let` pour qu'il soit relâché AVANT le `borrow_mut` —
        // même piège que côté Windows (double emprunt RefCell à la première frame image).
        let hit = self.img_cache.borrow().get(path).cloned();
        if let Some((tex, w, h, _)) = hit {
            self.img_cache.borrow_mut().insert(path.to_string(), (tex.clone(), w, h, tick));
            return Ok((tex, w, h));
        }
        let (tex, w, h) = self.load_image_texture(path)?;
        let mut cache = self.img_cache.borrow_mut();
        cache.insert(path.to_string(), (tex.clone(), w, h, tick));
        // La politique vit dans `frame_geometry` : les trois backends la partagent, comme la
        // géométrie, plutôt que d'entretenir trois copies qui finiraient par diverger.
        let entries: Vec<(String, u64, u64)> = cache
            .iter()
            .map(|(k, e)| (k.clone(), e.1 as u64 * e.2 as u64 * 4, e.3))
            .collect();
        let protect_from = self.img_frame_start.get();
        for key in
            crate::frame_geometry::lru_evictions(&entries, IMG_CACHE_BUDGET_BYTES, protect_from)
        {
            cache.remove(&key);
        }
        Ok((tex, w, h))
    }

    /// Fond wallpaper image, cover-fit sur le ratio de SORTIE (mode 6).
    ///
    /// Le crop de recouvrement se calcule contre le vrai ratio de sortie, pas contre celui
    /// de la texture : sinon l'image, déjà cover-fittée, se fait re-déformer.
    unsafe fn draw_image_bg(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        path: &str,
        output_aspect: f32,
    ) -> Result<()> {
        self.draw_image_in(enc, path, [0.0, 0.0, 1.0, 1.0], [0.0, 0.0], 0.0, output_aspect)
    }

    /// `draw_image_bg` pour un rect quelconque — la bulle webcam s'en sert avec ses coins
    /// arrondis. `output_aspect` est le ratio du RECT visé, pas celui de la sortie : le crop
    /// « cover » se calcule contre la zone qu'on remplit.
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_image_in(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        path: &str,
        dst: [f32; 4],
        quad_px: [f32; 2],
        radius_px: f32,
        output_aspect: f32,
    ) -> Result<()> {
        let (tex, iw, ih) = self.cached_image(path)?;
        let ai = iw as f32 / ih.max(1) as f32;
        let ao = output_aspect;
        let (u0, v0, u1, v1) = if ai > ao {
            let vis = ao / ai; // rogne horizontalement
            ((1.0 - vis) * 0.5, 0.0, 1.0 - (1.0 - vis) * 0.5, 1.0)
        } else {
            let vis = ai / ao; // rogne verticalement
            (0.0, (1.0 - vis) * 0.5, 1.0, 1.0 - (1.0 - vis) * 0.5)
        };
        enc.set_fragment_texture(2, Some(&tex));
        self.draw_solid(
            enc,
            &LayerCB {
                dst,
                src: [u0, v0, u1, v1],
                quad_px,
                radius_px,
                mode: 6.0,
                ..Default::default()
            },
        );
        Ok(())
    }

    /// Peint le fond du mode « personnalisé » DANS la bulle webcam, avant que la caméra n'y soit
    /// découpée par-dessus.
    ///
    /// Le shader ne sait peindre qu'une couleur plate sous le masque, donc un dégradé ou une
    /// image y tombaient sur du noir — et le défaut EST une image (`DEFAULT_WALLPAPER`), si bien
    /// que le mode ne rendait jamais ce que le sélecteur montrait. Peindre le fond puis composer
    /// la caméra en détourage donne exactement le même résultat (`lerp(fond, caméra, personne)`,
    /// ici par le mélange alpha) pour les trois sortes de fond, en réutilisant les chemins déjà
    /// éprouvés du fond d'écran, et sans rien ajouter aux trois shaders.
    ///
    /// `quad_px` / `radius_px` sont ceux de la bulle : le fond doit épouser ses coins arrondis,
    /// sinon un rectangle déborde derrière la caméra.
    unsafe fn draw_webcam_bg(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        bg: Option<&SceneBackground>,
        dst: [f32; 4],
        quad_px: [f32; 2],
        radius_px: f32,
    ) {
        const BLACK: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
        let solid = |color: [f32; 4]| LayerCB {
            dst,
            quad_px,
            radius_px,
            mode: 1.0,
            color,
            ..Default::default()
        };
        match bg {
            Some(SceneBackground::Color { color }) => {
                self.draw_solid(enc, &solid(parse_hex(color).unwrap_or(BLACK)));
            }
            // Le mouvement ne vaut que pour le fond d'écran : la bulle garde son dégradé immobile.
            Some(SceneBackground::Gradient { angle_deg, stops, .. }) => {
                let c0 = stops.first().and_then(|s| parse_hex(s)).unwrap_or(BLACK);
                let c1 = stops.last().and_then(|s| parse_hex(s)).unwrap_or(c0);
                // angle CSS → direction unitaire, même convention que le fond d'écran.
                let a = angle_deg.to_radians();
                self.draw_solid(
                    enc,
                    &LayerCB {
                        dst,
                        src: [c1[0], c1[1], c1[2], c1[3]],
                        quad_px,
                        radius_px,
                        mode: 5.0,
                        color: c0,
                        fx: [a.sin(), -a.cos(), 0.0, 0.0],
                        ..Default::default()
                    },
                );
            }
            Some(SceneBackground::Image { path }) => {
                // Même contrat que le fond d'écran : un chemin cassé est loggé puis remplacé par
                // du noir. Un fallback silencieux redonnerait le bug qu'on corrige.
                let aspect = if quad_px[1] > 0.0 { quad_px[0] / quad_px[1] } else { 1.0 };
                if let Err(e) = self.draw_image_in(enc, path, dst, quad_px, radius_px, aspect) {
                    eprintln!("[compositor] fond webcam \"{path}\" : {e:#}");
                    self.draw_solid(enc, &solid(BLACK));
                }
            }
            // Personnalisé sans fond : noir, comme avant — mais c'est désormais le seul chemin
            // qui y mène, au lieu de l'être pour toute image et tout dégradé.
            None => self.draw_solid(enc, &solid(BLACK)),
        }
    }

    /// Une passe plein écran : `source` -> `target` avec `pipeline`, `fx` dans le LayerCB.
    /// Le viewport découle de la taille de l'attachement, donc pas de `RSSetViewports`.
    unsafe fn fs_pass(
        &self,
        cmd: &metal::CommandBufferRef,
        target: &metal::Texture,
        source: &metal::Texture,
        pipeline: &metal::RenderPipelineState,
        fx: [f32; 4],
    ) -> Result<()> {
        let e = self.begin_pass(
            cmd,
            target,
            Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 0.0)),
            pipeline,
        )?;
        let cb = LayerCB { fx, ..Default::default() };
        e.set_fragment_bytes(
            0,
            std::mem::size_of::<LayerCB>() as u64,
            &cb as *const LayerCB as *const std::ffi::c_void,
        );
        e.set_fragment_texture(0, Some(source));
        e.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
        e.end_encoding();
        Ok(())
    }

    /// Dual-Kawase sur le contenu courant du RT : trois passes DOWN puis trois UP, la
    /// dernière réécrivant le RT. Port des six `fs_pass` de `compositor_windows::blur_bg`,
    /// mêmes tailles et mêmes texels.
    unsafe fn blur_bg(&self, cmd: &metal::CommandBufferRef) -> Result<()> {
        let off = 2.2; // spread par passe
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let (hw, hh) = (rw * 0.5, rh * 0.5);
        // DOWN : texel = 1/(dims de la SOURCE échantillonnée)
        self.fs_pass(cmd, &self.blur_half, &self.rt, &self.pipeline_kdown, [1.0 / rw, 1.0 / rh, off, 0.0])?;
        self.fs_pass(cmd, &self.blur_quarter, &self.blur_half, &self.pipeline_kdown, [1.0 / hw, 1.0 / hh, off, 0.0])?;
        self.fs_pass(cmd, &self.blur_eighth, &self.blur_quarter, &self.pipeline_kdown, [2.0 / hw, 2.0 / hh, off, 0.0])?;
        // UP
        self.fs_pass(cmd, &self.blur_quarter, &self.blur_eighth, &self.pipeline_kup, [4.0 / hw, 4.0 / hh, off, 0.0])?;
        self.fs_pass(cmd, &self.blur_half, &self.blur_quarter, &self.pipeline_kup, [2.0 / hw, 2.0 / hh, off, 0.0])?;
        self.fs_pass(cmd, &self.rt, &self.blur_half, &self.pipeline_kup, [1.0 / hw, 1.0 / hh, off, 0.0])?;
        Ok(())
    }


    /// Remplit la pyramide de profondeur de champ depuis la frame écran et la rend. Port de
    /// `compositor_windows::fill_dof_pyramid` : UN draw du mode 0 en UV plein vers une cible
    /// demi-résolution vidée d'abord (`color.a = 1`, un seul tap), puis `generate_mipmaps`,
    /// l'appel qui sert déjà `ann_copy`. Le viewport découle de la taille de l'attachement.
    unsafe fn fill_dof_pyramid(
        &self,
        cmd: &metal::CommandBufferRef,
        y: &metal::Texture,
        uv: &metal::Texture,
        tex_w: u32,
        tex_h: u32,
    ) -> Result<metal::Texture> {
        let (w, h) = (tex_w.div_ceil(2).max(1), tex_h.div_ceil(2).max(1));
        let stale = self
            .dof_pyramid
            .borrow()
            .as_ref()
            .is_none_or(|p| (p.width(), p.height()) != (w as u64, h as u64));
        if stale {
            let d = metal::TextureDescriptor::new();
            d.set_texture_type(metal::MTLTextureType::D2);
            d.set_pixel_format(metal::MTLPixelFormat::RGBA8Unorm);
            d.set_width(w as u64);
            d.set_height(h as u64);
            d.set_storage_mode(metal::MTLStorageMode::Private);
            d.set_usage(metal::MTLTextureUsage::RenderTarget | metal::MTLTextureUsage::ShaderRead);
            d.set_mipmap_level_count(crate::frame_geometry::dof_pyramid_levels(w, h) as u64);
            *self.dof_pyramid.borrow_mut() = Some(self.gpu.device.new_texture(&d));
        }
        let pyr = self.dof_pyramid.borrow().clone().expect("pyramide allouée ci-dessus");
        let enc = self.begin_pass(
            cmd,
            &pyr,
            Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 0.0)),
            &self.pipeline_main,
        )?;
        let full = [0.0, 0.0, 1.0, 1.0];
        self.draw_video(
            enc,
            &LayerCB {
                dst: full,
                src: full,
                quad_px: [w as f32, h as f32],
                mode: 0.0,
                color: [1.0, 1.0, 1.0, 1.0],
                src_prev: full,
                dst_prev: full,
                mb: [1.0, 0.0, 1.0, 0.0],
                ..Default::default()
            },
            y,
            uv,
        );
        enc.end_encoding();
        let blit = cmd.new_blit_command_encoder();
        blit.generate_mipmaps(&pyr);
        blit.end_encoding();
        Ok(pyr)
    }

    /// Ombre d'un écran incliné en 3D : la pénombre suit le QUADRILATÈRE projeté (mode 12),
    /// pas son rect englobant. Port de `compositor_windows::draw_quad_shadow`.
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_quad_shadow(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        corners: &[(f32, f32); 4],
        center_px: [f32; 2],
        radius: f32,
        spread: f32,
        offset_px: [f32; 2],
        opacity: f32,
    ) {
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let (min_x, max_x) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
        let (min_y, max_y) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
        // La boîte doit contenir la pénombre entière, sinon elle se coupe net.
        let box_w = (max_x - min_x) + 2.0 * spread;
        let box_h = (max_y - min_y) + 2.0 * spread;
        let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x + spread, y - min_y + spread] };
        let [tl0, tl1] = local(corners[0]);
        let [tr0, tr1] = local(corners[1]);
        let [br0, br1] = local(corners[2]);
        let [bl0, bl1] = local(corners[3]);
        self.draw_solid(
            enc,
            &LayerCB {
                dst: [
                    (center_px[0] + min_x - spread + offset_px[0]) / rw,
                    (center_px[1] + min_y - spread + offset_px[1]) / rh,
                    box_w / rw,
                    box_h / rh,
                ],
                quad_px: [box_w, box_h],
                radius_px: radius,
                mode: 12.0,
                color: [0.0, 0.0, 0.0, opacity],
                fx: [tl0, tl1, tr0, tr1],
                src_prev: [br0, br1, bl0, bl1],
                mb: [0.0, spread, 1.0, 0.0],
                ..Default::default()
            },
        );
    }

    /// Écran incliné (mode 8) : le calque partagé (`frame_geometry::tilted_screen_cb`), avec la
    /// pyramide de profondeur de champ en texture(2).
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_tilted_screen(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        quad: &crate::regions::TiltedQuad,
        s_px: [f32; 2],
        center_px: [f32; 2],
        cut: [f32; 4],
        focus_plane: [f32; 2],
        radius: f32,
        // Sous le chrome de fenêtre : la remontée de son contour intérieur au-dessus de
        // l'écran (`screen_top_lift_px`), qui carre les coins hauts. 0 ailleurs.
        top_lift: f32,
        y: &metal::Texture,
        uv: &metal::Texture,
        dof_pyramid: Option<&metal::Texture>,
    ) {
        let render_px = [self.render_w as f32, self.render_h as f32];
        // texture(2) EXPLICITE : `draw_video` ne lie que 0/1, et le slot 2 garde sinon ce que
        // le draw précédent y a laissé. `None` quand l'effet est coupé : `k = 0`, rien n'y est lu.
        enc.set_fragment_texture(2, dof_pyramid.map(|t| &**t));
        // La pyramide liée décide seule si la profondeur de champ tourne.
        let cb = crate::frame_geometry::tilted_screen_cb(
            quad,
            s_px,
            center_px,
            cut,
            focus_plane,
            radius,
            top_lift,
            dof_pyramid.is_some(),
            render_px,
        );
        self.draw_video(enc, &cb, y, uv);
    }


    /// Annotations : calque le plus haut, ancré sur `s_ann` — le rect écran SANS ZOOM, le
    /// conteneur que reçoit l'overlay web. Port de `compositor_windows::draw_annotations`.
    ///
    /// Le paramètre s'appelle `s_ann` et pas `screen_dst` parce que c'est le seul rect
    /// correct pour le texte, les flèches et les images : lui passer `s_dst` fait dériver et
    /// grossir les sous-titres sous un zoom (issue #179, puis #397 sur Linux). L'arithmétique
    /// elle-même vit dans `frame_geometry::annotation_dst_in`, partagée par les trois backends.
    /// Le flou, lui, se place par `g.privacy_mask` : un masque doit rester sur ce qu'il cache.
    unsafe fn draw_annotations(
        &self,
        cmd: &metal::CommandBufferRef,
        scene: Option<&Scene>,
        t: f32,
        s_ann: [f32; 4],
        g: &crate::frame_geometry::FrameGeometry,
    ) -> Result<()> {
        let Some(scene) = scene else { return Ok(()) };
        if scene.annotations.is_empty() {
            return Ok(());
        }
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let visible = |a: &crate::scene::SceneAnnotation| {
            t >= a.start_sec as f32 && t < a.end_sec as f32
        };
        // UNE seule recopie pour toutes les annotations flou de la frame : leur lecture doit
        // voir l'image composée SANS les flous eux-mêmes, sinon deux zones qui se recouvrent
        // s'échantillonneraient l'une l'autre selon l'ordre de dessin.
        if scene.annotations.iter().any(|a| a.kind == "blur" && visible(a)) {
            let blit = cmd.new_blit_command_encoder();
            blit.copy_from_texture(
                &self.rt, 0, 0,
                metal::MTLOrigin { x: 0, y: 0, z: 0 },
                metal::MTLSize { width: rw as u64, height: rh as u64, depth: 1 },
                &self.ann_copy, 0, 0,
                metal::MTLOrigin { x: 0, y: 0, z: 0 },
            );
            // Seul le mip 0 est rempli ; le GPU dérive le reste.
            blit.generate_mipmaps(&self.ann_copy);
            blit.end_encoding();
        }

        let enc = self.begin_pass(cmd, &self.rt, None, &self.pipeline_main)?;
        // La liste arrive déjà triée par zIndex côté app : l'ordre d'itération EST l'ordre
        // de peinture.
        for a in &scene.annotations {
            if !visible(a) {
                continue;
            }
            // `anchor` et non `s_ann` : un sous-titre (`space: "frame"`) se mesure sur le
            // cadre de sortie. Le dénominateur de la police plus bas lit le MÊME `anchor`.
            let anchor = a.anchor_rect(s_ann);
            let dst = crate::frame_geometry::annotation_dst_in(anchor, a.x, a.y, a.w, a.h);
            let quad_px = [dst[2] * rw, dst[3] * rh];
            if quad_px[0] <= 0.0 || quad_px[1] <= 0.0 {
                continue;
            }
            match a.kind.as_str() {
                "figure" => {
                    let Some(figure) = a.figure.as_ref() else { continue };
                    let (segments, half_stroke) = crate::regions::arrow_local_geometry(
                        &figure.direction,
                        figure.stroke_width,
                        quad_px,
                    );
                    self.draw_solid(enc, &LayerCB {
                        dst,
                        quad_px,
                        mode: 9.0,
                        color: parse_hex(&figure.color).unwrap_or([1.0, 1.0, 1.0, 1.0]),
                        fx: segments[0],
                        src_prev: segments[1],
                        dst_prev: segments[2],
                        mb: [1.0, half_stroke, 0.0, 0.0],
                        ..Default::default()
                    });
                }
                "blur" => {
                    let Some(blur) = a.blur.as_ref() else { continue };
                    let Some(mask) = g.privacy_mask(a, [rw, rh]) else { continue };
                    // Le masque en tracé libre demanderait une liste de points côté GPU : on
                    // masque la BOÎTE ENGLOBANTE. Choix délibérément asymétrique — ne rien
                    // dessiner laisserait passer en clair ce que l'utilisateur a désigné comme
                    // à cacher, et un masque qui ne masque pas donne confiance à tort.
                    let freehand = blur.shape == "freehand";
                    let is_blur = if blur.style == "blur" { 1.0 } else { 0.0 };
                    let amount = if is_blur > 0.5 { blur.intensity } else { blur.block_size };
                    // Le repli passe par le rectangle, pas l'ovale : un ovale inscrit
                    // retirerait les coins, donc une partie de ce qui est couvert.
                    // Masque élargi à la trace du flou de mouvement : l'ovale n'y couvrirait plus tout.
                    let is_oval =
                        if blur.shape == "oval" && !freehand && mask.oval_ok { 1.0 } else { 0.0 };
                    // La teinte n'a de sens qu'en mosaïque : un flou teinté ne ressemble plus
                    // à un flou.
                    let tinted = if is_blur > 0.5 { 0.0 } else { 1.0 };
                    let tint = if blur.color == "black" {
                        [0.0, 0.0, 0.0, 1.0]
                    } else {
                        [1.0, 1.0, 1.0, 1.0]
                    };
                    let (dst_prev, src_prev, mb) = mask.warp_fields();
                    enc.set_fragment_texture(2, Some(&self.ann_copy));
                    self.draw_solid(enc, &LayerCB {
                        dst: mask.dst,
                        quad_px: mask.quad_px,
                        mode: 10.0,
                        color: tint,
                        fx: [is_blur, amount.max(1.0) * mask.strength, is_oval, tinted],
                        src_prev,
                        dst_prev,
                        mb,
                        ..Default::default()
                    });
                }
                "image" => {
                    let Some(src) = a.image_path.as_ref().filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    let cached = {
                        let c = self.ann_img_cache.borrow();
                        c.get(&a.id).filter(|(_, _, _, len)| *len == src.len()).cloned()
                    };
                    let Some((tex, iw, ih, _)) = cached.or_else(|| {
                        match self.load_image_texture(src) {
                            Ok((tex, w, h)) => {
                                let e = (tex, w, h, src.len());
                                self.ann_img_cache.borrow_mut().insert(a.id.clone(), e.clone());
                                Some(e)
                            }
                            Err(e) => {
                                eprintln!("[annotation image] {}: {e:#}", a.id);
                                None
                            }
                        }
                    }) else {
                        continue;
                    };
                    if iw == 0 || ih == 0 {
                        continue;
                    }
                    let box_aspect = quad_px[0] / quad_px[1];
                    let img_aspect = iw as f32 / ih as f32;
                    let (fit_w, fit_h) = if img_aspect > box_aspect {
                        (dst[2], dst[3] * (box_aspect / img_aspect))
                    } else {
                        (dst[2] * (img_aspect / box_aspect), dst[3])
                    };
                    enc.set_fragment_texture(2, Some(&tex));
                    self.draw_solid(enc, &LayerCB {
                        dst: [
                            dst[0] + (dst[2] - fit_w) * 0.5,
                            dst[1] + (dst[3] - fit_h) * 0.5,
                            fit_w,
                            fit_h,
                        ],
                        src: [0.0, 0.0, 1.0, 1.0],
                        quad_px: [fit_w * rw, fit_h * rh],
                        mode: 7.0,
                        color: [1.0, 1.0, 1.0, 1.0],
                        fx: [0.0, 0.0, 1.0, 1.0],
                        ..Default::default()
                    });
                }
                "text" => {
                    let Some(text) = a.text.as_ref() else { continue };
                    let Some(raster) = self.text_raster.as_ref() else { continue };
                    if text.content.trim().is_empty() {
                        continue;
                    }
                    let spec = crate::text::TextSpec {
                        content: text.content.clone(),
                        color: parse_hex(&text.color).unwrap_or([1.0, 1.0, 1.0, 1.0]),
                        background: parse_hex(&text.background_color)
                            .unwrap_or([0.0, 0.0, 0.0, 0.0]),
                        font_size_px: text.font_size_rel * (anchor[3] * rh),
                        font_family: text.font_family.clone(),
                        bold: text.font_weight == "bold",
                        italic: text.font_style == "italic",
                        underline: text.text_decoration == "underline",
                        align: text.text_align.clone(),
                        // Absent = "center", le comportement historique : les
                        // annotations ne changent pas d'un pixel.
                        valign: text.vertical_align.clone().unwrap_or_default(),
                        box_px: [quad_px[0].round() as u32, quad_px[1].round() as u32],
                    };
                    let key = spec.cache_key();
                    let cached = {
                        let c = self.text_cache.borrow();
                        c.get(&a.id).filter(|(_, k)| *k == key).map(|(tex, _)| tex.clone())
                    };
                    let Some(tex) = cached.or_else(|| match raster.rasterize(&self.gpu, &spec) {
                        Ok(tex) => {
                            self.text_cache.borrow_mut().insert(a.id.clone(), (tex.clone(), key));
                            Some(tex)
                        }
                        Err(e) => {
                            eprintln!("[annotation texte] {}: {e:#}", a.id);
                            None
                        }
                    }) else {
                        continue;
                    };
                    let anim = crate::text_anim::text_animation_state(
                        text.animation.as_deref(),
                        (t - a.start_sec as f32) * 1000.0,
                    );
                    let anim_px = rh / crate::text_anim::ANIMATION_REFERENCE_HEIGHT;
                    let (mut ax, mut ay, mut aw, mut ah) = (
                        dst[0] + anim.translate_x * anim_px / rw,
                        dst[1] + anim.translate_y * anim_px / rh,
                        dst[2],
                        dst[3],
                    );
                    if (anim.scale - 1.0).abs() > 1e-4 {
                        let (cx, cy) = (ax + aw * 0.5, ay + ah * 0.5);
                        aw *= anim.scale;
                        ah *= anim.scale;
                        ax = cx - aw * 0.5;
                        ay = cy - ah * 0.5;
                    }
                    let reveal = anim.reveal.clamp(0.0, 1.0);
                    if reveal <= 0.0 {
                        continue;
                    }
                    enc.set_fragment_texture(2, Some(&tex));
                    self.draw_solid(enc, &LayerCB {
                        dst: [ax, ay, aw * reveal, ah],
                        src: [0.0, 0.0, reveal, 1.0],
                        quad_px: [aw * reveal * rw, ah * rh],
                        mode: 11.0,
                        color: [1.0, 1.0, 1.0, anim.opacity],
                        ..Default::default()
                    });
                }
                _ => {}
            }
        }
        enc.end_encoding();
        Ok(())
    }


    /// Extrait la frame webcam en RGB8 à la résolution du modèle, dans `out`.
    ///
    /// Pendant Metal de `compositor_windows::capture_webcam_rgb`, avec les mêmes contraintes
    /// d'appel et une seule divergence de mécanique : là où D3D11 réquisitionne la cible du
    /// contexte persistant, Metal ouvre une passe sur `SegCapture::rt` et la referme, donc
    /// rien n'est « réquisitionné ». La contrainte d'ordre reste malgré tout : cette méthode
    /// **doit tourner avant que le command buffer de composition ne soit créé**, parce
    /// qu'elle attend son propre buffer et qu'attendre au milieu d'une frame sérialiserait
    /// CPU et GPU sur exactement le chemin que cette conception veut garder recouvert.
    ///
    /// `src` est le rect source en UV. L'appelant y passe la frame ENTIÈRE et non le
    /// sous-rect dessiné — cf. `pump_segmentation`.
    ///
    /// # Le readback
    ///
    /// Trois étapes, la forme prescrite par l'en-tête du module et déjà tenue par
    /// `render_nv12` + `read_nv12_scaled` : rendu dans une cible `Private`, blit vers un
    /// miroir `Shared`, `get_bytes`. Pas de `Managed`, donc pas de `synchronizeResource` —
    /// c'est le seul mode de stockage qui l'exigerait, et rien dans ce fichier n'en utilise.
    ///
    /// Le buffer `out` est réutilisé d'un appel à l'autre : il est dimensionné au RGBA lu
    /// puis compacté sur place en RGB, ce qui laisse sa capacité au maximum des deux et ne
    /// réalloue donc plus après la première capture.
    pub unsafe fn capture_webcam_rgb(
        &self,
        wy: &metal::Texture,
        wuv: &metal::Texture,
        src: [f32; 4],
        width: u32,
        height: u32,
        out: &mut Vec<u8>,
    ) -> Result<()> {
        if width == 0 || height == 0 {
            return Err(anyhow!(
                "capture webcam de dimensions nulles ({width}x{height})"
            ));
        }
        {
            let mut slot = self.seg_capture.borrow_mut();
            if !matches!(slot.as_ref(), Some(c) if c.width == width && c.height == height) {
                *slot = Some(SegCapture {
                    rt: make_texture(
                        &self.gpu.device,
                        metal::MTLPixelFormat::RGBA8Unorm,
                        width,
                        height,
                        metal::MTLStorageMode::Private,
                        metal::MTLTextureUsage::RenderTarget | metal::MTLTextureUsage::ShaderRead,
                    ),
                    read: make_texture(
                        &self.gpu.device,
                        metal::MTLPixelFormat::RGBA8Unorm,
                        width,
                        height,
                        metal::MTLStorageMode::Shared,
                        metal::MTLTextureUsage::ShaderRead,
                    ),
                    width,
                    height,
                });
            }
        }
        let slot = self.seg_capture.borrow();
        let cap = slot.as_ref().expect("créé juste au-dessus");

        // Command buffer PROPRE, et surtout PAS `submit`/`sync` : `sync` attend `last_cmd`,
        // et `read_nv12_scaled` compte sur `last_cmd` pour être le buffer de `render_nv12`.
        // Le remplacer ici ferait attendre la capture au lieu de la conversion NV12, et le
        // readback d'encodage lirait des plans que rien n'a encore écrits.
        let cmd_buf = self.gpu.context.new_command_buffer();
        {
            // Plein cadre de la cible, sans coins ni motion blur : le modèle veut l'image,
            // pas la mise en forme. `fx` reste à zéro — la branche de masque du shader ne
            // doit surtout pas se prendre sur la capture qui l'alimente.
            let enc = self.begin_pass(
                cmd_buf,
                &cap.rt,
                Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0)),
                &self.pipeline_main,
            )?;
            self.draw_video(
                enc,
                &LayerCB {
                    dst: [0.0, 0.0, 1.0, 1.0],
                    src,
                    quad_px: [width as f32, height as f32],
                    mode: 0.0,
                    color: [0.0, 0.0, 0.0, 1.0],
                    mb: [1.0, 1.0, 1.0, 0.0],
                    ..Default::default()
                },
                wy,
                wuv,
            );
            enc.end_encoding();
        }
        let blit = cmd_buf.new_blit_command_encoder();
        blit.copy_from_texture(
            &cap.rt,
            0,
            0,
            metal::MTLOrigin { x: 0, y: 0, z: 0 },
            metal::MTLSize { width: width as u64, height: height as u64, depth: 1 },
            &cap.read,
            0,
            0,
            metal::MTLOrigin { x: 0, y: 0, z: 0 },
        );
        blit.end_encoding();
        cmd_buf.commit();
        cmd_buf.wait_until_completed();

        let (w, h) = (width as usize, height as usize);
        out.resize(w * h * 4, 0);
        cap.read.get_bytes(
            out.as_mut_ptr() as *mut std::ffi::c_void,
            (w * 4) as u64,
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize { width: w as u64, height: h as u64, depth: 1 },
            },
            0,
        );
        // RGBA → RGB sur place : le modèle n'a pas de canal alpha en entrée. La destination
        // (`3i`) court derrière la source (`4i`), donc aucune écriture n'écrase un octet pas
        // encore lu.
        for i in 0..w * h {
            let (r, g, b) = (out[i * 4], out[i * 4 + 1], out[i * 4 + 2]);
            out[i * 3] = r;
            out[i * 3 + 1] = g;
            out[i * 3 + 2] = b;
        }
        out.truncate(w * h * 3);
        Ok(())
    }

    /// Publie le masque de segmentation du sujet webcam (R8, `width`x`height`, 0 = fond).
    ///
    /// La texture est `Shared` et réécrite en place par `replace_region` ; elle n'est
    /// recréée que si la résolution du modèle change, ce qui n'arrive pas en régime établi.
    ///
    /// Réécrire une texture que le GPU pourrait encore lire serait une course — ici il ne
    /// le peut pas : les trois chemins de frame macOS drainent la file avant de rendre la
    /// main (`readback_direct` et `rgb_to_nv12` font `submit` + `sync`, `read_nv12_scaled`
    /// fait `sync`), donc plus rien n'est en vol quand `compose_frame` rappelle
    /// `pump_segmentation`. C'est ce qui dispense d'un double buffer, pas la chance.
    pub fn set_webcam_mask(&self, data: &[u8], width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 {
            return Err(anyhow!("masque webcam de dimensions nulles ({width}x{height})"));
        }
        let expected = (width as usize) * (height as usize);
        if data.len() < expected {
            return Err(anyhow!(
                "masque webcam trop court : {} octets pour {width}x{height}",
                data.len()
            ));
        }

        let mut slot = self.webcam_mask.borrow_mut();
        if !matches!(slot.as_ref(), Some(m) if m.width == width && m.height == height) {
            *slot = Some(WebcamMask {
                tex: make_texture(
                    &self.gpu.device,
                    metal::MTLPixelFormat::R8Unorm,
                    width,
                    height,
                    metal::MTLStorageMode::Shared,
                    metal::MTLTextureUsage::ShaderRead,
                ),
                width,
                height,
            });
        }
        let mask = slot.as_ref().expect("alloué juste au-dessus");
        mask.tex.replace_region(
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize { width: width as u64, height: height as u64, depth: 1 },
            },
            0,
            data.as_ptr() as *const std::ffi::c_void,
            width as u64,
        );
        Ok(())
    }

    /// Un tour de segmentation : téléverse le masque prêt, puis soumet une nouvelle frame si
    /// la cadence l'autorise. Port de `compositor_windows::pump_segmentation` — worker,
    /// boîte aux lettres, limiteur de cadence et démarrage paresseux sont indépendants de la
    /// plateforme, seuls les deux appels GPU changent.
    ///
    /// Les deux moitiés sont volontairement désynchronisées. Le masque téléversé ici vient de
    /// la frame précédente — une frame de retard sur une silhouette est invisible, alors
    /// qu'attendre l'inférence bloquerait le rendu, ce qui est exactement le coût que toute
    /// cette conception cherche à ne pas payer.
    unsafe fn pump_segmentation(
        &self,
        wy: &metal::Texture,
        wuv: &metal::Texture,
        valid: [f32; 2],
    ) -> Result<()> {
        if *self.seg_failed.borrow() {
            return Ok(());
        }
        // Rien à faire si aucun effet n'est demandé : ni capture, ni inférence, ni masque.
        // Le coût de la fonctionnalité est alors exactement nul.
        let (wants_effect, model_path) = {
            let scene = self.scene.borrow();
            match scene.as_ref().and_then(|s| s.webcam_effect.as_ref()) {
                Some(e) if e.shader_code() > 0.0 => (true, e.model_path.clone()),
                _ => (false, None),
            }
        };
        if !wants_effect {
            return Ok(());
        }

        // Démarrage paresseux, piloté par la scène : personne n'a à appeler
        // `enable_segmentation` à la main, et un modèle introuvable éteint l'effet au lieu
        // de faire tomber le rendu.
        if self.seg_worker.borrow().is_none() && self.seg_sync.borrow().is_none() {
            let Some(path) = model_path else { return Ok(()) };
            if let Err(e) = self.enable_segmentation(std::path::Path::new(&path)) {
                eprintln!("[segmentation] désactivée : {e}");
                // Une scène qui reste identique retenterait à chaque frame ; on lève le
                // verrou plutôt que de journaliser 60 fois par seconde.
                *self.seg_failed.borrow_mut() = true;
                return Ok(());
            }
            // En preview on rend cette frame sans masque : le worker vient de démarrer et
            // l'effet apparaîtra dans quelques millisecondes, ce que personne ne voit. À
            // l'export cette frame part dans le fichier — on enchaîne donc sur la capture et
            // l'inférence plutôt que de la laisser sortir non détourée.
            if !self.seg_deterministic.get() {
                return Ok(());
            }
        }

        if let Some(mask) = self.seg_inbox.lock().unwrap().take() {
            self.set_webcam_mask(
                &mask,
                crate::segmentation::MODEL_WIDTH,
                crate::segmentation::MODEL_HEIGHT,
            )?;
        }

        // La cadence horloge est le bon réglage en preview et le mauvais à l'export, où les
        // frames défilent aussi vite que la machine décode : le nombre de frames couvertes par
        // un masque dépendrait alors de la charge. En déterministe, une inférence par frame.
        if !self.seg_deterministic.get()
            && !self.seg_rate.borrow_mut().should_run(std::time::Instant::now())
        {
            return Ok(());
        }
        let mut scratch = self.seg_scratch.borrow_mut();
        // La frame ENTIÈRE, pas le sous-rect dessiné : un crop utilisateur serré amputerait
        // le sujet en entrée du modèle, et le masque serait faux là où il compte le plus.
        // Le shader ramène ses coordonnées dans cet espace via `fx.xy`.
        self.capture_webcam_rgb(
            wy,
            wuv,
            [0.0, 0.0, valid[0], valid[1]],
            crate::segmentation::MODEL_WIDTH,
            crate::segmentation::MODEL_HEIGHT,
            &mut scratch,
        )?;
        if self.seg_deterministic.get() {
            // Synchrone : le masque doit exister avant que cette frame ne soit composée, sinon
            // on retombe sur le défaut qu'on corrige. Une inférence ratée laisse le masque
            // précédent, comme le fait le worker.
            let mut sync = self.seg_sync.borrow_mut();
            if let Some(seg) = sync.as_mut() {
                match seg.run(&scratch) {
                    Ok(mask) => {
                        let mask = mask.to_vec();
                        drop(sync);
                        self.set_webcam_mask(
                            &mask,
                            crate::segmentation::MODEL_WIDTH,
                            crate::segmentation::MODEL_HEIGHT,
                        )?;
                    }
                    Err(e) => eprintln!("[segmentation] frame ignorée : {e}"),
                }
            }
        } else if let Some(w) = self.seg_worker.borrow().as_ref() {
            w.submit(&scratch);
        }
        Ok(())
    }

    /// Démarre la segmentation du sujet webcam pour ce compositeur.
    ///
    /// Idempotent. Tant qu'elle n'est pas appelée, `compose_frame` ne fait rien de plus et
    /// la webcam se dessine comme avant — c'est ce qui rend l'effet inerte plutôt que cassé
    /// sur une build sans modèle.
    pub fn enable_segmentation(&self, model_path: &std::path::Path) -> Result<()> {
        if self.seg_worker.borrow().is_some() || self.seg_sync.borrow().is_some() {
            return Ok(());
        }
        let segmenter = crate::segmentation::Segmenter::load(model_path)?;
        // En déterministe, le segmenteur reste ici : l'inférence tourne sur le thread de rendu,
        // donc le masque de la frame N est prêt AVANT qu'elle ne soit composée. Le worker est un
        // choix de preview — ne jamais bloquer l'affichage — et c'est exactement ce qui rend
        // l'export irreproductible, le masque arrivant quelques frames plus tard selon la charge.
        if self.seg_deterministic.get() {
            *self.seg_sync.borrow_mut() = Some(segmenter);
            return Ok(());
        }
        let inbox = std::sync::Arc::clone(&self.seg_inbox);
        let worker = crate::segmentation::SegmentationWorker::spawn(segmenter, move |mask, _, _| {
            // Écrase le masque précédent s'il n'a pas encore été téléversé : c'est le plus
            // récent qui vaut, jamais une file.
            *inbox.lock().unwrap() = Some(mask.to_vec());
        });
        *self.seg_worker.borrow_mut() = Some(worker);
        Ok(())
    }

    /// Bascule la segmentation en mode reproductible, pour l'export.
    ///
    /// En preview, la cadence suit l'horloge (30 Hz réels) et l'inférence tourne sur un worker :
    /// c'est le bon choix, l'affichage ne doit jamais attendre. À l'export les frames sont rendues
    /// aussi vite que la machine décode, sans rapport avec le temps réel — et ces deux choix
    /// deviennent alors des bugs. La cadence horloge fait dépendre le nombre de frames couvertes
    /// par un masque de la vitesse de la machine, et le worker asynchrone rend les premières
    /// frames AVANT que le premier masque n'existe : elles partent dans le fichier avec le vrai
    /// arrière-plan de la webcam. Deux exports du même projet ne donnent donc pas les mêmes
    /// pixels, ce qui casse l'invariant « l'export est identique à la preview ».
    ///
    /// En déterministe : une inférence PAR FRAME, synchrone. Plus coûteux (~3 ms/frame), mais
    /// l'export est hors ligne et chaque frame porte le masque calculé depuis SA propre image.
    ///
    /// À appeler avant la première frame — c'est ce qui décide comment `enable_segmentation`
    /// s'installe.
    pub fn set_segmentation_deterministic(&self, on: bool) {
        if self.seg_deterministic.get() == on {
            return;
        }
        self.seg_deterministic.set(on);
        // Changer de mode change le MOTEUR, et `enable_segmentation` est idempotent sur la
        // PRÉSENCE d'un moteur : sans démonter celui qui ne correspond plus, le drapeau mentirait.
        // Un compositeur qui a déjà servi en preview garderait son worker, `seg_sync` resterait
        // vide, et l'export entier ne ferait AUCUNE inférence. Le démarrage paresseux de
        // `pump_segmentation` réinstalle le bon moteur à la frame suivante.
        *self.seg_worker.borrow_mut() = None;
        *self.seg_sync.borrow_mut() = None;
        // Et le masque que le worker démonté avait peut-être déjà déposé : il vient de l'autre
        // mode, il n'a rien à faire sur la première frame de celui-ci.
        *self.seg_inbox.lock().unwrap() = None;
    }

    /// Éteint l'effet : la webcam se redessine telle quelle à la frame suivante.
    pub fn clear_webcam_mask(&self) {
        *self.webcam_mask.borrow_mut() = None;
    }

    /// Soumet sans attendre, et retient le buffer pour `sync`.
    fn submit(&self, cmd: &metal::CommandBufferRef) {
        cmd.commit();
        *self.last_cmd.borrow_mut() = Some(cmd.to_owned());
    }

    /// Attend la fin de tout ce qui a été soumis. Metal exécute dans l'ordre sur une même
    /// file, donc attendre le DERNIER buffer suffit à garantir les précédents.
    fn sync(&self) {
        if let Some(cmd) = self.last_cmd.borrow().as_ref() {
            cmd.wait_until_completed();
        }
    }

    /// Ouvre un encodeur sur `target`. `clear` = `None` conserve ce qui s'y trouve.
    ///
    /// Metal n'a pas d'`OMSetRenderTargets` : changer de cible veut dire terminer
    /// l'encodeur et en ouvrir un autre. C'est ce qui remplace la choréographie
    /// `OMSetRenderTargets` / `OMSetBlendState` du chemin D3D11.
    fn begin_pass<'a>(
        &self,
        cmd: &'a metal::CommandBufferRef,
        target: &metal::Texture,
        clear: Option<metal::MTLClearColor>,
        pipeline: &metal::RenderPipelineState,
    ) -> Result<&'a metal::RenderCommandEncoderRef> {
        let desc = metal::RenderPassDescriptor::new();
        let ca = desc
            .color_attachments()
            .object_at(0)
            .ok_or_else(|| anyhow!("RenderPassDescriptor::color_attachments(0) est nul"))?;
        ca.set_texture(Some(target));
        match clear {
            Some(c) => {
                ca.set_load_action(metal::MTLLoadAction::Clear);
                ca.set_clear_color(c);
            }
            None => ca.set_load_action(metal::MTLLoadAction::Load),
        }
        ca.set_store_action(metal::MTLStoreAction::Store);
        let enc = cmd.new_render_command_encoder(&desc);
        enc.set_render_pipeline_state(pipeline);
        Ok(enc)
    }

    /// Sprite de curseur (mode 7, ou 13 posé sur le plan). Rend `Err` quand l'art n'est pas
    /// chargeable, pour que l'appelant retombe sur le curseur dessiné. La géométrie vient de
    /// `frame_geometry::cursor_sprite_cb`, partagée avec Windows et Linux.
    ///
    /// Avec `model`, le même sprite extrudé (mode 15, `cursor_model_cb`) : le sprite en
    /// texture(2), son champ de distance en texture(4).
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_cursor_sprite(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        placement: crate::frame_geometry::CursorPlacement,
        size_px: f32,
        a: f32,
        sprite: &crate::scene::SceneCursorSprite,
        clip: [f32; 4],
        model: Option<crate::frame_geometry::CursorPose>,
    ) -> Result<()> {
        let (tex, iw, ih) = self.cached_image(sprite.path.as_str())?;
        // Sans champ de distance, repli sur le sprite plat plutôt qu'aucun curseur. Parité Linux.
        if let Some(pose) = model {
            match self.cursor_sdf(sprite.path.as_str()) {
                Ok((sdf, shape)) => {
                    let shape = crate::frame_geometry::SpriteShape {
                        hotspot: [sprite.hotspot_x, sprite.hotspot_y],
                        ..shape
                    };
                    if let Some(cb) = crate::frame_geometry::cursor_model_cb(
                        placement, size_px, pose, shape, a, clip,
                    ) {
                        enc.set_fragment_texture(2, Some(&tex));
                        enc.set_fragment_texture(4, Some(&sdf));
                        self.draw_solid(enc, &cb);
                    }
                    return Ok(());
                }
                Err(e) => eprintln!("[curseur] champ de \"{}\" : {e:#}", sprite.path),
            }
        }
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let ar = iw as f32 / ih.max(1) as f32;
        let (pw, ph) = if ar >= 1.0 { (size_px, size_px / ar) } else { (size_px * ar, size_px) };
        let cb = crate::frame_geometry::cursor_sprite_cb(
            placement,
            [pw, ph],
            [sprite.hotspot_x, sprite.hotspot_y],
            a,
            clip,
            [rw, rh],
        );
        enc.set_fragment_texture(2, Some(&tex));
        self.draw_solid(enc, &cb);
        Ok(())
    }

    /// Curseur thématisé : le sprite de l'état courant, sinon la flèche, sinon rien.
    ///
    /// Le repli « dot + ring » mathématique (mode 4) du chemin Windows n'est pas porté :
    /// l'app résout toujours un jeu de sprites, et l'art intégré couvre les états qu'un
    /// thème ne fournit pas. S'il n'y a vraiment aucun sprite, ne rien dessiner est plus
    /// honnête qu'un curseur qui ne ressemble à aucun réglage.
    ///
    /// Avec `model`, ce sprite extrudé (mode 15) : même résolution que `plan_cursor`, qui en a
    /// tiré la pose. Parité `compositor_windows.rs`.
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_cur_themed(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        sprites: &std::collections::HashMap<String, crate::scene::SceneCursorSprite>,
        cursor_type: Option<&str>,
        placement: crate::frame_geometry::CursorPlacement,
        size_px: f32,
        a: f32,
        clip: [f32; 4],
        model: Option<crate::frame_geometry::CursorPose>,
    ) {
        let sprite = cursor_type.and_then(|t| sprites.get(t)).or_else(|| sprites.get("arrow"));
        if let Some(sprite) = sprite {
            if let Err(e) = self.draw_cursor_sprite(enc, placement, size_px, a, sprite, clip, model)
            {
                eprintln!("[compositor] sprite curseur \"{}\" : {e:#}", sprite.path);
            }
        }
    }

    /// Compose la frame : fond, ombre écran, écran, ombre caméra, caméra — puis miroir
    /// `Shared` pour la lecture CPU.
    ///
    /// La géométrie vient de `frame_geometry::plan_frame`, la MÊME fonction que le moteur
    /// D3D11 appelle. Ce qui reste ici n'est donc que l'émission des draws ; c'est aussi
    /// pourquoi cette moitié se relit en regard de `compositor_windows.rs`, section par
    /// section.
    ///
    /// Pas encore rendu : le tilt 3D (mode 8), les annotations, le curseur, le flou de
    /// fond, et le wallpaper image — ce dernier faute de chemin de décodage/upload d'image
    /// côté Metal, et il retombe sur la couleur de fond en le disant.
    pub unsafe fn compose_frame(
        &self,
        screen: *const AVFrame,
        webcam: *const AVFrame,
        frame: f32,
        cfg: &Cfg,
    ) -> Result<()> {
        self.begin_image_frame();
        if Self::pixel_buffer_of(screen).is_none() {
            return self.clear_rt();
        }
        let (sy, suv) = self.nv12_srvs(screen)?;
        // La caméra peut manquer (clip sans webcam) : son absence ne doit pas emporter
        // l'écran avec elle.
        let webcam_tex = self.nv12_srvs(webcam).ok();
        let (stw, sth) = self.tex_dims(screen);
        let (wtw, wth) = self.tex_dims(webcam);
        let (scw, sch) = ((*screen).width as f32, (*screen).height as f32);
        let (wcw, wch) = if webcam.is_null() {
            (1.0, 1.0)
        } else {
            ((*webcam).width as f32, (*webcam).height as f32)
        };
        let u_max = scw / (stw.max(1)) as f32;
        let v_max = sch / (sth.max(1)) as f32;
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        // Étendue valide de la texture webcam : les décodeurs allouent des textures alignées,
        // donc la frame n'occupe pas forcément toute la texture. `.max(1)` au dénominateur —
        // `tex_dims` rend (0, 0) sur une webcam absente, là où le chemin Windows divise sans
        // garde parce qu'il a toujours les deux frames.
        let w_valid = [wcw / (wtw.max(1)) as f32, wch / (wth.max(1)) as f32];

        // Segmentation, AVANT d'ouvrir le command buffer de composition : `capture_webcam_rgb`
        // attend son propre buffer, et attendre au milieu de la frame sérialiserait CPU et GPU.
        // Dernier point où `wtw/wth/wcw/wch` sont en portée sans emprunt de `self.scene` —
        // `pump_segmentation` emprunte la scène lui-même.
        if let Some((wy, wuv)) = webcam_tex.as_ref() {
            self.pump_segmentation(wy, wuv, w_valid)?;
        }

        let scene_ref = self.scene.borrow();
        let cursor_ref = self.cursor.borrow();
        let lp = *self.live_params.borrow();
        let g = crate::frame_geometry::plan_frame(&FrameGeometryInput {
            render_px: [rw, rh],
            screen_tex_px: [stw as f32, sth as f32],
            screen_visible_px: [scw, sch],
            webcam_visible_px: [wcw, wch],
            u_max,
            v_max,
            frame,
            cfg,
            live: lp,
            scene: scene_ref.as_ref(),
            cursor: cursor_ref.as_ref(),
            timeline_t_override: *self.timeline_time.borrow(),
            programme_time: *self.programme_time.borrow(),
        });

        let cmd_buf = self.gpu.context.new_command_buffer();
        // Profondeur de champ : pyramide remplie seulement sur une frame inclinée qui la lit,
        // dans ses propres passes, avant celles de la composition.
        let dof_pyramid = if g.depth_of_field_on(self.gpu.backend == crate::d3d::Backend::Cpu) {
            Some(self.fill_dof_pyramid(cmd_buf, &sy, &suv, stw, sth)?)
        } else {
            None
        };
        let enc = self.begin_pass(
            cmd_buf,
            &self.rt,
            Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0)),
            &self.pipeline_main,
        )?;
        // Les deux plans écran restent liés par défaut : les quads de couleur ne les
        // échantillonnent pas, mais Metal veut des slots renseignés pour les draws qui, eux,
        // le font.
        enc.set_fragment_texture(0, Some(&sy));
        enc.set_fragment_texture(1, Some(&suv));

        // --- fond --- (parité `compositor_windows.rs`, section « fond »)
        match scene_ref.as_ref().map(|s| s.background.clone()) {
            Some(SceneBackground::Color { color }) => {
                let c = parse_hex(&color).unwrap_or(lp.bg_color);
                self.draw_solid(
                    enc,
                    &LayerCB { dst: [0.0, 0.0, 1.0, 1.0], mode: 1.0, color: c, ..Default::default() },
                );
            }
            Some(SceneBackground::Gradient { angle_deg, stops, motion }) => {
                let c0 = stops.first().and_then(|s| parse_hex(s)).unwrap_or(lp.bg_color);
                let c1 = stops.last().and_then(|s| parse_hex(s)).unwrap_or(c0);
                let a = angle_deg.to_radians();
                let (anim, mb) =
                    crate::frame_geometry::gradient_motion_slots(motion, g.programme_t, rw / rh);
                self.draw_solid(
                    enc,
                    &LayerCB {
                        dst: [0.0, 0.0, 1.0, 1.0],
                        src: [c1[0], c1[1], c1[2], c1[3]],
                        mode: 5.0,
                        color: c0,
                        fx: [a.sin(), -a.cos(), anim[0], anim[1]],
                        mb,
                        ..Default::default()
                    },
                );
            }
            Some(SceneBackground::Image { path }) => {
                // Repli couleur en cas d'échec, mais LOGGÉ : un fallback silencieux masquerait
                // un chemin cassé.
                if let Err(e) = self.draw_image_bg(enc, &path, rw / rh) {
                    eprintln!("[compositor] wallpaper image \"{path}\" : {e:#}");
                    self.draw_solid(
                        enc,
                        &LayerCB {
                            dst: [0.0, 0.0, 1.0, 1.0],
                            mode: 1.0,
                            color: lp.bg_color,
                            ..Default::default()
                        },
                    );
                }
            }
            None => {
                self.draw_solid(
                    enc,
                    &LayerCB {
                        dst: [0.0, 0.0, 1.0, 1.0],
                        mode: 1.0,
                        color: lp.bg_color,
                        ..Default::default()
                    },
                );
            }
        }

        // « Blur BG » (parité web `blurredBackgroundLayer`) : floute CE wallpaper qu'on vient
        // de dessiner, pas la vidéo. No-op visuel sur une couleur plate, effet réel sur un
        // gradient ou une image. Il lui faut ses propres passes, d'où la coupure ici.
        enc.end_encoding();
        if scene_ref.as_ref().map(|s| s.effects.blur).unwrap_or(false) {
            self.blur_bg(cmd_buf)?;
        }
        let enc = self.begin_pass(cmd_buf, &self.rt, None, &self.pipeline_main)?;
        enc.set_fragment_texture(0, Some(&sy));
        enc.set_fragment_texture(1, Some(&suv));

        // --- écran : ombre puis vidéo ---
        let s_px = [g.s_dst[2] * rw, g.s_dst[3] * rh];
        // Géométrie du tilt calculée UNE fois : l'ombre et l'écran doivent porter exactement
        // le même quadrilatère, sinon l'ombre se décolle dès que l'un des deux change.
        let tilt = g.screen_tilt(s_px);
        let quad_center_px = [
            (g.s_dst[0] + g.s_dst[2] * 0.5) * rw,
            (g.s_dst[1] + g.s_dst[3] * 0.5) * rh,
        ];
        if cfg.shadow {
            let spread = SCREEN_SHADOW_SPREAD_FRAC * g.frame_min_px;
            let offset = g.screen_shadow_offset();
            let opacity = 0.45 * lp.shadow_scale;
            // L'ombre suit la silhouette réellement affichée : rect arrondi quand l'écran est
            // droit, quadrilatère projeté quand il est penché. Un rect droit derrière un écran
            // incliné se lit comme une seconde surface, pas comme son ombre. Avec un cadre de
            // fenêtre, c'est le CADRE qui la porte (`shadow_caster`) ; un appareil porte celle de
            // sa silhouette 3D (mode 17), pas celle d'un quad.
            if let Some(cb) = g.device_shadow_cb([rw, rh], spread, offset, opacity) {
                self.draw_solid(enc, &cb);
            } else {
                match g.shadow_caster([rw, rh]) {
                    ShadowCaster::Upright { dst, size_px, radius } => {
                        self.draw_shadow(enc, dst, size_px, radius, spread, offset, opacity)
                    }
                    ShadowCaster::Tilted { corners, center_px, radius } => self.draw_quad_shadow(
                        enc, &corners, center_px, radius, spread, offset, opacity,
                    ),
                }
            }
        }
        // Le cadre (mode 14) passe SOUS l'écran, qui ne laisse voir que la barre et le filet.
        if let Some(cb) = g.window_frame_cb([rw, rh]) {
            self.draw_solid(enc, &cb);
        }
        let square_top = g.screen_square_top();
        let top_lift = g.screen_top_lift_px([rw, rh]);
        let [su0, sv0, su1, sv1] = g.cut;
        match tilt.as_ref() {
            None => self.draw_video(
                enc,
                &LayerCB {
                    dst: g.s_dst,
                    src: [su0, sv0, su1, sv1],
                    quad_px: s_px,
                    radius_px: g.s_radius,
                    mode: 0.0,
                    color: [0.0, 0.0, 0.0, 1.0],
                    src_prev: [su0, sv0, su1, sv1],
                    dst_prev: g.s_dst_prev,
                    mb: [g.mb_taps, g.mb_amount, top_lift, square_top],
                    ..Default::default()
                },
                &sy,
                &suv,
            ),
            Some(quad) => self.draw_tilted_screen(
                enc,
                quad,
                s_px,
                quad_center_px,
                g.cut,
                g.focus_plane,
                g.s_radius,
                top_lift,
                &sy,
                &suv,
                dof_pyramid.as_ref(),
            ),
        }
        // L'appareil modelé (mode 17) passe APRÈS l'écran, et non sous lui comme le chrome plat :
        // son socle vient DEVANT le plan du métrage et sa lunette mord dessus. Le shader s'arrête
        // au plan du métrage dans l'ouverture, donc il ne recouvre jamais l'image.
        if let Some(cb) = g.device_frame_cb([rw, rh]) {
            self.draw_solid(enc, &cb);
        }

        enc.end_encoding();

        // --- curseur --- (parité `compositor_windows.rs`, section « curseur custom »)
        if let Some(track) = cursor_ref.as_ref() {
            let plan = crate::frame_geometry::plan_cursor(
                &g,
                &crate::frame_geometry::CursorPlanInput {
                    render_px: [rw, rh],
                    u_max,
                    v_max,
                    cfg,
                    live: lp,
                    scene: scene_ref.as_ref(),
                    track,
                    t: self.cursor_time.borrow().unwrap_or(frame / crate::frame_geometry::FPS),
                },
            )
            .map(|p| p.for_backend(self.gpu.backend == crate::d3d::Backend::Cpu));
            if let Some(plan) = plan {
                let sprites = scene_ref
                    .as_ref()
                    .map(|s| s.cursor.cursor_sprites.clone())
                    .unwrap_or_default();
                let kind = plan.cursor_type.as_deref();
                // L'impact des clics (mode 16, sans texture), posé sur l'écran SOUS le curseur.
                if !plan.impacts.is_empty() {
                    let e = self.begin_pass(cmd_buf, &self.rt, None, &self.pipeline_main)?;
                    for cb in &plan.impacts {
                        self.draw_solid(e, cb);
                    }
                    e.end_encoding();
                }
                if plan.taps <= 1 {
                    let e = self.begin_pass(cmd_buf, &self.rt, None, &self.pipeline_main)?;
                    self.draw_cur_themed(
                        e,
                        &sprites,
                        kind,
                        plan.placement,
                        plan.size_px,
                        plan.alpha,
                        plan.clip,
                        plan.model,
                    );
                    e.end_encoding();
                } else {
                    // Flou RÉEL, pas des copies discrètes : les N échantillons s'accumulent dans
                    // un buffer ISOLÉ parti de zéro, puis sont composités « over » sur la scène.
                    // Les additionner directement sur le RT ajouterait du blanc à ce qui est
                    // dessous — sur un fond clair, curseur quasi invisible.
                    let e = self.begin_pass(
                        cmd_buf,
                        &self.accum,
                        Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 0.0)),
                        &self.pipeline_add,
                    )?;
                    for k in 0..plan.taps {
                        let f = k as f32 / (plan.taps - 1) as f32;
                        let w = crate::frame_geometry::cursor_tap_weight(k, plan.taps);
                        e.set_blend_color(w, w, w, w);
                        self.draw_cur_themed(
                            e,
                            &sprites,
                            kind,
                            plan.prev_placement.lerp(plan.placement, f),
                            plan.size_px,
                            plan.alpha,
                            plan.clip,
                            plan.model,
                        );
                    }
                    e.end_encoding();

                    let c = self.begin_pass(cmd_buf, &self.rt, None, &self.pipeline_fs_tex)?;
                    c.set_fragment_texture(0, Some(&self.accum));
                    c.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
                    c.end_encoding();
                }
            }
        }

        // --- caméra : ombre PiP puis vidéo ---
        let enc = self.begin_pass(cmd_buf, &self.rt, None, &self.pipeline_main)?;
        if let (true, Some((wy, wuv))) = (lp.has_webcam, webcam_tex.as_ref()) {
            let [cu0, cv0, cu1, cv1] = crate::frame_geometry::webcam_source_rect(
                [wcw, wch],
                [wtw as f32, wth as f32],
                scene_ref.as_ref().and_then(|scene| scene.layout.webcam_crop),
                g.w_px[0] / g.w_px[1].max(0.0001),
            );
            let (u0, u1) = if lp.webcam_mirror { (cu1, cu0) } else { (cu0, cu1) };
            let webcam_is_block = matches!(
                g.scene_preset.as_deref(),
                Some("dual-frame") | Some("vertical-stack")
            );
            // Effet d'arrière-plan : le mode vient de la scène, le masque par pixel de
            // l'inférence. Les DEUX sont requis — un mode sans masque rendrait la webcam
            // invisible en détourage, donc tant que rien n'a été segmenté on dessine la
            // piste telle quelle. C'est aussi ce qui rend le premier lancement gracieux.
            let mask = self.webcam_mask.borrow();
            let effect = scene_ref
                .as_ref()
                .and_then(|s| s.webcam_effect.as_ref())
                .filter(|_| mask.is_some())
                .map(|e| (e.shader_code(), e))
                .filter(|(code, _)| *code > 0.0);

            // L'ombre appartient à la bulle PiP. En détourage il n'y a plus de bulle — une
            // ombre portée par un rectangle invisible se lit comme un artefact. Le test porte
            // sur le code de la SCÈNE et non sur celui envoyé au shader : le fond personnalisé
            // part lui aussi en détourage ci-dessous, mais sa bulle, elle, est bien peinte et
            // garde donc son ombre.
            let is_cutout = matches!(effect, Some((code, _)) if code == 1.0);
            if cfg.shadow && !webcam_is_block && !is_cutout && g.shape_fade > 0.0 {
                self.draw_shadow(
                    enc,
                    g.w_dst,
                    g.w_px,
                    g.w_radius,
                    WEBCAM_SHADOW_SPREAD_FRAC * g.frame_min_px,
                    [0.0, WEBCAM_SHADOW_OFFSET_FRAC * g.frame_min_px],
                    WEBCAM_SHADOW_OPACITY * g.shape_fade,
                );
            }

            // Fond personnalisé : on PEINT le fond dans la bulle, puis on y découpe la caméra
            // par-dessus — le mélange alpha donne `lerp(fond, caméra, personne)`, soit exactement
            // ce que la branche « mode 3 » du shader calculait, mais pour les TROIS sortes de
            // fond. Le shader ne sait peindre qu'une couleur plate sous le masque ; dégradés et
            // images y tombaient sur du noir, et le défaut EST une image. L'ordre est imposé :
            // ombre, puis fond, puis caméra.
            let (effect_code, blur_intensity) = match effect {
                Some((code, e)) if code > 2.5 => {
                    self.draw_webcam_bg(enc, e.background.as_ref(), g.w_dst, g.w_px, g.w_radius);
                    (1.0, 0.0)
                }
                Some((code, e)) => (code, e.blur_intensity.clamp(0.0, 1.0)),
                None => (0.0, 0.0),
            };

            // Metal tolère l'index 3 non lié tant que `fx.z` reste à 0 : la branche n'est
            // pas prise, la texture n'est pas échantillonnée. Dès qu'il monte, elle doit
            // l'être sur TOUT draw capable de la prendre — ici il n'y en a qu'un. L'état
            // d'un encodeur est rémanent, donc lier avant le draw suffit, et l'ombre puis le
            // fond qui précèdent sont en modes 1/2/5/6, que `ps_main` garde hors de la branche
            // (`mode < 0.5`).
            //
            // Pas de déliaison après coup, contrairement au chemin Windows qui remet le slot
            // t3 à `None` : cet état meurt avec l'encodeur, et les annotations en ouvrent un
            // autre. Il n'y a rien sur quoi fuir.
            if let Some(m) = mask.as_ref() {
                enc.set_fragment_texture(3, Some(&m.tex));
            }
            self.draw_video(
                enc,
                &LayerCB {
                    dst: g.w_dst,
                    src: [u0, cv0, u1, cv1],
                    quad_px: g.w_px,
                    radius_px: g.w_radius,
                    mode: 0.0,
                    // `color.a` porte l'alpha du découpage (`color.a * personne`) ; le RGB n'est
                    // plus lu, le fond ayant déjà été peint sous la caméra.
                    color: [0.0, 0.0, 0.0, 1.0],
                    fx: [w_valid[0], w_valid[1], effect_code, blur_intensity],
                    src_prev: [u0, cv0, u1, cv1],
                    dst_prev: g.w_dst_prev,
                    mb: [g.mb_taps, g.mb_amount, 1.0, 0.0],
                    ..Default::default()
                },
                wy,
                wuv,
            );
        }

        enc.end_encoding();

        // --- annotations : calque le plus haut, ancré sur le rect ÉCRAN SANS ZOOM ---
        // `s_ann`, pas `s_dst` : le zoom vit dans la boîte depuis l'issue #179, donc `s_dst`
        // grandit avec lui et emmenait annotations et sous-titres dans le mouvement. Le flou de
        // confidentialité est l'exception : il suit le contenu, d'où `&g`.
        self.draw_annotations(cmd_buf, scene_ref.as_ref(), g.source_t, g.s_ann, &g)?;

        // Ni miroir RGBA ni attente ici : le miroir ne sert qu'à `readback_direct` (la
        // preview), et l'export ne lit jamais le RGBA — le blit pleine résolution était payé
        // à chaque frame pour rien.
        self.submit(cmd_buf);
        Ok(())
    }

    /// Efface le RT au noir (utilisé quand `screen` est null ou sans buffer).
    unsafe fn clear_rt(&self) -> Result<()> {
        let cmd_buf = self.gpu.context.new_command_buffer();
        let pass_desc = metal::RenderPassDescriptor::new();
        let ca = pass_desc
            .color_attachments()
            .object_at(0)
            .ok_or_else(|| anyhow!("RenderPassDescriptor::color_attachments(0) est nul"))?;
        ca.set_texture(Some(&self.rt));
        ca.set_load_action(metal::MTLLoadAction::Clear);
        ca.set_clear_color(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0));
        ca.set_store_action(metal::MTLStoreAction::Store);
        cmd_buf.new_render_command_encoder(&pass_desc).end_encoding();

        // Ni miroir RGBA ni attente ici : le miroir ne sert qu'à `readback_direct` (la
        // preview), et l'export ne lit jamais le RGBA — le blit pleine résolution était payé
        // à chaque frame pour rien.
        self.submit(cmd_buf);
        Ok(())
    }

    /// Copie `rt` (`Private`) vers `rt_read` (`Shared`) dans le command buffer donné.
    fn mirror_rt(&self, cmd_buf: &metal::CommandBufferRef) {
        let blit = cmd_buf.new_blit_command_encoder();
        blit.copy_from_texture(
            &self.rt,
            0,
            0,
            metal::MTLOrigin { x: 0, y: 0, z: 0 },
            metal::MTLSize {
                width: self.render_w as u64,
                height: self.render_h as u64,
                depth: 1,
            },
            &self.rt_read,
            0,
            0,
            metal::MTLOrigin { x: 0, y: 0, z: 0 },
        );
        blit.end_encoding();
    }

    /// Variante motion-blur de `compose_frame` — symétrique de
    /// `compositor_windows::compose_frame_mb`. Renvoie `Err` tant que le moteur
    /// avancé (couches multiples avec vélocité par quad) n'est pas câblé.
    pub unsafe fn compose_frame_mb(
        &self,
        _screen: *const AVFrame,
        _webcam: *const AVFrame,
        _frame: u32,
        _cfg: &Cfg,
    ) -> Result<()> {
        Err(anyhow!("compositor_macos::compose_frame_mb: non implémenté"))
    }

    /// First-pass engine : la cible est toujours le NV12 interne. L'argument `out_tex`
    /// est conservé pour l'API symétrique avec Windows ; le câblage zero-copy vers un
    /// `CVPixelBuffer` appartenant à l'encodeur viendra avec le commit « encodeur VT ».
    /// Rend le RT composé en NV12 **directement dans le `CVPixelBuffer` de l'encodeur**.
    ///
    /// `out_tex` est un `CVPixelBufferRef` (celui d'une frame `AV_PIX_FMT_VIDEOTOOLBOX`
    /// tirée du pool de l'encodeur) ; nul = cible interne, chemin de lecture CPU.
    ///
    /// C'est le pendant macOS du zero-copy Windows : au lieu de rendre en interne, relire
    /// 1,4 Mo vers le CPU puis laisser VideoToolbox les ré-uploader, on wrappe les deux
    /// plans du buffer de l'encodeur en `MTLTexture` via le même `CVMetalTextureCache` que
    /// le décodage, et on rend dedans. La frame ne quitte jamais le GPU.
    pub unsafe fn rgb_to_nv12(&self, out_tex: *mut std::ffi::c_void, _slice: u32) -> Result<()> {
        if out_tex.is_null() {
            return self.render_nv12();
        }
        let cache = &self.metal_texture_cache;
        let y = cache.make_texture_from_pixel_buffer(out_tex, 0, metal::MTLPixelFormat::R8Unorm)?;
        let uv = cache.make_texture_from_pixel_buffer(out_tex, 1, metal::MTLPixelFormat::RG8Unorm)?;

        {
            let _p = crate::export_probe::scope(crate::export_probe::Stage::Nv12Passes);
            let cmd_buf = self.gpu.context.new_command_buffer();
            for (target, pipeline) in [(&y, &self.pipeline_fs_y), (&uv, &self.pipeline_fs_uv)] {
                let enc = self.begin_pass(
                    cmd_buf,
                    target,
                    Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0)),
                    pipeline,
                )?;
                enc.set_fragment_texture(0, Some(&self.rt));
                enc.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
                enc.end_encoding();
            }
            self.submit(cmd_buf);
        }
        // Pas de miroir `Shared`, pas de `getBytes` : c'est tout l'intérêt. On attend
        // quand même, parce que `avcodec_send_frame` va lire ce buffer juste après.
        // L'attente porte sur TOUT le travail GPU de la frame, composition comprise :
        // `compose_frame` n'a fait que soumettre.
        {
            let _p = crate::export_probe::scope(crate::export_probe::Stage::GpuWait);
            self.sync();
        }
        Ok(())
    }

    pub unsafe fn rgb_to_nv12_scaled(
        &self,
        _target_w: u32,
        _target_h: u32,
        _out_tex: *mut std::ffi::c_void,
        _slice: u32,
    ) -> Result<()> {
        self.render_nv12()
    }

    /// Convertit le RT RGBA → `nv12_y` (R8) et `nv12_uv` (RG8) via deux passes
    /// fullscreen (`ps_y` puis `ps_uv` sur `vs_fs`), puis recopie vers les miroirs
    /// `Shared` que `read_nv12_scaled` lit. Miroir Metal de
    /// `compositor_windows::render_nv12` — même conversion BT.709 limited.
    pub unsafe fn render_nv12(&self) -> Result<()> {
        let cmd_buf = self.gpu.context.new_command_buffer();

        for (target, pipeline) in [
            (&self.nv12_y, &self.pipeline_fs_y),
            (&self.nv12_uv, &self.pipeline_fs_uv),
        ] {
            let pass = metal::RenderPassDescriptor::new();
            let ca = pass
                .color_attachments()
                .object_at(0)
                .ok_or_else(|| anyhow!("RenderPassDescriptor::color_attachments(0) est nul"))?;
            ca.set_texture(Some(target));
            ca.set_load_action(metal::MTLLoadAction::Clear);
            ca.set_clear_color(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0));
            ca.set_store_action(metal::MTLStoreAction::Store);
            let enc = cmd_buf.new_render_command_encoder(&pass);
            enc.set_render_pipeline_state(pipeline);
            enc.set_fragment_texture(0, Some(&self.rt));
            // `vs_fs` est un triangle plein écran généré depuis `[[vertex_id]]`.
            enc.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
            enc.end_encoding();
        }

        let blit = cmd_buf.new_blit_command_encoder();
        for (src, dst, w, h) in [
            (&self.nv12_y, &self.nv12_read_y, self.render_w, self.render_h),
            (
                &self.nv12_uv,
                &self.nv12_read_uv,
                self.render_w / 2,
                self.render_h / 2,
            ),
        ] {
            blit.copy_from_texture(
                src,
                0,
                0,
                metal::MTLOrigin { x: 0, y: 0, z: 0 },
                metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
                dst,
                0,
                0,
                metal::MTLOrigin { x: 0, y: 0, z: 0 },
            );
        }
        blit.end_encoding();

        self.submit(cmd_buf);
        Ok(())
    }

    /// Lit le RT RGBA vers un `Vec<u8>` CPU (preview live). Renvoie `(w, h, RGBA8)`.
    pub unsafe fn readback_direct(&self) -> Result<(u32, u32, Vec<u8>)> {
        // Le miroir `Shared` se fait ICI plutôt qu'à chaque composition : seul ce chemin le
        // lit, et il n'est emprunté que par la preview.
        let cmd_buf = self.gpu.context.new_command_buffer();
        self.mirror_rt(cmd_buf);
        self.submit(cmd_buf);
        self.sync();
        let (w, h) = (self.render_w, self.render_h);
        let bytes_per_row = (w as usize) * 4;
        let mut data = vec![0u8; bytes_per_row * h as usize];
        self.rt_read.get_bytes(
            data.as_mut_ptr() as *mut std::ffi::c_void,
            bytes_per_row as u64,
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
            },
            0,
        );
        Ok((w, h, data))
    }

    /// Variante resize de `readback_direct` — first-pass engine : rend à la taille de
    /// rendu puis lit ; le resize GPU viendra avec le commit « pipeline resize ».
    pub unsafe fn readback_resized(&self, _target_w: u32, _target_h: u32) -> Result<Vec<u8>> {
        let (_, _, data) = self.readback_direct()?;
        Ok(data)
    }

    /// Lit le NV12 (Y+UV) vers la mémoire système, dans les plans d'une AVFrame.
    /// `pitch_y` / `pitch_uv` sont les strides de destination (`AVFrame::linesize`),
    /// que `getBytes` respecte via `bytesPerRow`.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn read_nv12_scaled(
        &self,
        target_w: u32,
        target_h: u32,
        dst_y: *mut u8,
        pitch_y: usize,
        dst_uv: *mut u8,
        pitch_uv: usize,
    ) -> Result<()> {
        // Le moteur rend à `render_w`x`render_h` ; lire au-delà serait hors-texture.
        // `render_nv12` a soumis sans attendre ; c'est ici, avant la première lecture CPU,
        // que la synchronisation est nécessaire.
        self.sync();
        let w = target_w.min(self.render_w);
        let h = target_h.min(self.render_h);
        if w == 0 || h == 0 {
            return Err(anyhow!(
                "read_nv12_scaled: cible vide ({target_w}x{target_h})"
            ));
        }
        self.nv12_read_y.get_bytes(
            dst_y as *mut std::ffi::c_void,
            pitch_y as u64,
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
            },
            0,
        );
        self.nv12_read_uv.get_bytes(
            dst_uv as *mut std::ffi::c_void,
            pitch_uv as u64,
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: (w / 2) as u64,
                    height: (h / 2) as u64,
                    depth: 1,
                },
            },
            0,
        );
        Ok(())
    }

    /// Vide le cache CoreVideo. À appeler quand la source change de dimensions.
    pub fn flush_texture_cache(&self) {
        self.metal_texture_cache.flush();
    }

    pub unsafe fn dump_nv12(&self, _path: &str) -> Result<()> {
        Err(anyhow!("compositor_macos::dump_nv12: non implémenté"))
    }

    pub unsafe fn dump_raw(&self, _path: &str) -> Result<()> {
        Err(anyhow!("compositor_macos::dump_raw: non implémenté"))
    }

    pub unsafe fn blit_to(&self, _rtv: *mut std::ffi::c_void, _x: f32, _y: f32, _w: f32, _h: f32) {
        // No-op : il n'y a pas de swapchain côté macOS (la preview passe par
        // `readback_direct`, l'export par `render_nv12`).
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Segmentation du sujet webcam
    //
    // Il n'y a PAS de banc hors Windows : `poc-d3d` est `cfg(windows)` dans son propre
    // `Cargo.toml`, donc le `--cfg C8 --scene …` qui a prouvé le chemin Windows n'existe
    // pas ici. Ce sont ces tests qui tiennent le rôle, et ils rendent de vrais pixels sur
    // le device Metal du système plutôt que d'inspecter des champs : ce que le portage
    // ajoute (une capture relue, un upload R8, une liaison à l'index 3, une branche
    // `fx.z`) est précisément ce qu'aucun `cargo build` ne peut vérifier.
    // -----------------------------------------------------------------------

    /// Luma BT.709 limited d'un gris neutre : `yuv709_limited` fait `(Y - 16) / 219` sur
    /// les trois canaux quand la chroma vaut 128, donc 235 rend du blanc franc et 16 du
    /// noir franc. Ces deux valeurs rendent les assertions de couleur calculables à la main.
    const Y_WHITE: u8 = 235;
    const Y_BLACK: u8 = 16;
    const UV_NEUTRAL: u8 = 128;

    fn region(w: u32, h: u32) -> metal::MTLRegion {
        metal::MTLRegion {
            origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
            size: metal::MTLSize { width: w as u64, height: h as u64, depth: 1 },
        }
    }

    /// Une paire de plans NV12 synthétiques, sous forme de `MTLTexture` — ce que
    /// `nv12_srvs` produirait d'une vraie frame, sans avoir à décoder quoi que ce soit.
    fn nv12_textures(
        device: &metal::Device,
        w: u32,
        h: u32,
        luma: impl Fn(u32, u32) -> u8,
    ) -> (metal::Texture, metal::Texture) {
        let y = make_texture(
            device,
            metal::MTLPixelFormat::R8Unorm,
            w,
            h,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );
        let mut plane = vec![0u8; (w * h) as usize];
        for row in 0..h {
            for col in 0..w {
                plane[(row * w + col) as usize] = luma(col, row);
            }
        }
        y.replace_region(region(w, h), 0, plane.as_ptr() as *const std::ffi::c_void, w as u64);

        let (uw, uh) = (w / 2, h / 2);
        let uv = make_texture(
            device,
            metal::MTLPixelFormat::RG8Unorm,
            uw,
            uh,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );
        let chroma = vec![UV_NEUTRAL; (uw * uh * 2) as usize];
        uv.replace_region(
            region(uw, uh),
            0,
            chroma.as_ptr() as *const std::ffi::c_void,
            (uw * 2) as u64,
        );
        (y, uv)
    }

    /// Masque 0 sur la moitié gauche, 255 sur la droite. La frontière tombe pile au milieu,
    /// donc un échantillon pris au quart et un aux trois quarts sont loin du dégradé que le
    /// filtrage linéaire pose sur la couture.
    fn half_mask(w: u32, h: u32) -> Vec<u8> {
        (0..w * h).map(|i| if i % w < w / 2 { 0u8 } else { 255u8 }).collect()
    }

    #[test]
    fn the_webcam_capture_comes_back_as_interleaved_rgb_at_model_resolution() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        // Moitié gauche noire, moitié droite blanche : la capture doit rendre les deux dans
        // le bon sens. Une inversion d'axe passerait un test de taille sans se voir.
        let (y, uv) = nv12_textures(&gpu.device, 64, 64, |col, _| {
            if col < 32 { Y_BLACK } else { Y_WHITE }
        });

        let mut out = Vec::new();
        unsafe {
            comp.capture_webcam_rgb(
                &y,
                &uv,
                [0.0, 0.0, 1.0, 1.0],
                crate::segmentation::MODEL_WIDTH,
                crate::segmentation::MODEL_HEIGHT,
                &mut out,
            )
            .expect("capture_webcam_rgb");
        }

        let (w, h) = (
            crate::segmentation::MODEL_WIDTH as usize,
            crate::segmentation::MODEL_HEIGHT as usize,
        );
        assert_eq!(out.len(), w * h * 3, "le modèle veut du RGB8 entrelacé, sans alpha");

        let px = |buf: &[u8], col: usize, row: usize| -> [u8; 3] {
            let i = (row * w + col) * 3;
            [buf[i], buf[i + 1], buf[i + 2]]
        };
        let left = px(&out, w / 4, h / 2);
        let right = px(&out, 3 * w / 4, h / 2);
        assert!(left.iter().all(|&c| c < 24), "moitié gauche pas noire : {left:?}");
        assert!(right.iter().all(|&c| c > 231), "moitié droite pas blanche : {right:?}");

        // Deuxième capture sur le même buffer : c'est le régime établi (30 fois par
        // seconde), et il ne doit ni réallouer ni traîner les octets du tour précédent.
        let capacity = out.capacity();
        unsafe {
            comp.capture_webcam_rgb(
                &y,
                &uv,
                [0.0, 0.0, 1.0, 1.0],
                crate::segmentation::MODEL_WIDTH,
                crate::segmentation::MODEL_HEIGHT,
                &mut out,
            )
            .expect("deuxième capture");
        }
        assert_eq!(out.len(), w * h * 3);
        assert_eq!(out.capacity(), capacity, "le scratch se réalloue d'une frame à l'autre");
        assert_eq!(px(&out, w / 4, h / 2), left);
        assert_eq!(px(&out, 3 * w / 4, h / 2), right);
    }

    #[test]
    fn a_capture_of_zero_size_is_refused_rather_than_rendered() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let (y, uv) = nv12_textures(&gpu.device, 16, 16, |_, _| Y_WHITE);
        let mut out = Vec::new();
        let err = unsafe { comp.capture_webcam_rgb(&y, &uv, [0.0, 0.0, 1.0, 1.0], 0, 144, &mut out) };
        assert!(err.is_err(), "une cible de largeur nulle doit être refusée");
    }

    #[test]
    fn the_mask_texture_is_allocated_once_and_a_short_buffer_is_refused() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let (w, h) = (crate::segmentation::MODEL_WIDTH, crate::segmentation::MODEL_HEIGHT);
        let mask = vec![255u8; (w * h) as usize];

        comp.set_webcam_mask(&mask, w, h).expect("premier téléversement");
        let first = comp.webcam_mask.borrow().as_ref().map(|m| m.tex.as_ptr());
        comp.set_webcam_mask(&mask, w, h).expect("deuxième téléversement");
        let second = comp.webcam_mask.borrow().as_ref().map(|m| m.tex.as_ptr());
        assert_eq!(
            first, second,
            "la texture est recréée à chaque frame alors que la résolution du modèle est fixe"
        );

        // Un masque trop court doit être refusé, pas lu hors bornes : `replace_region` lit
        // `width` octets par ligne sans rien savoir de la longueur de la tranche.
        assert!(comp.set_webcam_mask(&mask[..(w * h) as usize - 1], w, h).is_err());
        assert!(comp.set_webcam_mask(&mask, 0, h).is_err());
        assert!(comp.clear_webcam_mask() == () && comp.webcam_mask.borrow().is_none());
    }

    /// Le test qui compte : le masque DÉCOUPE vraiment la caméra.
    ///
    /// Il rend le calque webcam plein cadre sur le RT avec `fx.z = 1` (détourage) et un
    /// masque mi-fond mi-sujet, puis relit les pixels. Il couvre d'un coup les trois choses
    /// que le portage ajoute et qu'aucune compilation ne vérifie : l'upload R8, la liaison
    /// de la texture à l'index 3, et la branche `fx.z` de `ps_main` sur un vrai device.
    #[test]
    fn the_mask_actually_cuts_the_camera_out() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 64, 64).expect("Compositor::new_sized");
        comp.set_webcam_mask(&half_mask(8, 8), 8, 8).expect("set_webcam_mask");
        let (y, uv) = nv12_textures(&gpu.device, 16, 16, |_, _| Y_WHITE);

        // Fond bleu franc : une couleur que la caméra (blanche, chroma neutre) ne peut pas
        // produire, donc « il reste du bleu » signifie « la caméra a été découpée ici ».
        let cmd = gpu.context.new_command_buffer();
        let enc = comp
            .begin_pass(
                cmd,
                &comp.rt,
                Some(metal::MTLClearColor::new(0.0, 0.0, 1.0, 1.0)),
                &comp.pipeline_main,
            )
            .expect("begin_pass");
        {
            let mask = comp.webcam_mask.borrow();
            enc.set_fragment_texture(3, Some(&mask.as_ref().expect("masque posé").tex));
        }
        unsafe {
            comp.draw_video(
                enc,
                &LayerCB {
                    dst: [0.0, 0.0, 1.0, 1.0],
                    src: [0.0, 0.0, 1.0, 1.0],
                    quad_px: [64.0, 64.0],
                    mode: 0.0,
                    color: [0.0, 0.0, 0.0, 1.0],
                    // fx.xy = étendue valide (toute la texture ici), fx.z = 1 → détourage.
                    fx: [1.0, 1.0, 1.0, 0.0],
                    src_prev: [0.0, 0.0, 1.0, 1.0],
                    dst_prev: [0.0, 0.0, 1.0, 1.0],
                    mb: [1.0, 1.0, 1.0, 0.0],
                    ..Default::default()
                },
                &y,
                &uv,
            );
        }
        enc.end_encoding();
        comp.submit(cmd);
        let (rw, rh, rgba) = unsafe { comp.readback_direct().expect("readback_direct") };
        assert_eq!((rw, rh), (64, 64));

        let px = |col: usize, row: usize| -> [u8; 4] {
            let i = (row * rw as usize + col) * 4;
            [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
        };
        let cut = px(16, 32);
        let kept = px(48, 32);
        assert_eq!(cut, [0, 0, 255, 255], "masque à 0 : le fond doit rester visible");
        assert_eq!(kept, [255, 255, 255, 255], "masque à 255 : la caméra doit rester opaque");
    }

    /// Même montage, mode fond personnalisé (`fx.z = 3`) : là où le masque dit « fond », le
    /// shader doit peindre `color` — c'est le seul mode où `LayerCB::color` cesse d'être
    /// du noir opaque décoratif et porte une valeur que le portage doit transmettre.
    #[test]
    fn the_custom_background_colour_replaces_the_masked_out_pixels() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 64, 64).expect("Compositor::new_sized");
        comp.set_webcam_mask(&half_mask(8, 8), 8, 8).expect("set_webcam_mask");
        let (y, uv) = nv12_textures(&gpu.device, 16, 16, |_, _| Y_WHITE);

        let cmd = gpu.context.new_command_buffer();
        let enc = comp
            .begin_pass(
                cmd,
                &comp.rt,
                Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0)),
                &comp.pipeline_main,
            )
            .expect("begin_pass");
        {
            let mask = comp.webcam_mask.borrow();
            enc.set_fragment_texture(3, Some(&mask.as_ref().expect("masque posé").tex));
        }
        unsafe {
            comp.draw_video(
                enc,
                &LayerCB {
                    dst: [0.0, 0.0, 1.0, 1.0],
                    src: [0.0, 0.0, 1.0, 1.0],
                    quad_px: [64.0, 64.0],
                    mode: 0.0,
                    color: [1.0, 0.0, 0.0, 1.0],
                    fx: [1.0, 1.0, 3.0, 0.0],
                    src_prev: [0.0, 0.0, 1.0, 1.0],
                    dst_prev: [0.0, 0.0, 1.0, 1.0],
                    mb: [1.0, 1.0, 1.0, 0.0],
                    ..Default::default()
                },
                &y,
                &uv,
            );
        }
        enc.end_encoding();
        comp.submit(cmd);
        let (rw, _, rgba) = unsafe { comp.readback_direct().expect("readback_direct") };
        let px = |col: usize, row: usize| -> [u8; 4] {
            let i = (row * rw as usize + col) * 4;
            [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
        };
        assert_eq!(px(16, 32), [255, 0, 0, 255], "fond masqué : la couleur custom doit peindre");
        assert_eq!(px(48, 32), [255, 255, 255, 255], "sujet : la caméra doit rester intacte");
    }


    // -----------------------------------------------------------------------
    // `compose_frame` de bout en bout
    //
    // Les tests ci-dessus prouvent les pièces ; ceux-ci prouvent le CÂBLAGE — que
    // `compose_frame` porte bien `fx`/`color` sur le calque webcam, qu'il lie le masque, et
    // qu'il ne lève `fx.z` qu'une fois un masque réellement téléversé. Ils passent par de
    // vraies `AVFrame` VideoToolbox (des `CVPixelBufferRef` IOSurface-backed), donc par le
    // MÊME `nv12_srvs` que le décodeur : aucun raccourci n'est pris sur le seam de frame.
    //
    // Aucun n'a besoin d'ONNX Runtime : le masque est posé à la main par `set_webcam_mask`.
    // C'est délibéré — ce que le portage ajoute côté GPU doit être vérifiable là où
    // l'inférence n'est pas installée, ce qui est le cas de la CI.
    // -----------------------------------------------------------------------

    /// Une `AVFrame` VideoToolbox synthétique. `compose_frame` ne lit que `format`,
    /// `data[3]`, `width` et `height` : le reste peut rester à zéro.
    struct FakeFrame {
        frame: Box<AVFrame>,
        _pb: crate::mac_frames::CVPixelBufferRef,
    }

    impl FakeFrame {
        fn new(w: u32, h: u32, luma: impl Fn(u32, u32) -> u8) -> FakeFrame {
            let mut y = vec![0u8; (w * h) as usize];
            for row in 0..h {
                for col in 0..w {
                    y[(row * w + col) as usize] = luma(col, row);
                }
            }
            FakeFrame::from_planes(w, h, &y, &vec![UV_NEUTRAL; (w * (h / 2)) as usize])
        }

        fn from_planes(w: u32, h: u32, y: &[u8], uv: &[u8]) -> FakeFrame {
            let pb = crate::mac_frames::nv12_pixel_buffer_from_planes(w, h, y, uv)
                .expect("CVPixelBuffer NV12");
            let mut frame: Box<AVFrame> = Box::new(unsafe { std::mem::zeroed() });
            frame.format = crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32;
            frame.data[3] = pb.as_ptr() as *mut u8;
            frame.width = w as i32;
            frame.height = h as i32;
            FakeFrame { frame, _pb: pb }
        }

        fn as_ptr(&self) -> *const AVFrame {
            &*self.frame as *const AVFrame
        }
    }

    /// Scène PiP minimale. `effect` est le JSON de `webcamEffect` (`"null"` pour aucun).
    ///
    /// `effects.shadow` vaut 0 À DESSEIN : ce curseur ne pilote plus que l'ombre de l'écran,
    /// alors que celle du PiP est fixe (`WEBCAM_SHADOW_OPACITY`) et ne dépend que de
    /// `cfg.shadow`. Le mettre à zéro est donc ce qui isole les deux — sinon un test sur
    /// `cfg.shadow` mesure les deux ombres à la fois et ne dit plus rien de la caméra.
    fn pip_scene_json(effect: &str) -> String {
        format!(
            r##"{{"clips":[],
                "layout":{{"preset":"picture-in-picture","webcamSize":1,"webcamShape":"rectangle",
                           "webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
                "effects":{{"padding":0.18,"blur":false,"shadow":0,"roundnessFrac":0.05,"motionBlur":0}},
                "background":{{"kind":"color","color":"#0080ff"}},
                "zoomRegions":[],"annotations":[],
                "cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,
                           "clipToBounds":false,"theme":"default"}},
                "cropByClip":[],
                "webcamEffect":{effect},
                "output":{{"width":1920,"height":1080,"fps":30}}}}"##
        )
    }

    /// Compose une frame et rend le RGBA du RT. `screen` est gris moyen, `webcam` blanche :
    /// le blanc franc devient alors la SIGNATURE de la caméra, une couleur qu'aucun autre
    /// calque de cette scène ne produit, donc comptable sans connaître la géométrie du PiP.
    ///
    /// Le fond est un bleu franc et NON du noir : le PiP par défaut tombe dans la marge, hors
    /// de l'écran, et une ombre noire sur un fond noir ne se voit pas — le contrôle du test
    /// d'ombre passerait alors pour une suppression réussie.
    fn compose_pip(comp: &super::Compositor, effect: &str, shadow: bool) -> Vec<u8> {
        let scene = crate::scene::Scene::from_json(&pip_scene_json(effect)).expect("scene json");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_has_webcam(true);
        comp.set_scene(Some(scene));

        let screen = FakeFrame::new(128, 128, |_, _| 126);
        let webcam = FakeFrame::new(64, 64, |_, _| Y_WHITE);
        let mut cfg = crate::config::Cfg::c8();
        cfg.bg_blur = false;
        cfg.zoom = false;
        cfg.layout_anim = false;
        cfg.cursor = false;
        cfg.mblur_n = 1;
        cfg.shadow = shadow;
        unsafe {
            comp.compose_frame(screen.as_ptr(), webcam.as_ptr(), 0.0, &cfg)
                .expect("compose_frame");
            let (_, _, rgba) = comp.readback_direct().expect("readback_direct");
            rgba
        }
    }

    /// Pixels quasi blancs = pixels de caméra encore visibles.
    fn camera_pixels(rgba: &[u8]) -> usize {
        rgba.chunks_exact(4)
            .filter(|px| px[0] > 240 && px[1] > 240 && px[2] > 240)
            .count()
    }

    const NO_EFFECT: &str = "null";
    const CUTOUT: &str = r#"{"mode":"transparent","blurIntensity":0,"background":null,"modelPath":null}"#;

    /// Le piège que le brief nomme : un mode SANS masque ne doit rien changer.
    ///
    /// `effect_code` doit rester à 0 tant que rien n'a été segmenté, sinon le détourage rend
    /// une webcam invisible sur les premières frames — le temps que l'inférence rende son
    /// premier masque, c'est-à-dire à chaque ouverture de l'éditeur. L'assertion est
    /// octet pour octet : « inchangé » ne souffre pas d'à-peu-près.
    #[test]
    fn a_mode_without_a_mask_composites_exactly_like_no_effect_at_all() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let plain = compose_pip(&comp, NO_EFFECT, true);
        let requested = compose_pip(&comp, CUTOUT, true);
        assert!(
            comp.webcam_mask.borrow().is_none(),
            "aucun masque n'a été téléversé : `modelPath` est absent, donc rien ne segmente"
        );
        assert!(camera_pixels(&plain) > 200, "la caméra n'est pas à l'écran, le test ne prouve rien");
        assert_eq!(plain, requested, "un mode sans masque a changé des pixels");
    }

    /// Et une fois le masque là, le détourage doit VRAIMENT découper — dans la bonne
    /// proportion. Le masque couvre la moitié de la caméra, donc la moitié de ses pixels
    /// doit disparaître. Compter plutôt que d'échantillonner un point évite de coder en dur
    /// la géométrie du PiP, qui appartient à `plan_frame` et non à ce portage.
    #[test]
    fn compose_frame_cuts_the_camera_out_once_a_mask_exists() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let whole = camera_pixels(&compose_pip(&comp, NO_EFFECT, true));
        assert!(whole > 200, "la caméra n'est pas à l'écran, le test ne prouve rien");

        let (mw, mh) = (crate::segmentation::MODEL_WIDTH, crate::segmentation::MODEL_HEIGHT);
        comp.set_webcam_mask(&half_mask(mw, mh), mw, mh).expect("set_webcam_mask");
        let cut = camera_pixels(&compose_pip(&comp, CUTOUT, true));

        let expected = whole as f32 / 2.0;
        assert!(
            (cut as f32 - expected).abs() < expected * 0.15,
            "détourage : {cut} pixels de caméra restants pour ~{expected:.0} attendus \
             (entier : {whole})"
        );
    }

    /// L'ombre portée du PiP doit disparaître en détourage : une ombre projetée par un
    /// rectangle devenu invisible se lit comme un artefact. Le test le prouve sans jamais
    /// localiser l'ombre — en détourage, `cfg.shadow` ne doit plus rien changer du tout.
    ///
    /// Le contrôle est ce qui empêche l'assertion d'être vide : sans effet, `cfg.shadow`
    /// DOIT changer des pixels, sinon la première moitié passerait aussi pour une scène où
    /// aucune ombre n'a jamais été dessinée.
    #[test]
    fn the_pip_shadow_is_suppressed_in_cutout_mode() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        assert_ne!(
            compose_pip(&comp, NO_EFFECT, true),
            compose_pip(&comp, NO_EFFECT, false),
            "contrôle : sans effet, l'ombre du PiP doit bel et bien se voir"
        );

        let (mw, mh) = (crate::segmentation::MODEL_WIDTH, crate::segmentation::MODEL_HEIGHT);
        comp.set_webcam_mask(&half_mask(mw, mh), mw, mh).expect("set_webcam_mask");
        assert_eq!(
            compose_pip(&comp, CUTOUT, true),
            compose_pip(&comp, CUTOUT, false),
            "en détourage, l'ombre est encore dessinée"
        );
    }

    /// Le tour complet, celui qui a besoin d'ONNX Runtime : capture → inférence → masque →
    /// composite, entraîné par `compose_frame` seul. Se saute proprement sans la
    /// bibliothèque, ce que fait la CI — cf. `segmentation::runtime_available`.
    #[test]
    fn the_whole_loop_produces_a_mask_from_compose_frame_alone() {
        if !crate::segmentation::runtime_available() {
            eprintln!("ONNX Runtime absent (ORT_DYLIB_PATH) — test sauté");
            return;
        }
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../public/mediapipe/selfie_segmentation/selfie_segmentation_landscape.onnx");
        if !model.is_file() {
            eprintln!("modèle absent ({}) — test sauté", model.display());
            return;
        }
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let effect = format!(
            r#"{{"mode":"transparent","blurIntensity":0,"background":null,"modelPath":{}}}"#,
            serde_json::to_string(&model.to_string_lossy()).expect("chemin sérialisable")
        );

        // Le limiteur est à 30 Hz : une frame par tour ne suffirait pas, et l'inférence est
        // asynchrone. On laisse au worker le temps de rendre un masque, sans jamais
        // l'attendre dans le rendu — ce qui est précisément le contrat.
        let mut uploaded = false;
        for _ in 0..40 {
            let _ = compose_pip(&comp, &effect, true);
            if comp.webcam_mask.borrow().is_some() {
                uploaded = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        assert!(
            uploaded,
            "aucun masque n'est remonté : la boucle capture → inférence → upload est rompue"
        );
        assert!(
            !*comp.seg_failed.borrow(),
            "la segmentation s'est éteinte d'elle-même"
        );
    }

    // -----------------------------------------------------------------------
    // Harnais visuel (opt-in)
    //
    // Les tests ci-dessus prouvent le mécanisme sur des images synthétiques, où le masque
    // est posé à la main et donc trivialement juste. Ils ne peuvent rien dire de la QUALITÉ
    // du masque que le modèle produit sur une vraie caméra — et « un masque qui composite »
    // n'est pas la même affirmation que « un masque qui est correct ».
    //
    // `poc-d3d` étant `cfg(windows)`, il n'existe aucun banc ici pour trancher ça. Ceci en
    // tient lieu : on lui donne une photo, il rend les quatre modes et écrit des PNG à
    // regarder. Même forme d'opt-in que `tests/compose_linux.rs` (variable d'environnement
    // + skip propre), et pour la même raison : ça rend sur GPU et ça lit un fichier que le
    // dépôt ne porte pas.
    //
    // ```
    // ORT_DYLIB_PATH=/chemin/libonnxruntime.dylib \
    // OPENSCREEN_SEG_CAM=camera.png \
    // OPENSCREEN_SEG_VISUAL=target/seg \
    //   cargo test -p openscreen-compositor --lib seg_visual -- --nocapture
    // ```
    // -----------------------------------------------------------------------

    /// RGB8 → NV12 BT.709 limited. Inverse EXACT de `yuv709_limited` dans `shaders.metal` :
    /// une autre matrice ferait dériver les couleurs du rendu et on croirait à un bug du
    /// compositeur là où il n'y aurait qu'une conversion d'entrée fausse.
    #[allow(clippy::type_complexity)]
    fn rgb_to_nv12(rgb: &[u8], w: u32, h: u32) -> (Vec<u8>, Vec<u8>) {
        let luma = |i: usize| -> (f32, f32, f32, f32) {
            let (r, g, b) = (
                rgb[i * 3] as f32 / 255.0,
                rgb[i * 3 + 1] as f32 / 255.0,
                rgb[i * 3 + 2] as f32 / 255.0,
            );
            (r, g, b, 0.2126 * r + 0.7152 * g + 0.0722 * b)
        };
        let mut y = vec![0u8; (w * h) as usize];
        for i in 0..(w * h) as usize {
            let (_, _, _, yl) = luma(i);
            y[i] = (16.0 + 219.0 * yl).round().clamp(0.0, 255.0) as u8;
        }
        // Chroma au plus proche voisin : l'échantillon en haut à gauche de chaque bloc 2x2.
        // Un vrai filtre ne changerait rien à ce que ce harnais donne à voir.
        let mut uv = vec![0u8; (w * (h / 2)) as usize];
        for row in 0..h / 2 {
            for col in 0..w / 2 {
                let (r, _, b, yl) = luma(((row * 2) * w + col * 2) as usize);
                let cb = 128.0 + 224.0 * ((b - yl) / 1.8556);
                let cr = 128.0 + 224.0 * ((r - yl) / 1.5748);
                let o = (row * w + col * 2) as usize;
                uv[o] = cb.round().clamp(0.0, 255.0) as u8;
                uv[o + 1] = cr.round().clamp(0.0, 255.0) as u8;
            }
        }
        (y, uv)
    }

    fn frame_from_png(path: &std::path::Path) -> FakeFrame {
        let img = image::open(path)
            .unwrap_or_else(|e| panic!("{} : {e}", path.display()))
            .to_rgb8();
        // NV12 veut des dimensions paires ; on rogne d'un pixel plutôt que de rééchantillonner.
        let (w, h) = (img.width() & !1, img.height() & !1);
        let src = img.as_raw();
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        for row in 0..h {
            let (d, s) = ((row * w * 3) as usize, (row * img.width() * 3) as usize);
            rgb[d..d + (w * 3) as usize].copy_from_slice(&src[s..s + (w * 3) as usize]);
        }
        let (y, uv) = rgb_to_nv12(&rgb, w, h);
        FakeFrame::from_planes(w, h, &y, &uv)
    }

    #[test]
    fn seg_visual_renders_the_four_modes_from_a_real_photo() {
        let (Ok(out_dir), Ok(cam)) = (
            std::env::var("OPENSCREEN_SEG_VISUAL"),
            std::env::var("OPENSCREEN_SEG_CAM"),
        ) else {
            eprintln!("harnais visuel : OPENSCREEN_SEG_VISUAL + OPENSCREEN_SEG_CAM absents — sauté");
            return;
        };
        if !crate::segmentation::runtime_available() {
            eprintln!("ONNX Runtime absent (ORT_DYLIB_PATH) — sauté");
            return;
        }
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../public/mediapipe/selfie_segmentation/selfie_segmentation_landscape.onnx");
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — sauté");
            return;
        };
        std::fs::create_dir_all(&out_dir).expect("dossier de sortie");

        let (rw, rh) = (1280u32, 720u32);
        let comp = super::Compositor::new_sized(&gpu, rw, rh).expect("Compositor::new_sized");
        let webcam = frame_from_png(std::path::Path::new(&cam));
        let screen = match std::env::var("OPENSCREEN_SEG_SCREEN") {
            Ok(p) => frame_from_png(std::path::Path::new(&p)),
            // Sans capture d'écran sous la main, un damier : il rend le détourage lisible,
            // là où un aplat laisserait croire à un fond simplement peint.
            Err(_) => FakeFrame::new(640, 360, |col, row| {
                if (col / 40 + row / 40) % 2 == 0 { 180 } else { 60 }
            }),
        };
        let model_json = serde_json::to_string(&model.to_string_lossy()).expect("chemin");

        let mut wrote = Vec::new();
        for (name, effect) in [
            ("00-none", "null".to_string()),
            ("01-cutout", format!(r#"{{"mode":"transparent","blurIntensity":0,"background":null,"modelPath":{model_json}}}"#)),
            ("02-blur", format!(r#"{{"mode":"blur","blurIntensity":0.8,"background":null,"modelPath":{model_json}}}"#)),
            ("03-custom", format!(r##"{{"mode":"custom","blurIntensity":0,"background":{{"kind":"color","color":"#ff2d95"}},"modelPath":{model_json}}}"##)),
        ] {
            // Le masque arrive de façon asynchrone : on tourne jusqu'à ce qu'il soit là, ce
            // qui est aussi une vérification en soi — la boucle du rendu ne l'attend jamais.
            let mut rgba = Vec::new();
            for _ in 0..60 {
                rgba = compose_visual(&comp, &screen, &webcam, &effect);
                if effect == "null" || comp.webcam_mask.borrow().is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            let path = format!("{out_dir}/seg-{name}.png");
            image::RgbaImage::from_raw(rw, rh, rgba)
                .expect("dimensions du readback")
                .save(&path)
                .unwrap_or_else(|e| panic!("écriture {path} : {e}"));
            wrote.push(path);
        }
        for p in &wrote {
            println!("wrote {p}");
        }
        assert!(
            comp.webcam_mask.borrow().is_some(),
            "aucun masque n'a été produit : les trois modes d'effet sont sans objet"
        );
    }

    /// Caméra plein cadre (`camera-fullscreen`… sans région : on force le rect via
    /// `webcamRect`), pour que le masque occupe toute l'image et se juge à taille réelle.
    fn compose_visual(
        comp: &super::Compositor,
        screen: &FakeFrame,
        webcam: &FakeFrame,
        effect: &str,
    ) -> Vec<u8> {
        let json = format!(
            r##"{{"clips":[],
                "layout":{{"preset":"picture-in-picture","webcamSize":1,"webcamShape":"rectangle",
                           "webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                           "webcamRect":{{"x":0.06,"y":0.10,"width":0.55,"height":0.72}}}},
                "effects":{{"padding":0.10,"blur":false,"shadow":1,"roundnessFrac":0.02,"motionBlur":0}},
                "background":{{"kind":"gradient","angleDeg":45,"stops":["#1b2a4a","#0b0f1a"]}},
                "zoomRegions":[],"annotations":[],
                "cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,
                           "clipToBounds":false,"theme":"default"}},
                "cropByClip":[],
                "webcamEffect":{effect},
                "output":{{"width":1280,"height":720,"fps":30}}}}"##
        );
        let scene = crate::scene::Scene::from_json(&json).expect("scene json");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_has_webcam(true);
        comp.set_scene(Some(scene));
        let mut cfg = crate::config::Cfg::c8();
        cfg.zoom = false;
        cfg.layout_anim = false;
        cfg.cursor = false;
        cfg.mblur_n = 1;
        unsafe {
            comp.compose_frame(screen.as_ptr(), webcam.as_ptr(), 0.0, &cfg)
                .expect("compose_frame");
            let (_, _, rgba) = comp.readback_direct().expect("readback_direct");
            rgba
        }
    }

    // -----------------------------------------------------------------------
    // Profondeur de champ du mode 8 (pendant macOS de `tests/tilted_depth_of_field.rs`)
    //
    // Le seul golden de l'effet qui tourne en CI : celui de Windows est opt-in (source vidéo),
    // celui de Linux aussi (`OPENSCREEN_LINUX_COMPOSE`). C'est aussi le premier vrai passage de
    // `fill_dof_pyramid`, de `generate_mipmaps` et du `texture(2)` du mode 8. Le piège qu'il
    // garde : un `level(lod)` qui retomberait au niveau 0 laisserait macOS net là où Windows
    // floute.
    // -----------------------------------------------------------------------

    /// Écran seul sur fond magenta (couleur qu'aucune luma neutre ne produit), focus manuel sur
    /// le coin proche d'`iso` (haut-droit), zoom 1 en plein palier sur 0..6 s.
    fn dof_scene_json(rotation: &str, dof: bool) -> String {
        format!(
            r##"{{"clips":[],
                "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle",
                           "webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
                "effects":{{"padding":0.2,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0,
                            "depthOfField":{dof}}},
                "background":{{"kind":"color","color":"#ff00ff"}},
                "zoomRegions":[{{"clipIndex":0,"startSec":0,"endSec":6,"scale":1.0,
                                 "focusX":0.94,"focusY":0.06,"focusMode":"manual",
                                 "rotation":{rotation}}}],
                "annotations":[],
                "cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,
                           "clipToBounds":false,"theme":"default"}},
                "cropByClip":[],
                "output":{{"width":1280,"height":720,"fps":30}}}}"##
        )
    }

    fn compose_dof(comp: &super::Compositor, screen: &FakeFrame, rotation: &str, dof: bool) -> Vec<u8> {
        let scene = crate::scene::Scene::from_json(&dof_scene_json(rotation, dof)).expect("scene json");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_has_webcam(false);
        comp.set_scene(Some(scene));
        let mut cfg = crate::config::Cfg::c8();
        cfg.shadow = false;
        cfg.cursor = false;
        cfg.mblur_n = 1;
        unsafe {
            // Frame 180 à `FPS` (60) = 3 s : en plein palier de la région.
            comp.compose_frame(screen.as_ptr(), std::ptr::null(), 180.0, &cfg)
                .expect("compose_frame");
            comp.readback_direct().expect("readback_direct").2
        }
    }

    /// Coin du plan (hors magenta) extrême dans la direction `dir`, rentré de `inset` vers le
    /// centroïde : une fenêtre posée là est entièrement sur le plan, loin du feather.
    fn dof_corner(rgba: &[u8], w: u32, h: u32, dir: (i64, i64), inset: f64) -> (u32, u32) {
        let (mut best, mut at) = (i64::MIN, (0i64, 0i64));
        let (mut sx, mut sy, mut n) = (0f64, 0f64, 0f64);
        for y in 0..h as i64 {
            for x in 0..w as i64 {
                let p = &rgba[((y * w as i64 + x) * 4) as usize..];
                if p[0] > 200 && p[1] < 60 && p[2] > 200 {
                    continue;
                }
                sx += x as f64;
                sy += y as f64;
                n += 1.0;
                if x * dir.0 + y * dir.1 > best {
                    best = x * dir.0 + y * dir.1;
                    at = (x, y);
                }
            }
        }
        let x = at.0 as f64 + (sx / n - at.0 as f64) * inset;
        let y = at.1 as f64 + (sy / n - at.1 as f64) * inset;
        (x as u32, y as u32)
    }

    /// Octets et netteté (écart moyen entre voisins, vert) d'une fenêtre `r`×`r` centrée en `c`.
    fn dof_window(rgba: &[u8], w: u32, c: (u32, u32), r: u32) -> (Vec<u8>, f64) {
        let g = |x: u32, y: u32| rgba[((y * w + x) * 4 + 1) as usize] as f64;
        let (mut bytes, mut acc) = (Vec::new(), 0.0);
        for y in c.1 - r / 2..c.1 + r / 2 {
            for x in c.0 - r / 2..c.0 + r / 2 {
                let i = ((y * w + x) * 4) as usize;
                bytes.extend_from_slice(&rgba[i..i + 4]);
                acc += (g(x + 1, y) - g(x, y)).abs() + (g(x, y + 1) - g(x, y)).abs();
            }
        }
        (bytes, acc / (r * r) as f64)
    }

    #[test]
    fn depth_of_field_defocuses_the_far_corner_of_a_tilted_screen_only() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let (w, h) = (1280u32, 720u32);
        let comp = super::Compositor::new_sized(&gpu, w, h).expect("Compositor::new_sized");
        // Damier de 2 texels : le détail le plus fin possible, que le moindre niveau de mip efface.
        let screen = FakeFrame::new(640, 360, |col, row| if (col / 2 + row / 2) % 2 == 0 { 180 } else { 60 });

        let on = compose_dof(&comp, &screen, "\"iso\"", true);
        let off = compose_dof(&comp, &screen, "\"iso\"", false);
        let r = 32;
        let near = dof_corner(&off, w, h, (1, -1), 0.12);
        let far = dof_corner(&off, w, h, (-1, 1), 0.12);
        let ((near_on_px, near_on), (near_off_px, near_off)) =
            (dof_window(&on, w, near, r), dof_window(&off, w, near, r));
        let ((_, far_on), (_, far_off)) = (dof_window(&on, w, far, r), dof_window(&off, w, far, r));
        println!("dof : proche {near_off:.2} -> {near_on:.2}, lointain {far_off:.2} -> {far_on:.2}");
        assert!(far_off > 2.0, "fenêtre lointaine sans détail ({far_off})");
        assert!(near_on_px == near_off_px, "coin proche modifié : {near_off} -> {near_on}");
        assert!(far_on < far_off * 0.7, "coin lointain pas flouté : {far_off} -> {far_on}");

        // À plat, l'effet n'existe pas : allumé ou non, la frame est la même à l'octet.
        assert!(
            compose_dof(&comp, &screen, "null", true) == compose_dof(&comp, &screen, "null", false),
            "rotation nulle : la profondeur de champ a changé la frame"
        );
    }

    // -----------------------------------------------------------------------
    // Cadres d'appareil modelés (mode 17) : pendant de `tests/device_frame_render.rs` (Windows)
    // et du test Linux du même nom. Il tourne sur la CI macOS : c'est la seule compilation et la
    // seule exécution du mode 17 en MSL.
    // -----------------------------------------------------------------------

    /// Un écran seul sur un fond magenta, avec le cadre `frame` (fragment JSON) et la rotation
    /// `rotation`. Même forme que `compose_dof`, dont il ne diffère que par la clé lue.
    fn compose_device(comp: &super::Compositor, screen: &FakeFrame, frame: &str, rotation: &str) -> Vec<u8> {
        let json = format!(
            r##"{{"clips":[],
                "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle",
                           "webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
                "effects":{{"padding":0.25,"blur":false,"shadow":0.6,"roundnessFrac":0.02,
                            "motionBlur":0{frame}}},
                "background":{{"kind":"color","color":"#ff00ff"}},
                "zoomRegions":[{{"clipIndex":0,"startSec":0,"endSec":6,"scale":1.0,
                                 "focusX":0.5,"focusY":0.5,"focusMode":"manual",
                                 "rotation":{rotation}}}],
                "annotations":[],
                "cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,
                           "clipToBounds":false,"theme":"default"}},
                "cropByClip":[],
                "output":{{"width":1280,"height":720,"fps":30}}}}"##
        );
        let scene = crate::scene::Scene::from_json(&json).expect("scene json");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_has_webcam(false);
        comp.set_scene(Some(scene));
        let mut cfg = crate::config::Cfg::c8();
        cfg.cursor = false;
        cfg.mblur_n = 1;
        unsafe {
            comp.compose_frame(screen.as_ptr(), std::ptr::null(), 180.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback_direct").2
        }
    }

    /// Les quatre appareils se dessinent AUTOUR du métrage : chacun change beaucoup de pixels par
    /// rapport à « pas de cadre », aucun ne ressemble aux autres, et le centre de l'ouverture
    /// reste le métrage — c'est toute la thèse du mode 17, qui arrête ses rayons au plan que le
    /// mode 8 dessine.
    #[test]
    fn the_device_frames_draw_around_the_footage() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let (w, h) = (1280u32, 720u32);
        let comp = super::Compositor::new_sized(&gpu, w, h).expect("Compositor::new_sized");
        // Métrage UNIFORME, et gris moyen : compter ses pixels dit ce que le cadre en recouvre, et
        // le pixel du centre reste comparable d'un cas à l'autre.
        let screen = FakeFrame::new(640, 360, |_, _| 140);
        let differing = |a: &[u8], b: &[u8]| {
            a.chunks_exact(4)
                .zip(b.chunks_exact(4))
                .filter(|(p, q)| p.iter().zip(q.iter()).take(3).any(|(x, y)| x.abs_diff(*y) > 8))
                .count()
        };
        // Le métrage est un aplat : compter ses pixels dit combien il en reste sous le cadre,
        // sans avoir à reprojeter l'ouverture — ce que fait, lui, le test Windows
        // (`tests/device_frame_render.rs`), point par point le long de la lunette.
        let footage = |rgba: &[u8], c: [u8; 3]| {
            rgba.chunks_exact(4).filter(|p| p[0] == c[0] && p[1] == c[1] && p[2] == c[2]).count()
        };
        let centre = |rgba: &[u8]| {
            let i = (((h / 2) * w + w / 2) * 4) as usize;
            [rgba[i], rgba[i + 1], rgba[i + 2]]
        };
        for (name, rotation) in [("flat", "null"), ("iso", r#""iso""#)] {
            let none = compose_device(&comp, &screen, r#","frame":"none""#, rotation);
            // Sans cadre, l'écran est centré : le pixel du centre EST le métrage.
            let tone = centre(&none);
            let bare = footage(&none, tone);
            let mut shots = Vec::new();
            for device in ["window", "laptop", "phone", "monitor"] {
                let rgba = compose_device(&comp, &screen, &format!(r#","frame":"{device}""#), rotation);
                let dark = compose_device(
                    &comp,
                    &screen,
                    &format!(r#","frame":"{device}","frameTheme":"dark""#),
                    rotation,
                );
                assert!(
                    differing(&rgba, &dark) > 2_000,
                    "{name} {device} : les deux thèmes se confondent"
                );
                let seen = differing(&none, &rgba);
                let kept = footage(&rgba, tone);
                println!("{name:<5} {device:<8} {seen:>7} px de cadre, {kept:>7} px de métrage");
                // Des lunettes fines autour d'un grand métrage : un anneau, plus l'ombre.
                assert!(seen > 15_000, "{name} {device} : cadre invisible ({seen} px)");
                // Le métrage garde sa boîte sous tous les cadres (le cadre pousse vers
                // l'extérieur) : seul le recouvrement d'un pixel et quart de la lunette le mord.
                assert!(kept > bare * 9 / 10, "{name} {device} : métrage couvert ({kept} sur {bare})");
                shots.push((device, rgba));
            }
            for (i, (a, ra)) in shots.iter().enumerate() {
                for (b, rb) in &shots[i + 1..] {
                    assert!(differing(ra, rb) > 10_000, "{name} : {a} et {b} se confondent");
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Curseur modélisé (mode 15) : pendant de `tests/cursor_model_render.rs` (Windows). Il tourne sur la
    // CI macOS : c'est la seule compilation et la seule exécution du mode 15 en MSL.
    // -----------------------------------------------------------------------

    /// Les états que le rendu passe en revue (hotspots de `DEFAULT_CURSOR_SPRITES`), et s'ils
    /// sont centrés : ni tangage ni lacet.
    const MODEL_STATES: [(&str, [f32; 2], bool); 6] = [
        ("arrow", [0.119, 0.0874], false),
        ("pointer", [0.3893, 0.0032], false),
        ("text", [0.4375, 0.5333], true),
        ("open-hand", [0.4375, 0.1781], false),
        ("resize-ew", [0.4881, 0.4706], true),
        ("not-allowed", [0.5, 0.5], true),
    ];

    /// Écran seul (strié) sous un zoom 1 porteur de `rotation`, curseur par défaut à la taille
    /// `size` avec les sprites livrés de `MODEL_STATES`. `model3d` : `None` = clé absente.
    fn model_scene_json(rotation: &str, model3d: Option<bool>, theme: &str, show: bool, size: f32) -> String {
        let model3d = model3d.map(|m| format!(r#","model3d":{m}"#)).unwrap_or_default();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/cursors/default").replace('\\', "/");
        let sprites: Vec<String> = MODEL_STATES
            .iter()
            .map(|(key, [hx, hy], _)| format!(r#""{key}":{{"path":"{dir}/{key}.png","hotspotX":{hx},"hotspotY":{hy}}}"#))
            .collect();
        let sprites = sprites.join(",");
        format!(
            r##"{{"clips":[{{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}}],
                "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                           "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
                "effects":{{"padding":0.2,"blur":false,"shadow":0,"roundnessFrac":0.03,"motionBlur":0}},
                "background":{{"kind":"gradient","angleDeg":135,"stops":["#5b6ee1","#e8a0bf"]}},
                "zoomRegions":[{{"clipIndex":0,"startSec":0,"endSec":10,"scale":1,"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":{rotation}}}],
                "annotations":[],
                "cursor":{{"show":{show},"size":{size},"smoothing":0,"motionBlur":0,"clickBounce":2.5{model3d},"clipToBounds":false,"theme":"{theme}",
                           "cursorSprites":{{{sprites}}}}},
                "cropByClip":[null],
                "output":{{"width":1280,"height":720,"fps":30}}}}"##
        )
    }

    /// Une frame striée de barres sombres, bleue ou orangée : rien de NEUTRE, donc un pixel gris
    /// est le curseur et un pixel teinté assombri son ombre ; un pixel identique sur les deux
    /// teintes est du curseur opaque.
    fn model_screen_planes(orange: bool) -> (Vec<u8>, Vec<u8>) {
        let (w, h) = (640u32, 360u32);
        let (u, v) = if orange { (100, 170) } else { (150, 120) };
        let y = (0..w * h)
            .map(|i| {
                let (col, row) = (i % w, i / w);
                if row % 24 >= 8 && row % 24 < 12 && (col / 40) % 3 != 2 { 90 } else { 150 }
            })
            .collect();
        let uv = (0..w * (h / 2)).map(|i| if i % 2 == 0 { u } else { v }).collect();
        (y, uv)
    }

    fn compose_model(
        comp: &Compositor,
        screen: &FakeFrame,
        json: &str,
        track: &crate::cursor::CursorTrack,
    ) -> Vec<u8> {
        let scene = crate::scene::Scene::from_json(json).expect("scene json");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_has_webcam(false);
        comp.set_scene(Some(scene));
        comp.set_cursor(track.clone());
        comp.set_cursor_time(Some(2.0));
        comp.set_timeline_time(Some(2.0));
        let mut cfg = crate::config::Cfg::c8();
        cfg.bg_blur = false;
        cfg.zoom = false;
        cfg.layout_anim = false;
        cfg.cursor = true;
        cfg.mblur_n = 1;
        cfg.shadow = false;
        unsafe {
            comp.compose_frame(screen.as_ptr(), screen.as_ptr(), 0.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback_direct").2
        }
    }

    /// Immobile en (`at`, `at`) dans l'état `kind`, avec un clic au creux de `tap` avant l'instant
    /// rendu si `click` : le modèle est alors posé.
    fn model_track(kind: &str, click: bool, at: f32) -> crate::cursor::CursorTrack {
        crate::cursor::CursorTrack::new(
            vec![(0.0, at, at), (9.0, at, at)],
            if click { vec![2.0 - 0.0495] } else { vec![] },
            vec![(0.0, kind.to_string())],
        )
    }

    fn model_save(name: &str, rgba: &[u8]) {
        let Ok(dir) = std::env::var("OPENSCREEN_CURSOR3D_OUT") else { return };
        let path = format!("{dir}/macos-{name}.png");
        image::RgbaImage::from_raw(1280, 720, rgba.to_vec())
            .expect("dimensions du readback")
            .save(&path)
            .unwrap_or_else(|e| panic!("ecriture {path} : {e}"));
    }

    fn model_neutral(p: &[u8]) -> bool {
        p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]) < 12
    }

    fn model_luma(p: &[u8]) -> f32 {
        0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32
    }

    /// Ce qui distingue la frame avec flèche de la même sans : pixels de la flèche (neutres),
    /// d'ombre (le bleu assombri, hors frange antialiasée), leurs centroïdes, et la distance de
    /// l'ombre la plus proche de l'apex (le pixel de flèche le plus haut).
    struct ModelSplit {
        white: usize,
        black: usize,
        shadow: usize,
        body_c: [f32; 2],
        shadow_c: [f32; 2],
        near_apex: f32,
    }

    fn model_split(with: &[u8], without: &[u8]) -> ModelSplit {
        let (w, h) = (1280i32, 720i32);
        let at = |buf: &[u8], x: i32, y: i32| {
            let i = ((y * w + x) * 4) as usize;
            [buf[i], buf[i + 1], buf[i + 2]]
        };
        let body = |x: i32, y: i32| {
            x >= 0 && y >= 0 && x < w && y < h && at(with, x, y) != at(without, x, y) && model_neutral(&at(with, x, y))
        };
        let mut s = ModelSplit { white: 0, black: 0, shadow: 0, body_c: [0.0; 2], shadow_c: [0.0; 2], near_apex: f32::MAX };
        let (mut nb, mut apex) = (0usize, [0i32, i32::MAX]);
        let mut shadows = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let (a, b) = (at(with, x, y), at(without, x, y));
                if a == b {
                    continue;
                }
                if model_neutral(&a) {
                    nb += 1;
                    s.white += a.iter().all(|&c| c > 200) as usize;
                    s.black += a.iter().all(|&c| c < 45) as usize;
                    s.body_c = [s.body_c[0] + x as f32, s.body_c[1] + y as f32];
                    if y < apex[1] {
                        apex = [x, y];
                    }
                } else if model_luma(&a) < model_luma(&b) - 6.0
                    && !(-2..=2).any(|dy| (-2..=2).any(|dx| body(x + dx, y + dy)))
                {
                    shadows.push([x as f32, y as f32]);
                }
            }
        }
        s.shadow = shadows.len();
        s.body_c = [s.body_c[0] / nb.max(1) as f32, s.body_c[1] / nb.max(1) as f32];
        for p in &shadows {
            s.shadow_c = [s.shadow_c[0] + p[0], s.shadow_c[1] + p[1]];
            s.near_apex = s.near_apex.min((p[0] - apex[0] as f32).hypot(p[1] - apex[1] as f32));
        }
        s.shadow_c = [s.shadow_c[0] / s.shadow.max(1) as f32, s.shadow_c[1] / s.shadow.max(1) as f32];
        s
    }

    /// Les pixels OPAQUES du curseur : identiques sur les deux teintes, différents du contenu nu.
    fn model_opaque(on_blue: &[u8], on_orange: &[u8], bare: &[u8]) -> Vec<bool> {
        (0..1280 * 720)
            .map(|i| {
                let px = |b: &[u8]| [b[i * 4], b[i * 4 + 1], b[i * 4 + 2]];
                px(on_blue) == px(on_orange) && px(on_blue) != px(bare)
            })
            .collect()
    }

    fn model_iou(a: &[bool], b: &[bool]) -> f32 {
        let inter = a.iter().zip(b).filter(|(x, y)| **x && **y).count();
        let union = a.iter().zip(b).filter(|(x, y)| **x || **y).count();
        inter as f32 / union.max(1) as f32
    }

    /// Part des pixels de `a` qui ont un pixel de `b` à `r` px au plus (norme max).
    fn model_within(a: &[bool], b: &[bool], r: i32) -> f32 {
        let near = |i: usize| {
            let (x, y) = ((i % 1280) as i32, (i / 1280) as i32);
            (-r..=r).any(|dy| {
                (-r..=r).any(|dx| {
                    let (x, y) = (x + dx, y + dy);
                    (0..1280).contains(&x) && (0..720).contains(&y) && b[(y * 1280 + x) as usize]
                })
            })
        };
        let hits: Vec<usize> = (0..a.len()).filter(|&i| a[i]).collect();
        hits.iter().filter(|&&i| near(i)).count() as f32 / hits.len().max(1) as f32
    }

    /// Parts des pixels sombres, clairs et rouges parmi ceux du masque qui tombent dans l'une
    /// des trois classes.
    fn model_palette(rgba: &[u8], mask: &[bool]) -> [f32; 3] {
        let mut c = [0usize; 3];
        for (i, _) in mask.iter().enumerate().filter(|(_, m)| **m) {
            let p = [rgba[i * 4] as i32, rgba[i * 4 + 1] as i32, rgba[i * 4 + 2] as i32];
            c[0] += (p.iter().max().unwrap() < &70) as usize;
            c[1] += (p.iter().min().unwrap() > &150) as usize;
            c[2] += (p[0] > p[1] + 60 && p[0] > p[2] + 60) as usize;
        }
        let n = c.iter().sum::<usize>().max(1) as f32;
        c.map(|k| k as f32 / n)
    }

    #[test]
    fn the_modelled_arrow_casts_its_shadow_and_touches_the_screen() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = Compositor::new_sized(&gpu, 1280, 720).expect("Compositor::new_sized");
        let (y, uv) = model_screen_planes(false);
        let screen = FakeFrame::from_planes(640, 360, &y, &uv);
        let (still, clicked) = (model_track("arrow", false, 0.45), model_track("arrow", true, 0.45));
        for (name, rotation) in [("flat", "null"), ("iso", r#""iso""#)] {
            let json = |m: Option<bool>, theme: &str, show: bool| model_scene_json(rotation, m, theme, show, 3.0);
            let bare = compose_model(&comp, &screen, &json(Some(true), "default", false), &still);
            let absent = compose_model(&comp, &screen, &json(None, "default", true), &still);
            let off = compose_model(&comp, &screen, &json(Some(false), "default", true), &still);
            let other = compose_model(&comp, &screen, &json(Some(true), "other", true), &still);
            let hover = compose_model(&comp, &screen, &json(Some(true), "default", true), &still);
            let touch = compose_model(&comp, &screen, &json(Some(true), "default", true), &clicked);
            model_save(&format!("{name}-hover"), &hover);
            model_save(&format!("{name}-touch"), &touch);
            assert!(absent == off && absent == other, "{name}: le chemin plat a change");
            assert!(absent != hover, "{name}: le reglage allume ne change rien");
            let (a, b) = (model_split(&hover, &bare), model_split(&touch, &bare));
            println!(
                "{name} : blanc {}, noir {}, ombre {} (apex a {:.1} px, posee {:.1} px), centroides {:?} / {:?}",
                a.white, a.black, a.shadow, a.near_apex, b.near_apex, a.body_c, a.shadow_c
            );
            // Taille 3 en 1280x720 : ~50 a 60 px de haut, ~1000 px de silhouette.
            assert!(a.white > 150 && a.black > 250, "{name}: matieres absentes");
            assert!(a.shadow > 300, "{name}: pas d'ombre");
            assert!(a.shadow_c[0] > a.body_c[0] && a.shadow_c[1] > a.body_c[1], "{name}: ombre pas en bas a droite");
            assert!(b.near_apex < 8.0, "{name}: posee, l'ombre est a {:.1} px de l'apex", b.near_apex);
            assert!(a.near_apex > 12.0, "{name}: en l'air, l'ombre touche l'apex ({:.1} px)", a.near_apex);
        }
    }

    /// Chaque état garde son art et sa silhouette : posé au centre de l'écran (vu de face), le
    /// modèle couvre ce que couvre le sprite plat, avec ses couleurs ; il porte une ombre en
    /// l'air, suit l'inclinaison du plan, et un autre thème (ou le réglage éteint) reste plat.
    #[test]
    fn every_modelled_state_keeps_its_art_footprint_and_shadow() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = Compositor::new_sized(&gpu, 1280, 720).expect("Compositor::new_sized");
        let (y, uv) = model_screen_planes(false);
        let blue = FakeFrame::from_planes(640, 360, &y, &uv);
        let (y, uv) = model_screen_planes(true);
        let orange = FakeFrame::from_planes(640, 360, &y, &uv);
        let json = |rotation: &str, m: Option<bool>, theme: &str, show: bool| model_scene_json(rotation, m, theme, show, 5.0);
        let bare = compose_model(&comp, &blue, &json("null", Some(true), "default", false), &model_track("arrow", false, 0.5));
        let mut failures = Vec::new();
        for (key, _, centred) in MODEL_STATES {
            let (still, clicked) = (model_track(key, false, 0.5), model_track(key, true, 0.5));
            let on = json("null", Some(true), "default", true);
            let flat = json("null", Some(false), "default", true);
            let touch = compose_model(&comp, &blue, &on, &clicked);
            let touch_b = compose_model(&comp, &orange, &on, &clicked);
            let hover = compose_model(&comp, &blue, &on, &still);
            let tilted = compose_model(&comp, &blue, &json(r#""iso""#, Some(true), "default", true), &still);
            let sprite = compose_model(&comp, &blue, &flat, &still);
            let sprite_b = compose_model(&comp, &orange, &flat, &still);
            let absent = compose_model(&comp, &blue, &json("null", None, "default", true), &still);
            let other = compose_model(&comp, &blue, &json("null", Some(true), "other", true), &still);
            model_save(&format!("art-{key}-touch"), &touch);
            model_save(&format!("art-{key}-iso"), &tilted);
            if absent != sprite || other != sprite {
                failures.push(format!("{key}: le sprite plat a change"));
            }

            let (m3d, m2d) = (model_opaque(&touch, &touch_b, &bare), model_opaque(&sprite, &sprite_b, &bare));
            let overlap = model_iou(&m3d, &m2d);
            let (near3d, near2d) = (model_within(&m3d, &m2d, 2), model_within(&m2d, &m3d, 2));
            let (pal3d, pal2d) = (model_palette(&touch, &m3d), model_palette(&sprite, &m2d));
            let area = m2d.iter().filter(|m| **m).count() as f32;
            let differs = |a: &[u8], i: usize| a[i * 4..i * 4 + 3] != bare[i * 4..i * 4 + 3];
            let shadow = (0..1280 * 720)
                .filter(|&i| {
                    let (a, b) = (&hover[i * 4..i * 4 + 3], &bare[i * 4..i * 4 + 3]);
                    differs(&hover, i) && !model_neutral(a) && model_luma(a) < model_luma(b) - 6.0
                })
                .count() as f32;
            let body = |rgba: &[u8]| (0..1280 * 720).filter(|&i| model_neutral(&rgba[i * 4..i * 4 + 3]) && differs(rgba, i)).count() as f32;
            let (flat_body, tilted_body) = (body(&hover), body(&tilted));
            println!(
                "{key} : IoU {overlap:.3}, a 2 px pres {near3d:.3} / {near2d:.3}, sprite {area} px, palette 3D {pal3d:?} / sprite {pal2d:?}, \
                 ombre {shadow} px, corps a plat {flat_body} / incline {tilted_body}"
            );
            let (min_iou, min_near, palette_tol) = if centred { (0.75, 0.98, 0.07) } else { (0.6, 0.9, 0.2) };
            if overlap <= min_iou || near3d < min_near || near2d < min_near {
                failures.push(format!("{key}: la silhouette s'ecarte du sprite (IoU {overlap}, {near3d} / {near2d})"));
            }
            for (c, (a, b)) in ["sombre", "clair", "rouge"].iter().zip(pal3d.iter().zip(pal2d.iter())) {
                if (a - b).abs() >= palette_tol {
                    failures.push(format!("{key}: part {c} {a} contre {b} dans le sprite"));
                }
            }
            if shadow <= 0.3 * area {
                failures.push(format!("{key}: pas d'ombre en l'air ({shadow} px)"));
            }
            // Le préset iso réduit le plan (unité 51,5 contre 62,6 px) et incline le modèle.
            if !(tilted_body < 0.9 * flat_body && tilted_body > 0.3 * flat_body) {
                failures.push(format!("{key}: le modele ne suit pas le plan ({tilted_body} / {flat_body})"));
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    /// Pendant de `tests/cursor_tap_render.rs` (Windows) : sous un lissage qui traîne loin
    /// derrière la souris, la pointe du modèle se pose sur la pastille rouge du clic, et l'anneau
    /// de l'impact (mode 16) l'entoure, à plat et incliné. Seule exécution du mode 16 en MSL.
    #[test]
    fn the_modelled_tip_taps_the_marked_click_target() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = Compositor::new_sized(&gpu, 1280, 720).expect("Compositor::new_sized");
        let (w, h) = (640u32, 360u32);
        // Pastille de 5 texels au centre d'un bloc de chroma : symétrique, chroma comprise.
        let (tx, ty) = (193.0f32, 129.0f32);
        let red = |x: f32, y: f32| (x - tx).hypot(y - ty) <= 5.0;
        let (mut yp, mut uvp) = model_screen_planes(false);
        for row in 0..h {
            for col in 0..w {
                // Un carré uni autour de la cible : l'anneau s'y mesure sans les barres.
                if (col as f32 - tx).abs() < 45.0 && (row as f32 - ty).abs() < 45.0 {
                    yp[(row * w + col) as usize] = 150;
                }
                if red(col as f32 + 0.5, row as f32 + 0.5) {
                    yp[(row * w + col) as usize] = 63;
                }
            }
        }
        for row in 0..h / 2 {
            for col in 0..w / 2 {
                if red(2.0 * col as f32 + 1.0, 2.0 * row as f32 + 1.0) {
                    let i = (row * w + 2 * col) as usize;
                    uvp[i] = 102;
                    uvp[i + 1] = 240;
                }
            }
        }
        let screen = FakeFrame::from_planes(w, h, &yp, &uvp);
        // Arrivée sur la cible à 1,7 s, départ à 2,1 s, clic à `tc` entre les deux ; lissé à 0,5.
        let target = (tx / w as f32, ty / h as f32);
        let gesture = |tc: f32| {
            let samples = (0..=240)
                .map(|k| {
                    let t = k as f32 / 60.0;
                    let (x, y) = if t < 1.7 {
                        let f = t / 1.7;
                        (0.1 + (target.0 - 0.1) * f, 0.8 + (target.1 - 0.8) * f)
                    } else if t < 2.1 {
                        target
                    } else {
                        let f = ((t - 2.1) / 0.5).min(1.0);
                        (target.0 + 0.3 * f, target.1 + 0.2 * f)
                    };
                    (t, x, y)
                })
                .collect();
            crate::cursor::CursorTrack::new(samples, vec![tc], vec![(0.0, "arrow".to_string())]).smoothed(0.5)
        };
        let (contact, ring) = (gesture(2.0 - 0.0495), gesture(2.0 - 0.16));
        let px = |b: &[u8], x: i32, y: i32| {
            let i = ((y * 1280 + x) * 4) as usize;
            [b[i] as i32, b[i + 1] as i32, b[i + 2] as i32]
        };
        let is_red = |p: [i32; 3]| p[0] > p[1] + 60 && p[0] > p[2] + 60;
        for rotation in ["null", r#""iso""#] {
            let json = model_scene_json(rotation, Some(true), "default", true, 3.0);
            let hidden = json.replace(r#""rotation":"#, r#""hideCursor":true,"rotation":"#);
            let quiet = json.replace(r#""clickBounce":2.5"#, r#""clickBounce":0"#);
            let bare = compose_model(&comp, &screen, &hidden, &contact);
            let (mut sx, mut sy, mut n) = (0.0f32, 0.0f32, 0.0f32);
            for y in 0..720 {
                for x in 0..1280 {
                    if is_red(px(&bare, x, y)) {
                        (sx, sy, n) = (sx + x as f32 + 0.5, sy + y as f32 + 0.5, n + 1.0);
                    }
                }
            }
            assert!(n > 10.0, "{rotation}: pastille introuvable");
            let m = [sx / n, sy / n];
            let touch = compose_model(&comp, &screen, &json, &contact);
            model_save(&format!("tap-{}", if rotation == "null" { "flat" } else { "iso" }), &touch);
            assert!(!is_red(px(&touch, m[0] as i32, (m[1] + 2.0) as i32)), "{rotation}: la pointe manque la pastille");
            // L'écart dû à l'impact, le long de deux demi-droites (haut, gauche) : même rayon, à la
            // perspective près sous `iso` (l'anneau y est une ellipse).
            let (on, off) = (compose_model(&comp, &screen, &json, &ring), compose_model(&comp, &screen, &quiet, &ring));
            let peak = |dx: i32, dy: i32| {
                (4..45)
                    .map(|r| {
                        let (a, b) = (px(&on, m[0] as i32 + dx * r, m[1] as i32 + dy * r), px(&off, m[0] as i32 + dx * r, m[1] as i32 + dy * r));
                        ((0..3).map(|c| (a[c] - b[c]).abs()).sum::<i32>(), r)
                    })
                    .max()
                    .unwrap()
            };
            let (up, left) = (peak(0, -1), peak(-1, 0));
            println!("{rotation} : pastille en {m:?}, anneau haut {up:?}, gauche {left:?}");
            assert!(up.0 > 60 && left.0 > 60, "{rotation}: anneau absent ({up:?} {left:?})");
            let tol = if rotation == "null" { 1 } else { 2 };
            assert!((up.1 - left.1).abs() <= tol, "{rotation}: anneau décentré ({up:?} {left:?})");
        }
    }

    /// Le pendant macOS de `compositor_windows`'s `every_shader_entry_point_compiles`.
    ///
    /// `shaders.metal` est compilé À L'EXÉCUTION par `new_library_with_source` : une
    /// erreur de syntaxe MSL ne se voit donc jamais au `cargo build`, seulement au
    /// premier `Compositor::new` — c'est-à-dire quand un utilisateur ouvre l'éditeur.
    /// Ce test la fait remonter au `cargo test`.
    #[test]
    fn every_shader_entry_point_compiles() {
        let Some(device) = metal::Device::system_default() else {
            eprintln!("pas de MTLDevice (CI sans GPU) — test sauté");
            return;
        };
        let library = device
            .new_library_with_source(
                include_str!("shaders.metal"),
                &metal::CompileOptions::new(),
            )
            .expect("shaders.metal doit compiler");
        for name in [
            "vs_main",
            "vs_fs",
            "ps_main",
            "ps_y",
            "ps_uv",
            "ps_blur",
            "ps_tex",
            "ps_kawase_down",
            "ps_kawase_up",
        ] {
            library
                .get_function(name, None)
                .unwrap_or_else(|e| panic!("entry point {name} absent de la library : {e}"));
        }
    }

    /// Les quatre pipeline states que `new_sized` construit doivent être acceptés par
    /// Metal : c'est là que se voient les désaccords entre la signature d'un shader et
    /// la pièce jointe couleur qu'on lui donne (format, blend), qui ne sont PAS des
    /// erreurs de compilation MSL.
    #[test]
    fn the_compositor_builds_on_the_system_device() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 640, 360).expect("Compositor::new_sized");
        assert_eq!(comp.render_size(), (640, 360));
    }
}
