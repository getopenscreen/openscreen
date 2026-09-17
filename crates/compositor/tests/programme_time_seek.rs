//! Le temps programme de la preview est une fonction de l'image affichée : y arriver en
//! lecture libre (`Player::step`) ou par un seek (`Player::present_frame`) donne le même.
//!
//! Rend de vraies frames par le compositeur D3D11, sur une vraie source (pts réels du
//! décodeur). Vérifie la valeur que le compositeur a REÇUE (celle que lit `plan_frame`), pas
//! celle du player : le lien Player -> Compositor n'a pas de test sans GPU.
//!
//! La CI ne le joue pas : il faut D3D11 et une source vidéo, sinon il se saute. Piloté par l'environnement, comme `privacy_blur_under_zoom.rs`, dont il réutilise
//! la source (n'importe quel MP4 d'au moins 6 s convient) :
//!
//! ```powershell
//! $env:OPENSCREEN_PRIVACY_SECRET = "...\secret.mp4"
//! cargo test -p openscreen-compositor --test programme_time_seek -- --nocapture
//! ```

// Windows seulement : le décodage D3D11VA de ce harnais n'existe que là.
#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::live::Player;
use openscreen_compositor::scene::Scene;

/// Deux coupes du même fichier, la seconde jouée par le player, avec une région 2× dedans :
/// le temps programme doit compter la durée de sortie de la première et la vitesse.
fn scene_json(source: &str) -> String {
    let s = source.replace('\\', "/");
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":1.5,"webcamOffsetSec":0,"hasAudio":false}},
                  {{"screenPath":"{s}","webcamPath":"","sourceStartSec":2,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#303030"}},
        "zoomRegions": [],
        "speedRegions": [{{"clipIndex":1,"startSec":3,"endSec":4,"speed":2}}],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null, null],
        "output": {{"width":480,"height":270,"fps":30}}
    }}"##
    )
}

#[test]
fn playback_and_seek_give_the_same_programme_time() {
    let Ok(source) = std::env::var("OPENSCREEN_PRIVACY_SECRET") else {
        println!("SKIP: definir OPENSCREEN_PRIVACY_SECRET (voir l'en-tete du fichier).");
        return;
    };
    let gpu = Gpu::create(false).expect("device d3d11");
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(&gpu, 480, 270).expect("compositor");
    let scene = Scene::from_json(&scene_json(&source)).expect("scene valide");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene.clone()));
    comp.clear_cursor();

    unsafe {
        let mut player = Player::open(&source, "", &gpu).expect("ouvrir la source");
        player.set_programme_clock(Some(&scene), 1);

        // Lecture libre depuis le début du clip 1, une image à la fois.
        assert!(player.present_frame(&comp, &cfg, 2.0).expect("seek initial"));
        // Horloge de lecture avancée à pas fixe, comme l'accumulateur de `render_thread`.
        let mut played = Vec::new();
        let mut target = 2.0;
        while target < 5.0 {
            target += 1.0 / 60.0;
            // Effacé avant chaque appel : c'est l'appel lui-même qui doit le poser.
            comp.set_programme_time(None);
            if player.step(&comp, &cfg, target).expect("step") {
                let programme = comp.programme_time().expect("step n'a pas transmis le temps programme");
                assert_eq!(Some(programme), player.programme_time(), "garde : compositeur et player divergent");
                played.push((player.screen_time_sec(), programme));
            }
        }
        assert!(played.len() > 60, "garde : trop peu d'images jouées ({})", played.len());

        // Les mêmes images, atteintes par un seek.
        for &(pts, programme) in played.iter().step_by(7) {
            comp.set_programme_time(None);
            assert!(player.present_frame(&comp, &cfg, pts).expect("seek"));
            assert_eq!(player.screen_time_sec(), pts, "garde : le seek doit retomber sur l'image");
            let sought = comp.programme_time().expect("le seek n'a pas transmis le temps programme");
            assert_eq!(sought.to_bits(), programme.to_bits(), "pts {pts} : lecture {programme}, seek {sought}");
        }

        // Le clip 0 dure 1,5 s en sortie ; la région 2× compresse 3..4 s en 0,5 s.
        let at = |pts: f64| played.iter().find(|(t, _)| (*t - pts).abs() < 1e-3).map(|p| p.1);
        let first = played[0];
        println!("premiere image : pts {} -> programme {}", first.0, first.1);
        assert!((first.1 as f64 - (1.5 + (first.0 - 2.0))).abs() < 1e-4);
        if let (Some(a), Some(b)) = (at(3.0), at(4.0)) {
            assert!((b - a - 0.5).abs() < 1e-4, "2x : 3..4 s source -> {} s programme", b - a);
        }
        let last = played[played.len() - 1];
        println!("derniere image : pts {} -> programme {}", last.0, last.1);
        assert!((last.1 as f64 - (1.5 + 1.0 + 0.5 + (last.0 - 4.0))).abs() < 1e-4);
    }
}
