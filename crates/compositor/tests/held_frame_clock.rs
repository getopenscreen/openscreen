//! Not run in CI: needs a GPU and a video source, otherwise it skips. Any MP4 of 4 s or more:
//!
//! ```sh
//! OPENSCREEN_LIVE_SOURCE=/path/source.mp4 cargo test -p openscreen-compositor --test held_frame_clock -- --nocapture
//! ```
//!
//! The camera test also needs `OPENSCREEN_LIVE_WEBCAM`, a camera file with a frame between 1 s and
//! 1.25 s (any constant-frame-rate recording). The source itself does not count as a camera.

#![cfg(any(windows, target_os = "macos"))]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::live::Player;
use openscreen_compositor::scene::Scene;

fn scene_json(source: &str) -> String {
    let s = source.replace('\\', "/");
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":100000,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#303030"}},
        "zoomRegions": [],
        "speedRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":480,"height":270,"fps":30}}
    }}"##
    )
}

#[test]
fn a_held_frame_follows_the_playback_clock() {
    let Ok(source) = std::env::var("OPENSCREEN_LIVE_SOURCE") else {
        println!("SKIP: set OPENSCREEN_LIVE_SOURCE (see the file header).");
        return;
    };
    let gpu = Gpu::create(false).expect("device");
    let mut cfg = config::all().pop().expect("at least one config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(&gpu, 480, 270).expect("compositor");
    let scene = Scene::from_json(&scene_json(&source)).expect("valid scene");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene.clone()));
    comp.clear_cursor();

    unsafe {
        let mut player = Player::open(&source, "", &gpu).expect("open the source");
        player.set_programme_clock(Some(&scene), 0);
        assert!(player.present_frame(&comp, &cfg, 1.0).expect("seek"), "paused seek");
        let held = player.screen_time_sec();
        let at_pts = player.programme_time().expect("programme clock");

        comp.set_programme_time(None);
        assert!(player.recompose_at(&comp, &cfg, held + 0.25).expect("recompose_at"));
        let advanced = comp.programme_time().expect("recompose_at did not set the programme time");
        assert_eq!(player.screen_time_sec(), held, "the screen frame must stay the held one");
        assert_eq!(player.composed_time_sec(), held + 0.25, "the published position follows the clock");
        assert!(
            (advanced as f64 - at_pts as f64 - 0.25).abs() < 1e-3,
            "programme time {advanced} instead of {at_pts} + 0.25 s"
        );

        comp.set_programme_time(None);
        assert!(player.recompose(&comp, &cfg).expect("recompose"));
        assert_eq!(comp.programme_time(), Some(at_pts), "recompose stays at the pts");
        assert_eq!(player.composed_time_sec(), held);
    }
}

#[test]
fn a_held_frame_advances_the_camera_to_the_clock() {
    let (Ok(source), Ok(camera)) =
        (std::env::var("OPENSCREEN_LIVE_SOURCE"), std::env::var("OPENSCREEN_LIVE_WEBCAM"))
    else {
        println!("SKIP: set OPENSCREEN_LIVE_SOURCE and OPENSCREEN_LIVE_WEBCAM (file header).");
        return;
    };
    let gpu = Gpu::create(false).expect("device");
    let mut cfg = config::all().pop().expect("at least one config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(&gpu, 480, 270).expect("compositor");
    let scene = Scene::from_json(&scene_json(&source)).expect("valid scene");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene.clone()));
    comp.clear_cursor();

    unsafe {
        let mut player = Player::open(&source, &camera, &gpu).expect("open the source");
        assert!(player.webcam_decoder_is_real(), "the camera file must open");
        player.set_programme_clock(Some(&scene), 0);
        assert!(player.present_frame(&comp, &cfg, 1.0).expect("seek"), "paused seek");
        let held = player.screen_time_sec();
        let camera_before = player.webcam_time_sec();

        let clock = held + 0.25;
        assert!(player.hold_at(&comp, &cfg, clock).expect("hold_at"));
        assert_eq!(player.screen_time_sec(), held, "the screen frame must stay the held one");
        let camera_after = player.webcam_time_sec();
        assert!(
            camera_after > camera_before,
            "the camera stood still at {camera_before:.3} s through the hold"
        );
        assert!(
            camera_after <= clock + 1e-6,
            "camera at {camera_after:.3} s, ahead of the clock {clock:.3} s"
        );
    }
}
