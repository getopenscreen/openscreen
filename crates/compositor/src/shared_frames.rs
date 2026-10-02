//! Livraison de la preview par textures partagées : le thread de rendu copie chaque frame
//! composée dans l'une des textures d'un petit anneau, et Electron l'importe côté GPU
//! (`sharedTexture.importSharedTexture`) au lieu d'en recevoir les pixels. Plus de `Map`
//! qui attend le GPU puis recopie l'image en RAM, plus de `Vec<u8>` de plusieurs Mo par frame
//! à travers l'IPC : mesuré, ce transport coûtait à lui seul 37 à 55 % du thread principal
//! du renderer à 30 images/s.
//!
//! Deux moitiés :
//!   - `SlotBook`, portable et sans GPU : quelle case porte la frame prête, lesquelles
//!     Chromium tient encore. Partagé entre le thread de rendu (`claim`, `publish`) et le
//!     thread Node (`take`, `release`).
//!   - `SharedRing` (Windows, backend matériel) : les textures D3D11 et leurs handles NT.
//!     macOS (IOSurface) et Linux (dmabuf) restent sur le readback.

use crate::frame_geometry::FootageQuad;
use crate::live::FramePosition;
use std::time::{Duration, Instant};

/// Cases de l'anneau : une prête, une en transit vers le renderer (tenue jusqu'à ce que
/// Chromium la relâche), une en écriture, et une de marge pour la latence de la libération.
pub const RING_SLOTS: u32 = 4;

/// Une case tenue plus longtemps que ça a perdu sa libération (renderer rechargé, import
/// échoué en route) : Chromium relâche les autres dans la milliseconde. Même ordre que le
/// délai d'Electron sur `sendSharedTexture` (1 s).
pub const LOST_SLOT_AFTER: Duration = Duration::from_secs(1);

/// Une frame composée posée dans une case de l'anneau, telle que JS la reçoit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SharedFrame {
    /// Même compteur que les frames lues en RAM : le consommateur ne voit qu'une suite de
    /// générations, quel que soit le transport.
    pub gen: u64,
    pub slot: u32,
    /// Valeur du handle NT de la texture de la case, valable dans CE processus. Electron le
    /// duplique à l'import : la case garde le sien.
    pub handle: u64,
    pub width: u32,
    pub height: u32,
    pub footage: Option<FootageQuad>,
    pub position: FramePosition,
}

/// Une case prise par JS : la génération qu'elle porte et quand elle est partie.
#[derive(Debug, Clone, Copy)]
struct Held {
    slot: u32,
    gen: u64,
    since: Instant,
}

/// Qui tient quelle case de l'anneau.
#[derive(Debug, Default)]
pub struct SlotBook {
    /// La dernière frame publiée, que JS n'a pas encore prise.
    ready: Option<SharedFrame>,
    /// Les cases prises par JS, que Chromium n'a pas encore relâchées, plus anciennes d'abord.
    held: Vec<Held>,
}

impl SlotBook {
    /// La case où écrire la prochaine frame. Une case libre d'abord ; à défaut, celle de la
    /// frame prête que personne n'a prise, retirée puisqu'elle est périmée. `None` quand
    /// Chromium tient toutes les cases : une case tenue n'est jamais réécrite, même perdue
    /// (`lost`), puisqu'il peut encore la lire.
    pub fn claim(&mut self, slots: u32) -> Option<u32> {
        let ready = self.ready.map(|frame| frame.slot);
        let is_held = |slot: u32| self.held.iter().any(|held| held.slot == slot);
        if let Some(free) = (0..slots).find(|slot| !is_held(*slot) && Some(*slot) != ready) {
            return Some(free);
        }
        if let Some(stale) = ready {
            self.ready = None;
            return Some(stale);
        }
        None
    }

    /// Une case est tenue depuis `LOST_SLOT_AFTER` : sa libération ne viendra plus.
    pub fn lost(&self, now: Instant) -> bool {
        self.held.first().is_some_and(|held| now.duration_since(held.since) >= LOST_SLOT_AFTER)
    }

    pub fn publish(&mut self, frame: SharedFrame) {
        self.ready = Some(frame);
    }

