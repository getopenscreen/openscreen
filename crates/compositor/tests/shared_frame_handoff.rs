//! La texture qu'une vue live livre par handle NT, rouverte par un AUTRE device D3D11 — la
//! place qu'occupe le processus GPU de Chromium quand Electron l'importe. Ce que le
//! consommateur lit doit être exactement ce que le compositeur a composé : pas une image
//! à moitié copiée, pas une case périmée, et une case redimensionnée doit livrer un handle
//! neuf à la nouvelle taille.
//!
//! Demande un device matériel : saute sans lui (runner sans adaptateur).

#![cfg(windows)]

use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::shared_frames::SharedRing;
use windows::core::Interface;
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11Device1, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_FLAG,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};

fn pattern(width: u32, height: u32, seed: u8) -> Vec<u8> {
    (0..width * height)
        .flat_map(|i| {
            let (x, y) = (i % width, i / width);
            [x as u8 ^ seed, y as u8, seed, 255]
        })
        .collect()
}

fn texture_with(gpu: &Gpu, width: u32, height: u32, pixels: &[u8]) -> ID3D11Texture2D {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_R8G8B8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let init = D3D11_SUBRESOURCE_DATA {
        pSysMem: pixels.as_ptr().cast(),
        SysMemPitch: width * 4,
        SysMemSlicePitch: 0,
    };
    let mut tex = None;
    unsafe { gpu.device.CreateTexture2D(&desc, Some(&init), Some(&mut tex)) }.expect("texture");
    tex.expect("texture")
}

/// Le second device, sans rien de commun avec celui du compositeur que l'adaptateur.
fn consumer() -> (ID3D11Device, ID3D11DeviceContext) {
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            Some(&[D3D_FEATURE_LEVEL_11_1]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .expect("second device");
    (device.unwrap(), context.unwrap())
}

/// Ce que le consommateur lit à travers le handle, en RGBA serré.
fn read_through(handle: u64, width: u32, height: u32) -> Vec<u8> {
    let (device, context) = consumer();
    let device1: ID3D11Device1 = device.cast().expect("ID3D11Device1");
    let shared: ID3D11Texture2D =
        unsafe { device1.OpenSharedResource1(HANDLE(handle as *mut core::ffi::c_void)) }
            .expect("le handle doit s'ouvrir depuis un autre device");
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { shared.GetDesc(&mut desc) };
    assert_eq!((desc.Width, desc.Height), (width, height));
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    desc.MiscFlags = 0;
    let mut staging = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }.expect("staging");
    let staging = staging.unwrap();
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    let mut out = vec![0u8; (width * height * 4) as usize];
    unsafe {
        context.CopyResource(&staging, &shared);
        context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).expect("map");
        for y in 0..height as usize {
            std::ptr::copy_nonoverlapping(
                (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                out.as_mut_ptr().add(y * width as usize * 4),
                width as usize * 4,
            );
        }
        context.Unmap(&staging, 0);
    }
    out
}

#[test]
fn another_device_reads_exactly_the_composed_frame() {
    let Ok(gpu) = Gpu::create(false) else {
        eprintln!("pas de device D3D11 matériel — saute");
        return;
    };
    let mut ring = SharedRing::new(&gpu).expect("anneau");

    let (w, h) = (64, 36);
    let first = pattern(w, h, 0x11);
    let handle = unsafe { ring.write(0, &texture_with(&gpu, w, h, &first), w, h) }.expect("écriture");
    assert_eq!(read_through(handle, w, h), first);

    // La même case réécrite : même texture, même handle, nouveau contenu.
    let second = pattern(w, h, 0x22);
    let again = unsafe { ring.write(0, &texture_with(&gpu, w, h, &second), w, h) }.expect("réécriture");
    assert_eq!(again, handle);
    assert_eq!(read_through(again, w, h), second);

    // Le rendu change de taille : la case est recréée, avec un handle à la nouvelle taille.
    let (w2, h2) = (32, 18);
    let resized = pattern(w2, h2, 0x33);
    let fresh = unsafe { ring.write(0, &texture_with(&gpu, w2, h2, &resized), w2, h2) }.expect("taille");
    assert_eq!(read_through(fresh, w2, h2), resized);
}
