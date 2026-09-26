//! Les polices du texte (sous-titres et annotations) : celles que l'app embarque, et elles seules.
//!
//! Les trois backends cherchaient la famille demandée parmi les polices INSTALLÉES sur la
//! machine, alors que l'app proposait des familles qu'elle n'installait nulle part. Sur une
//! machine qui ne les avait pas, chaque choix retombait sur la même police de repli, et changer
//! de police ne changeait rien à l'écran.
//!
//! Les fichiers vivent dans `public/fonts`. L'app pose `OPENSCREEN_FONTS_DIR` sur leur dossier
//! avant de charger l'addon (`compositorViewService.ts`, même contrat que `ORT_DYLIB_PATH`), et
//! chaque backend les enregistre pour ce processus seulement, sans rien installer : collection
//! privée pour DirectWrite, portée processus pour CoreText, base `fontdb` pour cosmic-text.
//! Sur macOS et Linux, une police installée qui porte le même nom peut passer devant la nôtre :
//! c'est alors la même famille dans une autre version, jamais un repli.
//!
//! Sans la variable (POC, addon chargé hors de l'app), la liste est vide et le texte se dessine
//! avec les polices du système, comme avant.

use std::path::{Path, PathBuf};

/// Posée par l'app : le dossier des polices embarquées.
pub const FONTS_DIR_ENV: &str = "OPENSCREEN_FONTS_DIR";

/// Les fichiers de police embarqués, ou aucun si l'app n'a pas indiqué leur dossier.
pub fn embedded_font_files() -> Vec<PathBuf> {
    std::env::var_os(FONTS_DIR_ENV)
        .map(|dir| font_files_in(Path::new(&dir)))
        .unwrap_or_default()
}

/// Les `.ttf` et `.otf` de `dir`, triés. Le dossier porte aussi les licences OFL, qui ne sont
/// pas des polices. Un dossier illisible donne une liste vide : mieux vaut les polices du
/// système que pas de texte du tout.
pub fn font_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or_default();
            ext.eq_ignore_ascii_case("ttf") || ext.eq_ignore_ascii_case("otf")
        })
        .collect();
    files.sort();
    files
}

/// `public/fonts` du dépôt, pour les tests des trois backends.
#[cfg(test)]
pub(crate) fn repo_fonts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/fonts")
}

/// Les familles embarquées, telles que l'app les stocke. Miroir de `TEXT_FONT_FAMILIES`
/// (`src/lib/textFonts.ts`), dont le test vérifie que chaque fichier porte bien ce nom.
#[cfg(test)]
pub(crate) const SHIPPED_FAMILIES: [&str; 5] =
    ["Inter", "Lora", "Oswald", "Caveat", "IBM Plex Mono"];

/// Chaque famille se voit : deux familles se confondent quand elles dessinent le même bloc,
/// même largeur ET même hauteur à 2 % près, et un repli commun les confondrait toutes. La
/// largeur seule ne suffit pas : Inter et Lora ne diffèrent que d'1 % sur « Hamburgefonstiv ».
#[cfg(test)]
pub(crate) fn assert_distinct_blocks(blocks: &[(&str, f32, f32)]) {
    let close = |a: f32, b: f32| (a - b).abs() <= a.min(b) * 0.02;
    for (i, (a, wa, ha)) in blocks.iter().enumerate() {
        for (b, wb, hb) in &blocks[i + 1..] {
            assert!(
                !(close(*wa, *wb) && close(*ha, *hb)),
                "{a} et {b} dessinent le même bloc : {blocks:?}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_font_files_of_the_directory_are_registered() {
        let dir = repo_fonts_dir();
        let files = font_files_in(&dir);
        // Régulier et gras de chaque famille : les deux graisses qu'un contrôle peut produire.
        assert_eq!(files.len(), SHIPPED_FAMILIES.len() * 2, "{files:?}");
        assert!(files.iter().all(|f| f.extension().is_some_and(|e| e == "ttf")));
        // Les licences sont bien là, et bien écartées.
        let licences = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "txt"))
            .count();
        assert_eq!(licences, SHIPPED_FAMILIES.len());
    }

    #[test]
    fn a_missing_directory_means_system_fonts_not_a_failure() {
        assert!(font_files_in(Path::new("/definitely/not/a/fonts/dir")).is_empty());
    }
}