    /// La frame prête, si elle est plus récente que `since_gen`. Sa case reste tenue jusqu'à
    /// `release` : le thread de rendu n'y écrira plus d'ici là.
    pub fn take(&mut self, since_gen: u64, now: Instant) -> Option<SharedFrame> {
        let frame = self.ready.filter(|frame| frame.gen > since_gen)?;
        self.ready = None;
        self.held.push(Held { slot: frame.slot, gen: frame.gen, since: now });
        Some(frame)
    }

    /// Chromium a relâché la frame `gen` de la case `slot`. La génération évite qu'une
    /// libération en double ne libère la frame suivante posée dans la même case.
    pub fn release(&mut self, slot: u32, gen: u64) {
        self.held.retain(|held| held.slot != slot || held.gen != gen);
    }

    /// Oublie la frame prête : la vue repasse au readback, personne ne viendra la prendre.
    pub fn clear_ready(&mut self) {
        self.ready = None;
    }
}

#[cfg(windows)]
pub use ring::SharedRing;

#[cfg(windows)]
mod ring {
    use super::RING_SLOTS;
    use crate::d3d::Gpu;
    use anyhow::{bail, Result};
    use std::time::{Duration, Instant};
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE};
    use windows::Win32::Graphics::Direct3D11::{
        ID3D11Device, ID3D11DeviceContext, ID3D11Query, ID3D11Texture2D,
        D3D11_ASYNC_GETDATA_DONOTFLUSH, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
        D3D11_QUERY_DESC, D3D11_QUERY_EVENT, D3D11_RESOURCE_MISC_SHARED,
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::{
        IDXGIResource1, DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE,
    };

    /// Au-delà, le GPU est bloqué ou perdu : on rend une erreur plutôt que de geler la vue.
    const COPY_TIMEOUT: Duration = Duration::from_millis(500);

    struct SlotTexture {
        tex: ID3D11Texture2D,
        handle: HANDLE,
        width: u32,
        height: u32,
    }

    impl Drop for SlotTexture {
        fn drop(&mut self) {
            // Electron importe un duplicata du handle : fermer le nôtre ne retire rien à une
            // frame que Chromium affiche encore.
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }

    /// Les textures partagées d'une vue live, créées à la demande à la taille du rendu.
    pub struct SharedRing {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        copied: ID3D11Query,
        slots: Vec<Option<SlotTexture>>,
    }

    impl SharedRing {
        pub fn new(gpu: &Gpu) -> Result<SharedRing> {
            let desc = D3D11_QUERY_DESC { Query: D3D11_QUERY_EVENT, MiscFlags: 0 };
            let mut copied = None;
            unsafe { gpu.device.CreateQuery(&desc, Some(&mut copied))? };
            Ok(SharedRing {
                device: gpu.device.clone(),
                context: gpu.context.clone(),
                copied: copied.expect("CreateQuery a réussi sans requête"),
                slots: (0..RING_SLOTS).map(|_| None).collect(),
            })
        }

        /// Copie `src` (`width`×`height`, RGBA8) dans la case `slot` et rend le handle de sa
        /// texture une fois le GPU arrivé au bout de la copie. Chromium la lit depuis son propre
        /// device, sans keyed mutex : quand le handle part, plus rien ne doit y écrire. L'attente
        /// est celle que faisait déjà le `Map` du readback, la recopie en RAM en moins.
        ///
        /// La case ne doit être ni prête ni tenue (`SlotBook::claim`) : sa texture peut être
        /// recréée ici quand la taille du rendu a changé.
        pub unsafe fn write(
            &mut self,
            slot: u32,
            src: &ID3D11Texture2D,
            width: u32,
            height: u32,
        ) -> Result<u64> {
            let entry = &mut self.slots[slot as usize];
            if !matches!(entry, Some(texture) if texture.width == width && texture.height == height) {
                *entry = Some(create_slot(&self.device, width, height)?);
            }
            let target = entry.as_ref().expect("case créée juste au-dessus");
            self.context.CopyResource(&target.tex, src);
            self.context.End(&self.copied);
            self.context.Flush();
            let deadline = Instant::now() + COPY_TIMEOUT;
            loop {
                let mut done = BOOL(0);
                self.context.GetData(
                    &self.copied,
                    Some(&mut done as *mut BOOL as *mut core::ffi::c_void),
                    std::mem::size_of::<BOOL>() as u32,
                    D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32,
                )?;
                if done.as_bool() {
                    break;
                }
                if Instant::now() > deadline {
                    bail!("le GPU n'a pas fini de copier la frame en {COPY_TIMEOUT:?}");
                }
                std::thread::yield_now();
            }
            Ok(target.handle.0 as u64)
        }
    }

    unsafe fn create_slot(device: &ID3D11Device, width: u32, height: u32) -> Result<SlotTexture> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            // Le format du RT composé : la copie est un `CopyResource`, sans conversion.
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            // Handle NT, le seul qu'Electron importe, sans keyed mutex : `write` attend la fin
            // de la copie avant de le livrer.
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED.0 | D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0) as u32,
        };
        let mut tex = None;
        device.CreateTexture2D(&desc, None, Some(&mut tex))?;
        let tex = tex.expect("CreateTexture2D a réussi sans texture");
        let resource: IDXGIResource1 = tex.cast()?;
        let handle = resource.CreateSharedHandle(
            None,
            DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
            PCWSTR::null(),
        )?;
        Ok(SlotTexture { tex, handle, width, height })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(gen: u64, slot: u32) -> SharedFrame {
        SharedFrame {
            gen,
            slot,
            handle: 0,
            width: 2,
            height: 2,
            footage: None,
            position: FramePosition { clip_index: 0, source_time_sec: 0.0 },
        }
    }

    /// Toutes les cases prises par JS, la case `n` portant la génération `n + 1`.
    fn all_held(now: Instant) -> SlotBook {
        let mut book = SlotBook::default();
        for slot in 0..RING_SLOTS {
            book.publish(frame(u64::from(slot) + 1, slot));
            assert!(book.take(u64::from(slot), now).is_some());
        }
        book
    }

    #[test]
    fn claims_a_free_slot_before_a_ready_one() {
        let now = Instant::now();
        let mut book = SlotBook::default();
        book.publish(frame(1, 0));
        assert_eq!(book.claim(RING_SLOTS), Some(1));
        // La frame prête n'a pas bougé : JS peut toujours la prendre.
        assert_eq!(book.take(0, now), Some(frame(1, 0)));
    }

    #[test]
    fn a_taken_slot_is_never_written_until_released() {
        let now = Instant::now();
        let mut book = all_held(now);
        assert_eq!(book.claim(RING_SLOTS), None, "Chromium tient toutes les cases");
        book.release(2, 3);
        assert_eq!(book.claim(RING_SLOTS), Some(2));
    }

    #[test]
    fn a_frame_nobody_took_gives_its_slot_back_when_nothing_else_is_free() {
        let now = Instant::now();
        let mut book = SlotBook::default();
        for slot in 0..RING_SLOTS - 1 {
            book.publish(frame(u64::from(slot) + 1, slot));
            book.take(u64::from(slot), now);
        }
        book.publish(frame(9, 3));
        assert_eq!(book.claim(RING_SLOTS), Some(3));
        // Retirée : la livrer maintenant, pendant qu'on la réécrit, donnerait une image déchirée.
        assert_eq!(book.take(0, now), None);
    }

    #[test]
    fn take_hands_out_only_newer_generations() {
        let now = Instant::now();
        let mut book = SlotBook::default();
        book.publish(frame(5, 1));
        assert_eq!(book.take(5, now), None);
        assert_eq!(book.take(4, now), Some(frame(5, 1)));
        assert_eq!(book.take(0, now), None, "déjà prise");
    }

    #[test]
    fn a_release_only_frees_the_generation_it_names() {
        let now = Instant::now();
        let mut book = SlotBook::default();
        book.publish(frame(1, 0));
        book.take(0, now);
        book.release(3, 1);
        book.release(0, 7);
        assert_eq!(book.claim(1), None, "ni la case 3 ni la génération 7 ne sont tenues");
        book.release(0, 1);
        assert_eq!(book.claim(1), Some(0));
    }

    #[test]
    fn a_slot_whose_release_never_came_is_reported_lost_but_never_rewritten() {
        let start = Instant::now();
        let mut book = all_held(start);
        assert!(!book.lost(start + LOST_SLOT_AFTER / 2));
        assert!(book.lost(start + LOST_SLOT_AFTER));
        // Chromium peut encore lire une case perdue : la réécrire déchirerait son image.
        assert_eq!(book.claim(RING_SLOTS), None);
        // Si sa libération finit par venir, la case sert de nouveau.
        book.release(0, 1);
        assert_eq!(book.claim(RING_SLOTS), Some(0));
    }
}
