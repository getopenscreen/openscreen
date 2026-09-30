use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::ffi::AVFrame;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_WRITE,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_WRITE_DISCARD, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DYNAMIC,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};

pub fn gpu() -> Option<Gpu> {
    match Gpu::create(false) {
        Ok(g) => Some(g),
        Err(e) => {
            eprintln!("pas de device D3D11 matériel ({e:#}) — test saute");
            None
        }
    }
}

pub struct Nv12Frame {
    frame: Box<AVFrame>,
    _tex: ID3D11Texture2D,
}

impl Nv12Frame {
    pub fn new(
        gpu: &Gpu,
        (w, h): (u32, u32),
        luma: impl Fn(u32, u32) -> u8,
        chroma: impl Fn(u32, u32) -> [u8; 2],
    ) -> Nv12Frame {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DYNAMIC,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
            MiscFlags: 0,
        };
        unsafe {
            let mut tex: Option<ID3D11Texture2D> = None;
            gpu.device.CreateTexture2D(&desc, None, Some(&mut tex)).expect("texture NV12");
            let tex = tex.expect("texture NV12");
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            gpu.context.Map(&tex, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut m)).expect("Map");
            let pitch = m.RowPitch as usize;
            let dst = m.pData as *mut u8;
            for row in 0..h {
                for col in 0..w {
                    *dst.add(row as usize * pitch + col as usize) = luma(col, row);
                }
            }
            for by in 0..h / 2 {
                for bx in 0..w / 2 {
                    let [cb, cr] = chroma(bx, by);
                    let uv = (h + by) as usize * pitch + 2 * bx as usize;
                    *dst.add(uv) = cb;
                    *dst.add(uv + 1) = cr;
                }
            }
            gpu.context.Unmap(&tex, 0);
            let mut frame: Box<AVFrame> = Box::new(std::mem::zeroed());
            frame.data[0] = tex.as_raw() as *mut u8;
            frame.data[1] = std::ptr::null_mut();
            frame.width = w as i32;
            frame.height = h as i32;
            Nv12Frame { frame, _tex: tex }
        }
    }

    pub fn as_ptr(&self) -> *const AVFrame {
        &*self.frame as *const AVFrame
    }
}
