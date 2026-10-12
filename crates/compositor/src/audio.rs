//! Piste audio native de l'export multiclip : ffmpeg décode les sources écran, swresample
//! normalise tout en f32 planaire 48 kHz stéréo, WSOLA applique les speed regions, puis un
//! unique encodeur AAC alimente le même muxer que la vidéo.

use crate::ffi::*;

use crate::regions::SpeedSegment;
use crate::scene::{
    SceneAudio, SceneAudioTrack, SceneAudioTrackKind, SceneClickHit, SceneClickSound,
};
use anyhow::{bail, Result};
use std::collections::{HashMap, VecDeque};
use std::f32::consts::PI;
use std::ffi::CString;
use std::ptr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

pub const AUDIO_OUTPUT_SAMPLE_RATE: i32 = 48_000;
pub const AUDIO_OUTPUT_CHANNELS: usize = 2;
/// AAC at 256 kb/s for the stereo programme. At 128 kb/s the encoder cuts at 16 kHz and its
/// quantisation noise is coarse enough to put a limited voice's peaks 1.3 dB back up, past
/// the −1 dBTP the export promises (#1157); at 256 kb/s it cuts at 20 kHz and adds 0.4 dB.
/// The extra 128 kb/s is 6 % of the lowest video bitrate the export asks for (2 Mb/s, see
/// `mp4ExportSettings.ts`), and much less of the usual one.
pub const AUDIO_BITRATE: i64 = 256_000;
pub const AUDIO_BOUNDARY_FADE_SAMPLES: usize = 240;

// Valeurs partagées : `AVERROR(EAGAIN)` dépend de la plateforme (-11 vs -35), et ce
// module est compilé sur les deux. Cf. `crate::ffi`.
use crate::ffi::{AVERROR_EAGAIN, AVERROR_EOF};
const AVSEEK_FLAG_BACKWARD: i32 = 1;
const DEFAULT_FRAME_SEC: f64 = 0.04;
const MIN_FRAME_SEC: f64 = 0.005;
const DEFAULT_SEARCH_SEC: f64 = 0.01;
const TARGET_GRAINS: usize = 8;
const PASSTHROUGH_EPSILON: f64 = 1e-3;

pub type PlanarPcm = Vec<Vec<f32>>;

/// Apply the editor's output trim to the assembled timeline, then keep it under the ceiling.
///
/// This runs on the assembled timeline — trimmed, speed-adjusted, concatenated — while the
/// editor preview plays the untouched SOURCE file, seeked. A linear gain is the one operation
/// that means the same thing on both, which is why the level work that has to match the
/// preview happens elsewhere, as static gains: the voice's loudness normalisation is a gain
/// per FILE (`loudness_gain_db`), applied to each clip's audio before assembly and asked for
/// by the preview too.
///
/// The limiter is the one stage here that the preview does not run. It is stateful, so it
/// would not see the same signal on both sides, and it only acts when the true peak goes
/// over `LIMITER_CEILING`: below that the output is the trimmed input, sample for sample.
/// When it does act, it gives back the loudness its gain reduction took (`limit_peaks`). What
/// it replaced was a hard clamp at full scale, which squared off every peak the trim or the
/// normalisation pushed over.
///
/// A sync offset shipped here once and was removed: it is expressed in TIMELINE seconds at
/// this point, but the preview would apply it in SOURCE seconds, so a 2x speed region halved
/// it, and near a cut the export pulled audio across the junction while the preview only has
/// the active asset loaded.
///
/// The bound mirrors `AUDIO_GAIN_DB_LIMIT` in editorSettings.ts. The result stays the same
/// length so video and following clips cannot drift.
pub fn finish_audio(mut pcm: PlanarPcm, settings: SceneAudio) -> PlanarPcm {
    let samples = pcm.first().map(Vec::len).unwrap_or(0);
    if samples == 0 {
        return pcm;
    }
    for channel in pcm.iter_mut() {
        channel.resize(samples, 0.0);
    }

    let trim = 10.0f32.powf(settings.gain_db.clamp(-12.0, 12.0) / 20.0);
    for sample in pcm.iter_mut().flatten() {
        *sample *= trim;
    }
    limit_peaks(&mut pcm);
    pcm
}

/// Highest TRUE peak the limiter lets through: −2 dBTP, a decibel under the usual −1 dBTP
/// delivery limit.
///
/// It is held on the waveform between the samples (`true_peak_envelope`), not on the samples
/// alone: a clipped recording has squared-off peaks that reconstruct about 2 dB above them,
/// so a ceiling on samples let a voice through at +0.6 dBTP before the encoder had touched it
/// (#1157). The decibel of margin is for the AAC encoder, which reshapes a limited waveform:
/// its low-pass and its quantisation noise both put the decoded peaks back above what went
/// in. Measured on #1157's voice limited to −1.5 dBTP, the file read −0.2 dBTP at 128 kb/s
/// and −1.1 at 256 kb/s (`AUDIO_BITRATE`), so −2 leaves about half a decibel to spare.
pub const LIMITER_CEILING: f32 = 0.794_328_2;
/// How early the gain starts to come down before a peak, as a straight ramp: 5 ms.
const LIMITER_LOOKAHEAD: usize = 240;
/// Time constant of the recovery once a peak has passed.
const LIMITER_RELEASE_SEC: f32 = 0.08;
/// Most the limiter raises the programme to win back the loudness its own gain reduction
/// took.
///
/// The return on it falls fast. On #1157's clipped voice, held at −2 dBTP, the programme
/// reads −17.6 LUFS without makeup, −17.1 with 3 dB, −16.9 with 6 and −16.7 with 12: the
/// voiced passages carry a peak every pitch period, so the limiter holds them at the ceiling
/// whatever the makeup, and their loudness is that ceiling minus the waveform's own crest
/// factor (about 15 dB there). The makeup then only raises what lies between them, pauses
/// and room noise included. Past 3 dB that costs more than it wins, and reaching −16 on such
/// a voice would take clipping it, which is not this stage's call: the true peak is a hard
/// limit and the loudness a target.
const LIMITER_MAX_MAKEUP_DB: f64 = 3.0;
/// Limiter runs the makeup search may measure before it settles. Each decibel of makeup buys
/// less than a decibel of loudness (the limiter takes part of it back), so each pass divides
/// what it missed by the loudness per decibel the last two measured; three usually do.
const LIMITER_MAKEUP_PASSES: usize = 6;
/// Close enough to the loudness before limiting: well under what a listener or a meter's
/// "about −16 LUFS" can tell apart.
const LIMITER_MAKEUP_TOLERANCE_LU: f64 = 0.1;

/// Interpolated points per sample interval, as ITU-R BS.1770-4 Annex 2 asks for at 48 kHz.
const TRUE_PEAK_OVERSAMPLING: usize = 4;
/// Samples on each side of an interpolated point that its windowed sinc reads.
const TRUE_PEAK_HALF_TAPS: usize = 6;

/// One windowed-sinc kernel per point between two samples, at 1/4, 2/4 and 3/4 of the way.
/// Tap `j` weighs sample `n − (TRUE_PEAK_HALF_TAPS − 1) + j` for a point after sample `n`.
/// Each kernel is scaled to unit DC gain, so a constant signal interpolates to itself.
fn true_peak_kernels() -> [[f32; 2 * TRUE_PEAK_HALF_TAPS]; TRUE_PEAK_OVERSAMPLING - 1] {
    let half = TRUE_PEAK_HALF_TAPS as f64;
    let mut kernels = [[0.0f32; 2 * TRUE_PEAK_HALF_TAPS]; TRUE_PEAK_OVERSAMPLING - 1];
    for (phase, kernel) in kernels.iter_mut().enumerate() {
        let fraction = (phase + 1) as f64 / TRUE_PEAK_OVERSAMPLING as f64;
        let weights: Vec<f64> = (0..2 * TRUE_PEAK_HALF_TAPS)
            .map(|tap| {
                let t = (tap as f64 - (half - 1.0)) - fraction;
                let sinc = (std::f64::consts::PI * t).sin() / (std::f64::consts::PI * t);
                sinc * 0.5 * (1.0 + (std::f64::consts::PI * t / half).cos())
            })
            .collect();
        let sum: f64 = weights.iter().sum();
        for (tap, weight) in kernel.iter_mut().zip(weights) {
            *tap = (weight / sum) as f32;
        }
    }
    kernels
}

/// The highest point the waveform reaches around each sample, across every channel: the
/// sample itself and the interpolated points on both sides of it. The waveform between two
/// samples is what a decoder and a DAC reproduce, so it is the peak the export must cap.
fn true_peak_envelope(pcm: &[Vec<f32>]) -> Vec<f32> {
    let len = pcm.first().map(Vec::len).unwrap_or(0);
    let kernels = true_peak_kernels();
    let mut envelope = vec![0.0f32; len];
    // Silence on both sides, so the edges read zeros instead of a shorter kernel.
    let mut padded = vec![0.0f32; len + 2 * TRUE_PEAK_HALF_TAPS];
    for channel in pcm {
        padded[TRUE_PEAK_HALF_TAPS..TRUE_PEAK_HALF_TAPS + len].copy_from_slice(&channel[..len]);
        let mut before = 0.0f32;
        for (index, peak) in envelope.iter_mut().enumerate() {
            let window = &padded[index + 1..index + 1 + 2 * TRUE_PEAK_HALF_TAPS];
            let after = kernels.iter().fold(0.0f32, |highest, kernel| {
                let point: f32 = kernel.iter().zip(window).map(|(k, x)| k * x).sum();
                highest.max(point.abs())
            });
            *peak = peak.max(channel[index].abs()).max(before).max(after);
            before = after;
        }
    }
    envelope
}

/// Gain that brings a true peak of `peak` under the ceiling, 1 when it already is.
fn gain_to_ceiling(peak: f32) -> f32 {
    if peak > LIMITER_CEILING {
        LIMITER_CEILING / peak
    } else {
        1.0
    }
}

/// Look-ahead peak limiter on a precomputed `envelope`, calling `apply(sample, gain)` once per
/// sample with the gain that sample takes. Linked across channels (the envelope is), so the
/// stereo image does not move.
///
/// `makeup` raises the whole signal first, and the limiter then works on `makeup × envelope`.
/// The gain each sample needs is held at its minimum over the next `LIMITER_LOOKAHEAD`
/// samples, then averaged over the last `LIMITER_LOOKAHEAD`. Every value in that average comes
/// from a window that contains the current sample, so the average never exceeds what the
/// sample needs: the ceiling holds exactly, and the gain still reaches each peak as a straight
/// 5 ms ramp instead of a step. The recovery after it is exponential.
fn limiter_gains(envelope: &[f32], makeup: f32, mut apply: impl FnMut(usize, f32)) {
    let len = envelope.len();
    let window = LIMITER_LOOKAHEAD as isize;
    let release = 1.0 - (-1.0 / (LIMITER_RELEASE_SEC * AUDIO_OUTPUT_SAMPLE_RATE as f32)).exp();
    // Rising minimum of the needed gain over the look-ahead window, as (index, gain).
    let mut held: VecDeque<(usize, f32)> = VecDeque::new();
    let mut ring = vec![1.0f32; LIMITER_LOOKAHEAD];
    let mut ring_sum = LIMITER_LOOKAHEAD as f64;
    let mut next = 0usize;
    let mut gain = 1.0f32;
    // Starting a window early fills the average with minima that already cover sample 0.
    for index in (1 - window)..len as isize {
        let horizon = ((index + window) as usize).min(len);
        while next < horizon {
            let needed = gain_to_ceiling(makeup * envelope[next]);
            while held.back().is_some_and(|&(_, g)| g >= needed) {
                held.pop_back();
            }
            held.push_back((next, needed));
            next += 1;
        }
        let first = index.max(0) as usize;
        while held.front().is_some_and(|&(i, _)| i < first) {
            held.pop_front();
        }
        let minimum = held.front().map_or(1.0, |&(_, g)| g);
        let slot = (index + window) as usize % LIMITER_LOOKAHEAD;
        ring_sum += f64::from(minimum - ring[slot]);
        ring[slot] = minimum;
        if index < 0 {
            continue;
        }
        let sample = index as usize;
        // The last `min` only absorbs the running sum's rounding: the average already obeys it.
        gain = ((ring_sum / LIMITER_LOOKAHEAD as f64) as f32)
            .min(gain + (1.0 - gain) * release)
            .min(gain_to_ceiling(makeup * envelope[sample]));
        apply(sample, makeup * gain);
    }
}

/// Integrated loudness of `pcm` once `limiter_gains(envelope, makeup)` has run on it, without
/// writing the result anywhere: it is fed to the meter a block at a time.
fn limited_loudness(pcm: &[Vec<f32>], envelope: &[f32], makeup: f32) -> Option<f64> {
    let mut meter = LoudnessMeter::new();
    let mut block = vec![Vec::with_capacity(LOUDNESS_STEP); pcm.len()];
    limiter_gains(envelope, makeup, |sample, gain| {
        for (plane, channel) in block.iter_mut().zip(pcm) {
            plane.push(channel[sample] * gain);
        }
        if block[0].len() == LOUDNESS_STEP || sample + 1 == envelope.len() {
            meter.push(&block);
            block.iter_mut().for_each(Vec::clear);
        }
    });
    meter.integrated()
}

/// The makeup that gives the limited programme back the integrated loudness it had before the
/// limiter, within `LIMITER_MAKEUP_TOLERANCE_LU`, between 0 and `LIMITER_MAX_MAKEUP_DB`.
///
/// Loudness rises with the makeup, but by less than the makeup, so this is a secant search:
/// each pass steps by the loudness still missing over the loudness per decibel that the last
/// two passes measured (one decibel per decibel before there are two).
fn loudness_makeup(pcm: &[Vec<f32>], envelope: &[f32]) -> f32 {
    let mut meter = LoudnessMeter::new();
    meter.push(pcm);
    let Some(target) = meter.integrated() else {
        return 1.0;
    };
    let mut makeup_db = 0.0f64;
    let mut previous: Option<(f64, f64)> = None;
    for _ in 0..LIMITER_MAKEUP_PASSES {
        let makeup = 10.0f32.powf(makeup_db as f32 / 20.0);
        let Some(limited) = limited_loudness(pcm, envelope, makeup) else {
            break;
        };
        let shortfall = target - limited;
        if shortfall.abs() < LIMITER_MAKEUP_TOLERANCE_LU {
            break;
        }
        // A floor on the slope: a pass that gained next to nothing must not ask for a leap
        // the bound would only cut back.
        let slope = previous
            .map_or(1.0, |(db, lufs)| ((limited - lufs) / (makeup_db - db)).max(0.1));
        previous = Some((makeup_db, limited));
        let next = (makeup_db + shortfall / slope).clamp(0.0, LIMITER_MAX_MAKEUP_DB);
        if next == makeup_db {
            break; // held at a bound
        }
        makeup_db = next;
    }
    10.0f32.powf(makeup_db as f32 / 20.0)
}

/// Keep the programme's true peak under `LIMITER_CEILING`, losing as little loudness to it
/// as a bounded makeup allows.
///
/// A signal whose true peak never crosses the ceiling passes through untouched. Otherwise
/// the limiter brings the peaks down, and a makeup gain found by measuring the limited
/// result (`loudness_makeup`) brings the integrated loudness back towards what it was: the
/// normalisation already put the voice at the target, and the limiter is the one stage the
/// preview does not run, so it should move the level the preview plays at as little as it
/// can. How far that goes is `LIMITER_MAX_MAKEUP_DB`'s story.
fn limit_peaks(pcm: &mut PlanarPcm) {
    let envelope = true_peak_envelope(pcm);
    if envelope.iter().all(|&peak| peak <= LIMITER_CEILING) {
        return;
    }
    let makeup = loudness_makeup(pcm, &envelope);
    apply_limiter(pcm, &envelope, makeup);
    // The envelope was read before the gain, and the gain moves across the dozen samples an
    // interpolated point is made of, so a sharp transient can come out a few thousandths of a
    // decibel over. One more pass on what was written catches it; its own gain is all but
    // flat, so what it leaves is smaller again by orders of magnitude.
    let residual = true_peak_envelope(pcm);
    if residual.iter().any(|&peak| peak > LIMITER_CEILING) {
        apply_limiter(pcm, &residual, 1.0);
    }
}

/// `limiter_gains` written into `pcm`.
fn apply_limiter(pcm: &mut PlanarPcm, envelope: &[f32], makeup: f32) {
    limiter_gains(envelope, makeup, |sample, gain| {
        for channel in pcm.iter_mut() {
            channel[sample] *= gain;
        }
    });
}

/// Integrated loudness every voice source is brought to: −16 LUFS, the usual delivery target
/// for spoken content online (it is what Apple Podcasts asks for).
pub const LOUDNESS_TARGET_LUFS: f64 = -16.0;
/// Most the normalisation will raise a file. Without a denoiser, a recording that is mostly
/// room noise (a microphone left open over a silent demo) would otherwise come out as loud
/// hiss; a voice quieter than −28 LUFS lands below the target instead.
pub const LOUDNESS_MAX_BOOST_DB: f64 = 12.0;

/// ITU-R BS.1770-4 K-weighting at 48 kHz — the pre-filter's high shelf, then the RLB
/// high-pass — as `[b0, b1, b2, a1, a2]`.
const K_WEIGHTING: [[f64; 5]; 2] = [
    [
        1.535_124_859_586_97,
        -2.691_696_189_406_38,
        1.198_392_810_852_85,
        -1.690_659_293_182_41,
        0.732_480_774_215_85,
    ],
    [1.0, -2.0, 1.0, -1.990_047_454_833_98, 0.990_072_250_366_21],
];
/// 100 ms: four of these make a 400 ms gating block, and one is the 75 % overlap hop.
const LOUDNESS_STEP: usize = AUDIO_OUTPUT_SAMPLE_RATE as usize / 10;

/// Integrated loudness per ITU-R BS.1770-4, gated as EBU R128 specifies (−70 LUFS absolute,
/// −10 LU relative). Fed in order, one window at a time, so a long recording never sits in
/// memory whole: only one number per 100 ms is kept.
struct LoudnessMeter {
    /// Transposed direct form II state, per channel and per filter stage.
    state: [[[f64; 2]; 2]; AUDIO_OUTPUT_CHANNELS],
    /// Channel-summed, K-weighted mean square of each complete 100 ms step.
    steps: Vec<f64>,
    partial: f64,
    partial_len: usize,
}

impl LoudnessMeter {
    fn new() -> Self {
        Self {
            state: [[[0.0; 2]; 2]; AUDIO_OUTPUT_CHANNELS],
            steps: Vec::new(),
            partial: 0.0,
            partial_len: 0,
        }
    }

    fn push(&mut self, pcm: &[Vec<f32>]) {
        let len = pcm.first().map(Vec::len).unwrap_or(0);
        for index in 0..len {
            let mut energy = 0.0f64;
            for (channel, state) in self.state.iter_mut().enumerate() {
                let sample = pcm.get(channel).and_then(|plane| plane.get(index));
                let mut x = f64::from(sample.copied().unwrap_or(0.0));
                for (c, z) in K_WEIGHTING.iter().zip(state.iter_mut()) {
                    let y = c[0] * x + z[0];
                    z[0] = c[1] * x - c[3] * y + z[1];
                    z[1] = c[2] * x - c[4] * y;
                    x = y;
                }
                energy += x * x;
            }
            self.partial += energy;
            self.partial_len += 1;
            if self.partial_len == LOUDNESS_STEP {
                self.steps.push(self.partial / LOUDNESS_STEP as f64);
                self.partial = 0.0;
                self.partial_len = 0;
            }
        }
    }

    /// LUFS, or `None` when no 400 ms block clears the absolute gate: silence has no loudness
    /// to correct.
    fn integrated(&self) -> Option<f64> {
        let lufs = |power: f64| -0.691 + 10.0 * power.log10();
        let mean = |powers: &[f64]| powers.iter().sum::<f64>() / powers.len() as f64;
        let audible: Vec<f64> = self
            .steps
            .windows(4)
            .map(|block| block.iter().sum::<f64>() / 4.0)
            .filter(|&power| lufs(power) > -70.0)
            .collect();
        if audible.is_empty() {
            return None;
        }
        let relative_gate = lufs(mean(&audible)) - 10.0;
        let gated: Vec<f64> = audible
            .into_iter()
            .filter(|&power| lufs(power) > relative_gate)
            .collect();
        Some(lufs(mean(&gated)))
    }
}

/// One minute at a time: 23 MB of PCM, whatever the recording's length.
const LOUDNESS_WINDOW_SEC: f64 = 60.0;
/// A day of windows. Only a file whose timestamps never end would get here.
const LOUDNESS_MAX_WINDOWS: usize = 24 * 60;

/// Integrated loudness of every audio track in `path`, mixed exactly as the export mixes
/// them (`decode_clip_audio`), over the whole file. `Ok(None)`: no audio, or only silence.
pub fn measure_file_loudness(path: &str) -> Result<Option<f64>> {
    let mut meter = LoudnessMeter::new();
    for window in 0..LOUDNESS_MAX_WINDOWS {
        let start = window as f64 * LOUDNESS_WINDOW_SEC;
        let Some((pcm, more)) = decode_audio_window(path, start, start + LOUDNESS_WINDOW_SEC)?
        else {
            return Ok(None);
        };
        // The last window is zero-padded past the end of the file; silence never clears
        // the absolute gate, so the padding does not move the result.
        meter.push(&pcm);
        if !more {
            break;
        }
    }
    Ok(meter.integrated())
}

/// The gain, in dB, that takes audio measured at `loudness` to the target: negative for a
/// hot recording, positive up to `LOUDNESS_MAX_BOOST_DB` for a quiet one, 0 for silence.
fn loudness_gain_for(loudness: Option<f64>) -> f32 {
    loudness.map_or(0.0, |lufs| {
        (LOUDNESS_TARGET_LUFS - lufs).min(LOUDNESS_MAX_BOOST_DB) as f32
    })
}

/// Loudness-normalisation gain for one voice source, in dB.
///
/// Measured over the WHOLE file, not over the part the timeline keeps. That makes it a
/// property of the recording rather than of the edit: a trim does not move the level of what
/// is left, a timeline cut from several takes brings each take to the target on its own, and
/// the editor preview — which plays the source file, not the assembled programme — can apply
/// the very same number (it asks for it through the addon's `loudnessGainDb`).
///
/// Cached per process by path, size and modification time, so the preview's request and
/// every export job of every clip cut from the same file share one measurement. A file that
/// cannot be read measures as 0 dB, the same degradation a clip without audio gets.
pub fn loudness_gain_db(path: &str) -> f32 {
    type Key = (String, u64, Option<SystemTime>);
    static CACHE: OnceLock<Mutex<HashMap<Key, Arc<OnceLock<f32>>>>> = OnceLock::new();
    let Ok(metadata) = std::fs::metadata(path) else {
        return 0.0;
    };
    let key = (path.to_owned(), metadata.len(), metadata.modified().ok());
    let cell = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(key)
        .or_default()
        .clone();
    // Measured outside the map's lock: another file never waits on this one, and a second
    // request for the same file waits for the first measurement instead of repeating it.
    *cell.get_or_init(|| match measure_file_loudness(path) {
        Ok(loudness) => loudness_gain_for(loudness),
        Err(error) => {
            eprintln!("[audio] loudness of {path} not measured ({error:#}); left as recorded");
            0.0
        }
    })
}

/// Multiply every sample by the gain `gain_db` stands for. A no-op at 0 dB.
pub fn apply_gain_db(pcm: &mut PlanarPcm, gain_db: f32) {
    if gain_db == 0.0 {
        return;
    }
    let gain = 10.0f32.powf(gain_db / 20.0);
    for sample in pcm.iter_mut().flatten() {
        *sample *= gain;
    }
}

extern "C" {
    fn sn_fmt_stream(s: *mut AVFormatContext, i: i32) -> *mut AVStream;
    // bindgen rend `AVFormatContext` opaque (atteinte seulement par pointeur), d'où l'accesseur
    // compilé contre les vrais headers — voir shim.c.
    fn sn_fmt_nb_streams(s: *mut AVFormatContext) -> u32;
}

fn averr(ret: i32, ctx: &str) -> Result<()> {
    if ret < 0 {
        // Surtout pas `[0i8; 256]` : `c_char` est signé sur x86_64 mais NON SIGNÉ sur
        // aarch64, donc un i8 en dur fait du `*mut c_char` d'av_strerror une erreur de
        // type sur arm64.
        let mut buf = [0 as std::ffi::c_char; 256];
        unsafe { av_strerror(ret, buf.as_mut_ptr(), buf.len()) };
        let msg = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) }.to_string_lossy();
        bail!("{ctx}: {ret} ({msg})");
    }
    Ok(())
}

struct AudioResampler {
    ctx: *mut SwrContext,
    input_rate: i32,
}

impl AudioResampler {
    unsafe fn from_frame(frame: *mut AVFrame, dctx: *mut AVCodecContext) -> Result<Self> {
        let mut output_layout = AVChannelLayout::default();
        av_channel_layout_default(&mut output_layout, AUDIO_OUTPUT_CHANNELS as i32);

        let mut fallback_layout = AVChannelLayout::default();
        let input_layout = if (*frame).ch_layout.nb_channels > 0 {
            &(*frame).ch_layout as *const AVChannelLayout
        } else if (*dctx).ch_layout.nb_channels > 0 {
            &(*dctx).ch_layout as *const AVChannelLayout
        } else {
            av_channel_layout_default(&mut fallback_layout, 1);
            &fallback_layout as *const AVChannelLayout
        };
        let input_rate = if (*frame).sample_rate > 0 {
            (*frame).sample_rate
        } else {
            (*dctx).sample_rate
        };
        if input_rate <= 0 {
            av_channel_layout_uninit(&mut output_layout);
            av_channel_layout_uninit(&mut fallback_layout);
            bail!("fréquence audio source invalide");
        }

        let mut ctx: *mut SwrContext = ptr::null_mut();
        let ret = swr_alloc_set_opts2(
            &mut ctx,
            &output_layout,
            AVSampleFormat::AV_SAMPLE_FMT_FLTP,
            AUDIO_OUTPUT_SAMPLE_RATE,
            input_layout,
            (*frame).format as AVSampleFormat::Type,
            input_rate,
            0,
            ptr::null_mut(),
        );
        av_channel_layout_uninit(&mut output_layout);
        av_channel_layout_uninit(&mut fallback_layout);
        averr(ret, "swr_alloc_set_opts2")?;
        if ctx.is_null() {
            bail!("swr_alloc_set_opts2: contexte nul");
        }
        averr(swr_init(ctx), "swr_init")?;
        Ok(Self { ctx, input_rate })
    }

    unsafe fn push(&mut self, frame: *mut AVFrame, output: &mut PlanarPcm) -> Result<()> {
        let out_capacity = swr_get_out_samples(self.ctx, (*frame).nb_samples).max(1) as usize;
        let mut planes = vec![vec![0.0f32; out_capacity]; AUDIO_OUTPUT_CHANNELS];
        let mut output_ptrs: Vec<*mut u8> = planes
            .iter_mut()
            .map(|plane| plane.as_mut_ptr() as *mut u8)
            .collect();
        let input_ptrs = (*frame).extended_data as *const *const u8;
        let converted = swr_convert(
            self.ctx,
            output_ptrs.as_mut_ptr(),
            out_capacity as i32,
            input_ptrs,
            (*frame).nb_samples,
        );
        averr(converted, "swr_convert")?;
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            planes[channel].truncate(converted as usize);
            output[channel].extend_from_slice(&planes[channel]);
        }
        Ok(())
    }

    unsafe fn flush(&mut self, output: &mut PlanarPcm) -> Result<()> {
        loop {
            let delay = swr_get_delay(self.ctx, self.input_rate as i64);
            if delay <= 0 {
                break;
            }
            let out_capacity = (((delay * AUDIO_OUTPUT_SAMPLE_RATE as i64)
                + self.input_rate as i64 - 1)
                / self.input_rate as i64
                + 32) as usize;
            let mut planes = vec![vec![0.0f32; out_capacity]; AUDIO_OUTPUT_CHANNELS];
            let mut output_ptrs: Vec<*mut u8> = planes
                .iter_mut()
                .map(|plane| plane.as_mut_ptr() as *mut u8)
                .collect();
            let converted = swr_convert(
                self.ctx,
                output_ptrs.as_mut_ptr(),
                out_capacity as i32,
                ptr::null(),
                0,
            );
            averr(converted, "swr_convert(flush)")?;
            if converted == 0 {
                break;
            }
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                planes[channel].truncate(converted as usize);
                output[channel].extend_from_slice(&planes[channel]);
            }
        }
        Ok(())
    }
}

impl Drop for AudioResampler {
    fn drop(&mut self) {
        unsafe { swr_free(&mut self.ctx) };
    }
}

/// Un décodeur + resampler par piste audio du conteneur, tous alimentés par la même passe de
/// démux. Chaque piste produit du f32 planaire 48 kHz stéréo recadré sur la même fenêtre
/// source, si bien que le mixage final est une simple somme échantillon par échantillon.
struct AudioTrackDecoder {
    stream_index: i32,
    dctx: *mut AVCodecContext,
    tb_sec: f64,
    resampler: Option<AudioResampler>,
    decoded: PlanarPcm,
    origin_sec: Option<f64>,
    reached_end: bool,
    decoder_eof: bool,
}

impl Drop for AudioTrackDecoder {
    fn drop(&mut self) {
        unsafe { avcodec_free_context(&mut self.dctx) };
    }
}

/// Décode uniquement la fenêtre source conservée. Le seek audio retombe sur une trame
/// antérieure ; l'origine pts du premier bloc resamplé permet ensuite de couper précisément la
/// prélecture sans supposer que la piste commence à t=0.
///
/// TOUTES les pistes audio sont décodées puis mixées. L'enregistreur natif macOS écrit l'audio
/// système et le micro en deux pistes AAC distinctes, toutes deux marquées `default` :
/// `av_find_best_stream` n'en rendait qu'une — la première, silencieuse dès que rien ne joue sur
/// le système — et le micro disparaissait de l'export (issue #108). La PR #109 avait corrigé ce
/// défaut dans l'exporteur navigateur ; l'app n'emprunte plus ce chemin, d'où la même correction
/// ici, dans le chemin natif.
pub fn decode_clip_audio(path: &str, source_start_sec: f64, source_end_sec: f64) -> Result<Option<PlanarPcm>> {
    Ok(decode_audio_window(path, source_start_sec, source_end_sec)?.map(|(pcm, _)| pcm))
}

/// `decode_clip_audio`, plus whether the file still has audio past `source_end_sec`: what a
/// caller walking a whole file one window at a time needs to know where to stop.
fn decode_audio_window(
    path: &str,
    source_start_sec: f64,
    source_end_sec: f64,
) -> Result<Option<(PlanarPcm, bool)>> {
    unsafe { decode_clip_audio_inner(path, source_start_sec, source_end_sec) }
}

unsafe fn decode_clip_audio_inner(
    path: &str,
    source_start_sec: f64,
    source_end_sec: f64,
) -> Result<Option<(PlanarPcm, bool)>> {
    let mut fmt: *mut AVFormatContext = ptr::null_mut();
    let cpath = CString::new(path)?;
    averr(
        avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()),
        "audio open_input",
    )?;
    averr(avformat_find_stream_info(fmt, ptr::null_mut()), "audio find_stream_info")?;
    // Énumération de toutes les pistes audio (voir le commentaire de `decode_clip_audio`).
    let mut audio_stream_count = 0usize;
    let mut tracks: Vec<AudioTrackDecoder> = Vec::new();
    for index in 0..sn_fmt_nb_streams(fmt) as i32 {
        let stream = sn_fmt_stream(fmt, index);
        let codecpar = (*stream).codecpar;
        if (*codecpar).codec_type != AVMediaType::AVMEDIA_TYPE_AUDIO {
            continue;
        }
        audio_stream_count += 1;
        // Une piste qu'on ne sait pas ouvrir est ignorée, pas fatale : avant ce mixage une
        // seule piste était ouverte, donc une piste annexe exotique ne pouvait pas casser un
        // export. Le `bail!` plus bas garantit qu'on ne perd pas l'audio en silence pour
        // autant — c'est précisément le défaut qu'on corrige ici.
        let decoder = avcodec_find_decoder((*codecpar).codec_id);
        if decoder.is_null() {
            continue;
        }
        let mut dctx = avcodec_alloc_context3(decoder);
        if dctx.is_null() {
            avformat_close_input(&mut fmt);
            bail!("audio avcodec_alloc_context3");
        }
        if avcodec_parameters_to_context(dctx, codecpar) < 0
            || avcodec_open2(dctx, decoder, ptr::null_mut()) < 0
        {
            avcodec_free_context(&mut dctx);
            continue;
        }
        let time_base = (*stream).time_base;
        tracks.push(AudioTrackDecoder {
            stream_index: index,
            dctx,
            tb_sec: if time_base.den != 0 {
                time_base.num as f64 / time_base.den as f64
            } else {
                0.0
            },
            resampler: None,
            decoded: vec![Vec::<f32>::new(); AUDIO_OUTPUT_CHANNELS],
            origin_sec: None,
            reached_end: false,
            decoder_eof: false,
        });
    }
    if tracks.is_empty() {
        avformat_close_input(&mut fmt);
        if audio_stream_count > 0 {
            bail!("audio : {audio_stream_count} piste(s) présentes, aucune décodable");
        }
        return Ok(None);
    }

    // Un seul seek : il repositionne le conteneur entier. On le cale sur la première piste
    // audio puis on vide tous les décodeurs. Si une autre piste reprend légèrement après le
    // début de la fenêtre demandée, son recadrage (plus bas) la zéro-padde devant — le
    // décalage inter-pistes est absorbé là, pas ici.
    let seek_tb_sec = tracks[0].tb_sec;
    let seek_stream_index = tracks[0].stream_index;
    if seek_tb_sec > 0.0 {
        let target = (source_start_sec / seek_tb_sec).floor() as i64;
        if av_seek_frame(fmt, seek_stream_index, target, AVSEEK_FLAG_BACKWARD) >= 0 {
            for track in tracks.iter_mut() {
                avcodec_flush_buffers(track.dctx);
            }
        }
    }

    let mut packet = av_packet_alloc();
    let mut frame = av_frame_alloc();
    let mut input_eof = false;

    // Une seule passe de démux alimente tous les décodeurs : chaque paquet est routé vers la
    // piste dont il porte l'index. On continue tant qu'AU MOINS une piste a encore quelque
    // chose à produire.
    while tracks.iter().any(|t| !t.reached_end && !t.decoder_eof) {
        if !input_eof {
            let read = av_read_frame(fmt, packet);
            if read == AVERROR_EOF {
                for track in tracks.iter_mut() {
                    avcodec_send_packet(track.dctx, ptr::null());
                }
                input_eof = true;
            } else {
                averr(read, "audio av_read_frame")?;
                let packet_stream = (*packet).stream_index;
                if let Some(track) = tracks
                    .iter_mut()
                    .find(|t| t.stream_index == packet_stream && !t.reached_end)
                {
                    averr(avcodec_send_packet(track.dctx, packet), "audio send_packet")?;
                }
                av_packet_unref(packet);
            }
        }

        for track in tracks.iter_mut() {
            if track.reached_end || track.decoder_eof {
                continue;
            }
            loop {
                let ret = avcodec_receive_frame(track.dctx, frame);
                if ret == AVERROR_EOF {
                    track.decoder_eof = true;
                    break;
                }
                if ret == AVERROR_EAGAIN {
                    if input_eof {
                        track.decoder_eof = true;
                    }
                    break;
                }
                averr(ret, "audio receive_frame")?;

                let pts = (*frame).best_effort_timestamp;
                let frame_sec = if pts != i64::MIN && track.tb_sec > 0.0 {
                    pts as f64 * track.tb_sec
                } else {
                    track.origin_sec.unwrap_or(source_start_sec)
                };
                if frame_sec >= source_end_sec {
                    track.reached_end = true;
                    av_frame_unref(frame);
                    break;
                }
                if track.origin_sec.is_none() {
                    track.origin_sec = Some(frame_sec);
                }
                if track.resampler.is_none() {
                    track.resampler = Some(AudioResampler::from_frame(frame, track.dctx)?);
                }
                track
                    .resampler
                    .as_mut()
                    .unwrap()
                    .push(frame, &mut track.decoded)?;
                av_frame_unref(frame);
            }
        }
    }

    for track in tracks.iter_mut() {
        if let Some(r) = track.resampler.as_mut() {
            r.flush(&mut track.decoded)?;
        }
    }

    av_frame_free(&mut frame);
    av_packet_free(&mut packet);
    avformat_close_input(&mut fmt);

    let target_samples = (((source_end_sec - source_start_sec).max(0.0)
        * AUDIO_OUTPUT_SAMPLE_RATE as f64)
        .round()) as usize;
    // A track stops either on a frame at or past the window's end, or at the end of the file.
    let more = tracks.iter().any(|track| track.reached_end);
    let aligned: Vec<(f64, &PlanarPcm)> = tracks
        .iter()
        .map(|track| (track.origin_sec.unwrap_or(source_start_sec), &track.decoded))
        .collect();
    Ok(Some((
        mix_aligned_tracks(&aligned, source_start_sec, target_samples),
        more,
    )))
}

/// Recadre chaque piste sur la MÊME fenêtre (`target_samples` échantillons à partir de
/// `source_start_sec`) puis les somme. Une piste dont le premier paquet décodé arrive après le
/// début de la fenêtre est zéro-paddée devant ; la prélecture d'une piste décodée trop tôt (le
/// seek retombe sur une trame antérieure) est coupée. C'est ce recadrage qui absorbe les
/// décalages de départ entre pistes, si bien que le mixage lui-même n'est qu'une somme.
///
/// Séparé du décodage pour être testable sans ffmpeg.
fn mix_aligned_tracks(
    tracks: &[(f64, &PlanarPcm)],
    source_start_sec: f64,
    target_samples: usize,
) -> PlanarPcm {
    let mut mixed = vec![vec![0.0f32; target_samples]; AUDIO_OUTPUT_CHANNELS];
    for &(origin_sec, decoded) in tracks {
        let relative_start =
            ((source_start_sec - origin_sec) * AUDIO_OUTPUT_SAMPLE_RATE as f64).round() as i64;
        let (src_start, dst_start) = if relative_start >= 0 {
            (relative_start as usize, 0usize)
        } else {
            (0usize, (-relative_start) as usize)
        };
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            if src_start >= decoded[channel].len() || dst_start >= target_samples {
                continue;
            }
            let count = (decoded[channel].len() - src_start).min(target_samples - dst_start);
            for offset in 0..count {
                mixed[channel][dst_start + offset] += decoded[channel][src_start + offset];
            }
        }
    }
    // Sommer plusieurs pistes peut dépasser la pleine échelle, et on ne l'écrête PLUS ici : le
    // flottant garde ces crêtes intactes jusqu'au gain de loudness (qui baisse souvent un mix
    // chaud) puis au limiteur de `finish_audio`, seul endroit où le signal touche un plafond.
    // Écrêter ici cassait des crêtes que la suite aurait ramenées sous la pleine échelle.
    mixed
}

fn hann(length: usize) -> Vec<f32> {
    let mut window = vec![0.0; length];
    for (i, value) in window.iter_mut().enumerate() {
        *value = 0.5 - 0.5 * ((2.0 * PI * i as f32) / (length - 1) as f32).cos();
    }
    window
}

/// Port direct du WSOLA web. Tous les canaux partagent les positions choisies sur un downmix
/// mono, sinon deux recherches indépendantes déplaceraient l'image stéréo.
pub struct WsolaTimeStretcher {
    channels: usize,
    passthrough: bool,
    n: usize,
    hs: usize,
    ha: f64,
    search_radius: i64,
    window: Vec<f32>,
    buf: PlanarPcm,
    mono: Vec<f32>,
    buf_start: i64,
    /// Décalage de lecture dans `buf`/`mono`. `discard_below` ne recopiait pas moins que le
    /// reste du buffer à chaque grain : la région entière est poussée d'un coup, donc pour
    /// 65 M d'échantillons cela faisait ~N²/(2·ha) ≈ 1,1e12 f32 recopiés par canal — le vrai
    /// coût du chemin WSOLA, devant la recherche par grain. On avance un curseur et on ne
    /// compacte que lorsque la tête dépasse la moitié du buffer, ce qui rend le total O(N).
    buf_head: usize,
    out: PlanarPcm,
    win_sum: Vec<f32>,
    out_start: usize,
    ideal_pos: f64,
    grain_pos: i64,
    frame: usize,
    placed_any: bool,
}

impl WsolaTimeStretcher {
    pub fn new(
        sample_rate: i32,
        channels: usize,
        speed: f64,
        expected_output_samples: usize,
    ) -> Self {
        let channels = channels.max(1);
        let passthrough = (speed - 1.0).abs() < PASSTHROUGH_EPSILON;
        let mut n = (sample_rate as f64 * DEFAULT_FRAME_SEC).round() as usize;
        n = n.max(4);
        if n % 2 != 0 {
            n += 1;
        }
        let mut hs = n / 2;
        if expected_output_samples > 0 {
            let min_hs = 2usize.max(
                ((sample_rate as f64 * MIN_FRAME_SEC) / 2.0).round() as usize,
            );
            let target_hs = expected_output_samples / TARGET_GRAINS;
            hs = hs.min(min_hs.max(target_hs));
        }
        let n = hs * 2;
        let search_radius = ((sample_rate as f64 * DEFAULT_SEARCH_SEC).round() as usize)
            .min(hs) as i64;
        Self {
            channels,
            passthrough,
            n,
            hs,
            ha: hs as f64 * speed,
            search_radius,
            window: hann(n),
            buf: vec![Vec::new(); channels],
            mono: Vec::new(),
            buf_start: 0,
            buf_head: 0,
            out: vec![Vec::new(); channels],
            win_sum: Vec::new(),
            out_start: 0,
            ideal_pos: 0.0,
            grain_pos: 0,
            frame: 0,
            placed_any: false,
        }
    }

    pub fn push(&mut self, planar: &[Vec<f32>]) -> PlanarPcm {
        if self.passthrough {
            return (0..self.channels)
                .map(|channel| {
                    planar
                        .get(channel)
                        .or_else(|| planar.first())
                        .cloned()
                        .unwrap_or_default()
                })
                .collect();
        }
        self.append(planar);
        self.process(false)
    }

    pub fn flush(&mut self) -> PlanarPcm {
        if self.passthrough {
            return self.empty_chunk();
        }
        self.process(true)
    }

    fn empty_chunk(&self) -> PlanarPcm {
        vec![Vec::new(); self.channels]
    }

    fn append(&mut self, planar: &[Vec<f32>]) {
        let add_len = planar.first().map(|p| p.len()).unwrap_or(0);
        if add_len == 0 {
            return;
        }
        for channel in 0..self.channels {
            if let Some(source) = planar.get(channel).or_else(|| planar.first()) {
                self.buf[channel].extend_from_slice(&source[..add_len.min(source.len())]);
                if source.len() < add_len {
                    let target_len = self.buf[channel].len() + add_len - source.len();
                    self.buf[channel].resize(target_len, 0.0);
                }
            }
        }
        for i in 0..add_len {
            let mut sum = 0.0f32;
            for channel in 0..self.channels {
                sum += planar
                    .get(channel)
                    .and_then(|p| p.get(i))
                    .or_else(|| planar.first().and_then(|p| p.get(i)))
                    .copied()
                    .unwrap_or(0.0);
            }
            self.mono.push(sum / self.channels as f32);
        }
    }

    fn buf_len(&self) -> usize {
        self.buf[0].len() - self.buf_head
    }

    fn buf_end(&self) -> i64 {
        self.buf_start + self.buf_len() as i64
    }

    fn sample_at(&self, channel: usize, absolute_index: i64) -> f32 {
        let index = absolute_index - self.buf_start;
        if index < 0 {
            0.0
        } else {
            self.buf[channel]
                .get(self.buf_head + index as usize)
                .copied()
                .unwrap_or(0.0)
        }
    }

    fn mono_at(&self, absolute_index: i64) -> f32 {
        let index = absolute_index - self.buf_start;
        if index < 0 {
            0.0
        } else {
            self.mono
                .get(self.buf_head + index as usize)
                .copied()
                .unwrap_or(0.0)
        }
    }

    fn process(&mut self, final_chunk: bool) -> PlanarPcm {
        let mut emitted = self.empty_chunk();
        // Pas de garde anti-stagnation ici : `search_target` croît de `ha > 0` à chaque tour
        // et `grain_pos` ne s'en écarte que de `search_radius` au plus, donc le break sur
        // `buf_end` finit toujours par tomber. Une garde de plus tronquerait `emitted` — la
        // région sortirait muette pour tout signal — sans jamais se déclencher.
        loop {
            let search_target = (self.ideal_pos + self.ha).round() as i64;
            let required_end = (self.grain_pos + self.n as i64)
                .max(self.grain_pos + self.hs as i64 + self.n as i64)
                .max(search_target + self.search_radius + self.n as i64);
            if !final_chunk && self.buf_end() < required_end {
                break;
            }
            if self.grain_pos + self.n as i64 > self.buf_end() {
                break;
            }

            self.place_grain(self.grain_pos);
            let placed_frame = self.frame;
            let reference_start = self.grain_pos + self.hs as i64;
            let best_delta = self.find_best_delta(reference_start, search_target);
            self.grain_pos = search_target + best_delta;
            self.ideal_pos += self.ha;
            self.frame += 1;

            self.collect(placed_frame * self.hs, &mut emitted);
            self.discard_below(self.grain_pos);
        }
        if final_chunk {
            self.collect_all(&mut emitted);
        }
        emitted
    }

    fn place_grain(&mut self, position: i64) {
        let output_absolute = self.frame * self.hs;
        self.ensure_out(output_absolute + self.n);
        let base = output_absolute - self.out_start;
        for channel in 0..self.channels {
            for k in 0..self.n {
                let sample = self.sample_at(channel, position + k as i64);
                self.out[channel][base + k] += sample * self.window[k];
            }
        }
        for k in 0..self.n {
            self.win_sum[base + k] += self.window[k];
        }
        self.placed_any = true;
    }

    fn find_best_delta(&self, reference_start: i64, target: i64) -> i64 {
        if reference_start + self.n as i64 > self.buf_end() {
            return 0;
        }
        let mut reference_energy = 0.0f32;
        for k in 0..self.n {
            let sample = self.mono_at(reference_start + k as i64);
            reference_energy += sample * sample;
        }
        if reference_energy == 0.0 {
            return 0;
        }

        let mut best_delta = 0;
        let mut best_score = f32::NEG_INFINITY;
        let low = (-self.search_radius).max(self.buf_start - target);
        let high = self
            .search_radius
            .min(self.buf_end() - self.n as i64 - target);
        for delta in low..=high {
            let candidate_start = target + delta;
            let mut dot = 0.0f32;
            let mut energy = 0.0f32;
            for k in 0..self.n {
                let candidate = self.mono_at(candidate_start + k as i64);
                dot += candidate * self.mono_at(reference_start + k as i64);
                energy += candidate * candidate;
            }
            let score = if energy > 0.0 { dot / energy.sqrt() } else { 0.0 };
            if score > best_score {
                best_score = score;
                best_delta = delta;
            }
        }
        best_delta
    }

    fn ensure_out(&mut self, absolute_end: usize) {
        let needed = absolute_end - self.out_start;
        if needed <= self.out[0].len() {
            return;
        }
        let next_len = needed.max(self.out[0].len() * 2).max(self.n * 4);
        for channel in 0..self.channels {
            self.out[channel].resize(next_len, 0.0);
        }
        self.win_sum.resize(next_len, 0.0);
    }

    fn collect(&mut self, absolute_end: usize, emitted: &mut PlanarPcm) {
        let count = absolute_end.saturating_sub(self.out_start);
        if count == 0 {
            return;
        }
        for channel in 0..self.channels {
            for i in 0..count {
                let weight = self.win_sum[i];
                let mut sample = self.out[channel][i];
                if weight > 1e-6 {
                    sample /= weight;
                }
                emitted[channel].push(sample);
            }
            self.out[channel] = self.out[channel][count..].to_vec();
        }
        self.win_sum = self.win_sum[count..].to_vec();
        self.out_start = absolute_end;
    }

    fn collect_all(&mut self, emitted: &mut PlanarPcm) {
        if !self.placed_any {
            return;
        }
        let end = (self.frame - 1) * self.hs + self.n;
        self.collect(end, emitted);
    }

    fn discard_below(&mut self, absolute_index: i64) {
        let drop_count = absolute_index - self.buf_start;
        if drop_count <= 0 {
            return;
        }
        self.buf_head += (drop_count as usize).min(self.buf_len());
        self.buf_start = absolute_index;
        // Compactage amorti : ne recopier que lorsque la tête consommée dépasse ce qui
        // reste laisse un coût total en O(N) au lieu du O(N²) d'une recopie par grain.
        if self.buf_head > self.buf[0].len() - self.buf_head {
            let head = self.buf_head;
            for channel in 0..self.channels {
                self.buf[channel].drain(..head);
            }
            self.mono.drain(..head);
            self.buf_head = 0;
        }
    }
}

fn stretch_pcm_to_length(pcm: &[Vec<f32>], target_samples: usize) -> PlanarPcm {
    if target_samples == 0 {
        return vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
    }
    let source_samples = pcm.first().map(|channel| channel.len()).unwrap_or(0);
    if source_samples == 0 {
        return vec![vec![0.0; target_samples]; AUDIO_OUTPUT_CHANNELS];
    }
    if source_samples.abs_diff(target_samples) <= 1 {
        let mut exact = vec![vec![0.0; target_samples]; AUDIO_OUTPUT_CHANNELS];
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            if let Some(source) = pcm.get(channel) {
                let count = source.len().min(target_samples);
                exact[channel][..count].copy_from_slice(&source[..count]);
            }
        }
        return exact;
    }

    let speed = source_samples as f64 / target_samples as f64;

    // atempo d'abord : le WSOLA ci-dessous fait le même time-stretch préservant la hauteur,
    // mais coûte un ordre de grandeur de plus. Mesuré en release sur une région de 5 min
    // (14,4 M échantillons) : 0,6 s contre 20 s à 1,25×, 4,9 s contre 55 s à 0,25× — et
    // c'est le WSOLA APRÈS la correction de `discard_below`, qui recopiait tout le buffer
    // restant à chaque grain et faisait tenir un export mesuré (65,4 M échantillons) plus de
    // dix minutes sans finir, l'export paraissant figé à ~80 %. `avfilter_atempo_stretch`
    // rend `None` si la chaîne ne monte pas, si le sink négocie un format inattendu ou si la
    // sortie reste plus courte que la cible ; le WSOLA reste alors le chemin de repli exact
    // d'avant, en journalisant la raison.
    if let Some(stretched) = unsafe { avfilter_atempo_stretch(pcm, target_samples, speed) } {
        return stretched;
    }

    let mut stretcher = WsolaTimeStretcher::new(
        AUDIO_OUTPUT_SAMPLE_RATE,
        AUDIO_OUTPUT_CHANNELS,
        speed,
        target_samples,
    );
    let chunks = [stretcher.push(pcm), stretcher.flush()];
    let mut exact = vec![vec![0.0; target_samples]; AUDIO_OUTPUT_CHANNELS];
    for channel in 0..AUDIO_OUTPUT_CHANNELS {
        let mut written = 0usize;
        for chunk in &chunks {
            let source = &chunk[channel];
            let count = source.len().min(target_samples - written);
            if count > 0 {
                exact[channel][written..written + count].copy_from_slice(&source[..count]);
                written += count;
            }
            if written == target_samples {
                break;
            }
        }
    }
    exact
}

/// Plafond du nombre d'étages atempo chaînés.
///
/// `speed` vient de `source_samples / target_samples`, pas de l'éditeur : une scène corrompue
/// où une poignée d'échantillons vise une cible d'une heure donne un ratio arbitrairement
/// petit, et le chaînage par 0.5 empile alors une trentaine d'étages — plus d'un millier pour
/// un subnormal — chacun avec sa fenêtre d'analyse et sa perte d'amorçage. Huit couvre
/// jusqu'à 0.5⁸ ≈ 0,0039, soit vingt-cinq fois sous `MIN_PLAYBACK_SPEED` (0,1) ; au-delà on
/// rend `None` et le WSOLA, qui n'a pas de bornes, prend le relais.
const ATEMPO_MAX_STAGES: usize = 8;

/// Découpe un facteur de vitesse en facteurs que `atempo` accepte individuellement : le
/// filtre n'admet que [0.5, 100.0], on chaîne donc les dépassements (0.2 → [0.5, 0.5, 0.8],
/// 250 → [100.0, 2.5]) — le produit des facteurs reconstitue la vitesse demandée.
///
/// Rend `None` au-delà de `ATEMPO_MAX_STAGES` maillons. La borne haute est chaînée elle
/// aussi : `MAX_PLAYBACK_SPEED` vaut 100 donc un seul étage suffit à tout ce que l'éditeur
/// produit, mais `speed` est un rapport de longueurs quantifiées, pas la vitesse cliquée, et
/// rien ne garantit qu'il reste sous la borne du filtre.
fn atempo_factors(speed: f64) -> Option<Vec<f64>> {
    let mut factors = Vec::new();
    let mut remaining = speed;
    while remaining > 100.0 || remaining < 0.5 {
        if factors.len() >= ATEMPO_MAX_STAGES {
            return None;
        }
        if remaining > 100.0 {
            factors.push(100.0);
            remaining /= 100.0;
        } else {
            factors.push(0.5);
            remaining /= 0.5;
        }
    }
    factors.push(remaining);
    Some(factors)
}

/// RAII : libère le graphe même en sortie précoce sur erreur.
struct FilterGraphGuard(*mut AVFilterGraph);

impl Drop for FilterGraphGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { avfilter_graph_free(&mut self.0) };
        }
    }
}

/// RAII : libère la trame de drain même en sortie précoce sur erreur.
struct FrameGuard(*mut AVFrame);

impl Drop for FrameGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { av_frame_free(&mut self.0) };
        }
    }
}

/// Taille des trames poussées vers le graphe. Le drain est entrelacé avec l'alimentation
/// (cf. `atempo_drain`) : sans cela `av_buffersrc_add_frame` empile toute la région dans la
/// file du buffersrc — ~523 Mo pour une speed region stéréo de 20 min, en plus du slice
/// d'entrée et de l'accumulateur de sortie.
const ATEMPO_FEED_CHUNK: usize = 4096;

/// Rallonge de silence poussée derrière la région avant l'EOF, par étage atempo.
///
/// atempo laisse tomber la dernière fenêtre de chaque étage. En prolongeant l'entrée d'un
/// silence, la fenêtre perdue devient du silence et le contenu réel sort en entier : mesuré
/// sur le pin ffmpeg n8.1.2 (48 kHz stéréo), le manque tombe de 981 à 217 échantillons pour
/// un étage 0.5×, de 2 735 à 553 pour deux, de 8 234 à 2 676 pour quatre. Au-delà la courbe
/// est plate — un tail 16× plus grand ne change plus rien — ce qui reste est traité par la
/// correction de tempo de `avfilter_atempo_stretch`.
const ATEMPO_PRIME_TAIL: usize = 4096;

/// Marge de sécurité, en échantillons, sur la longueur demandée à la passe corrigée.
///
/// Le manque de la seconde passe n'est pas exactement celui mesuré à la première (le tempo
/// a bougé de moins de 1 %, la chaîne est la même). Viser 64 échantillons de plus fait
/// tomber le résidu du côté du surplus, tronqué : 1,3 ms de contenu en moins plutôt qu'un
/// trou de silence.
const ATEMPO_LENGTH_GUARD: usize = 64;

/// Longueur du silence à pousser derrière la région pour une chaîne donnée.
fn atempo_prime_tail(factors: &[f64], speed: f64) -> usize {
    ATEMPO_PRIME_TAIL
        .saturating_mul(factors.len() + 1)
        .saturating_mul(speed.max(1.0).ceil() as usize)
}

/// Vide le buffersink dans `stretched`, sans jamais y garder plus de `keep` échantillons par
/// plan, et compte dans `produced` TOUT ce qui est sorti — y compris ce qui est jeté.
///
/// Les deux chiffres servent à des choses différentes : `stretched` est le résultat, alors
/// que `produced` mesure ce que la chaîne a réellement rendu pour une entrée de longueur
/// connue, donc son manque (cf. `avfilter_atempo_stretch`).
///
/// Rend `Some(true)` sur EOF, `Some(false)` quand le graphe n'a plus rien de prêt (EAGAIN),
/// `None` sur une vraie panne — l'appelant retombe alors sur WSOLA.
unsafe fn atempo_drain(
    sink_ctx: *mut AVFilterContext,
    frame: *mut AVFrame,
    stretched: &mut PlanarPcm,
    keep: usize,
    produced: &mut usize,
) -> Option<bool> {
    loop {
        let ret = av_buffersink_get_frame(sink_ctx, frame);
        if ret == AVERROR_EAGAIN {
            return Some(false);
        }
        if ret == AVERROR_EOF {
            return Some(true);
        }
        if ret < 0 {
            eprintln!(
                "[openscreen-compositor] atempo: av_buffersink_get_frame a échoué (ret={ret}), repli WSOLA"
            );
            return None;
        }
        let count = (*frame).nb_samples.max(0) as usize;
        let channels = (*frame).ch_layout.nb_channels.max(0) as usize;
        // La chaîne est épinglée en flt entrelacé de bout en bout (cf. `avfilter_atempo_stretch`) ;
        // tout autre format signifie que la négociation a fait autre chose que ce qu'on a
        // demandé, et le désentrelacement ci-dessous lirait n'importe quoi.
        if (*frame).format != AVSampleFormat::AV_SAMPLE_FMT_FLT as i32
            || channels != AUDIO_OUTPUT_CHANNELS
        {
            eprintln!(
                "[openscreen-compositor] atempo: trame de sortie inattendue (format={} canaux={channels}), repli WSOLA",
                (*frame).format
            );
            av_frame_unref(frame);
            return None;
        }
        let wanted = count.min(keep.saturating_sub(stretched[0].len()));
        if wanted > 0 {
            let interleaved = *(*frame).extended_data.add(0) as *const f32;
            let samples =
                std::slice::from_raw_parts(interleaved, count * AUDIO_OUTPUT_CHANNELS);
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                let plane = &mut stretched[channel];
                plane.reserve(wanted);
                for index in 0..wanted {
                    plane.push(samples[index * AUDIO_OUTPUT_CHANNELS + channel]);
                }
            }
        }
        *produced += count;
        av_frame_unref(frame);
    }
}

/// Monte `abuffer → atempo… → abuffersink`, y pousse `pcm` suivi de `prime_tail` échantillons
/// de silence, et rend le nombre total d'échantillons sortis — `stretched` en reçoit les
/// `keep` premiers.
///
/// La chaîne est épinglée en **flt entrelacé** 48 kHz stéréo, pas en fltp : `af_atempo`
/// n'annonce que des formats packed (U8/S16/S32/FLT/DBL, cf. son `query_formats`), donc un
/// abuffer en fltp fait insérer un aresample de conversion et rend une branche planaire du
/// drain inatteignable — mesuré, le sink négociait déjà `AV_SAMPLE_FMT_FLT`. En demandant flt
/// des deux côtés il n'y a aucun filtre de conversion dans le graphe, et l'entrelacement est
/// absorbé par la recopie qu'on fait de toute façon.
unsafe fn atempo_pass(
    pcm: &[Vec<f32>],
    factors: &[f64],
    prime_tail: usize,
    keep: usize,
    stretched: &mut PlanarPcm,
) -> Option<usize> {
    let graph_guard = FilterGraphGuard(avfilter_graph_alloc());
    let graph = graph_guard.0;
    if graph.is_null() {
        return None;
    }

    let abuffer_name = CString::new("abuffer").ok()?;
    let abuffersink_name = CString::new("abuffersink").ok()?;
    let atempo_name = CString::new("atempo").ok()?;
    let abuffer = avfilter_get_by_name(abuffer_name.as_ptr());
    let abuffersink = avfilter_get_by_name(abuffersink_name.as_ptr());
    let atempo = avfilter_get_by_name(atempo_name.as_ptr());
    if abuffer.is_null() || abuffersink.is_null() || atempo.is_null() {
        return None;
    }

    let create_filter = |graph: *mut AVFilterGraph,
                         filter: *const AVFilter,
                         name: &str,
                         args: Option<&str>,
                         options: &[(&str, &str)]|
     -> Option<*mut AVFilterContext> {
        let cname = CString::new(name).ok()?;
        let cargs = match args {
            Some(args) => Some(CString::new(args).ok()?),
            None => None,
        };
        let ctx = avfilter_graph_alloc_filter(graph, filter, cname.as_ptr());
        if ctx.is_null() {
            eprintln!("[openscreen-compositor] atempo: alloc_filter({name}) a rendu null");
            return None;
        }
        // Les options typées se posent entre l'alloc et l'init — `avfilter_init_str` fige la
        // négociation. Un échec n'est pas fatal : l'abuffer porte déjà le format, ceci ne fait
        // que l'imposer aussi côté sink pour qu'aucun build ffmpeg ne puisse y glisser un
        // aresample. Le drain vérifie le format reçu de toute façon.
        for (key, value) in options {
            let ckey = CString::new(*key).ok()?;
            let cvalue = CString::new(*value).ok()?;
            let ret = av_opt_set(
                ctx as *mut std::ffi::c_void,
                ckey.as_ptr(),
                cvalue.as_ptr(),
                AV_OPT_SEARCH_CHILDREN as i32,
            );
            if ret < 0 {
                eprintln!(
                    "[openscreen-compositor] atempo: av_opt_set({name}.{key}={value}) a échoué (ret={ret}), négociation laissée libre"
                );
            }
        }
        // `map_or` consommerait `cargs` et le pointeur rendu par la closure serait dangling
        // avant même l'appel — on emprunte donc pour la durée de l'appel.
        let args_ptr = match &cargs {
            Some(args) => args.as_ptr(),
            None => ptr::null(),
        };
        let ret = avfilter_init_str(ctx, args_ptr);
        if ret < 0 {
            eprintln!(
                "[openscreen-compositor] atempo: init_str({name}, {:?}) a échoué (ret={ret})",
                args.unwrap_or("")
            );
            return None;
        }
        Some(ctx)
    };

    let rate = AUDIO_OUTPUT_SAMPLE_RATE;
    let src_ctx = create_filter(
        graph,
        abuffer,
        "in",
        Some(&format!(
            "time_base=1/{rate}:sample_rate={rate}:sample_fmt=flt:channel_layout=stereo"
        )),
        &[],
    )?;
    let sink_ctx = create_filter(graph, abuffersink, "out", None, &[("sample_fmts", "flt")])?;

    let mut previous = src_ctx;
    for (index, factor) in factors.iter().enumerate() {
        let stage = create_filter(
            graph,
            atempo,
            &format!("atempo{index}"),
            Some(&format!("{factor}")),
            &[],
        )?;
        if avfilter_link(previous, 0, stage, 0) < 0 {
            eprintln!("[openscreen-compositor] atempo: avfilter_link a échoué au maillon {index}");
            return None;
        }
        previous = stage;
    }
    if avfilter_link(previous, 0, sink_ctx, 0) < 0 {
        eprintln!("[openscreen-compositor] atempo: avfilter_link vers le sink a échoué");
        return None;
    }
    if avfilter_graph_config(graph, ptr::null_mut()) < 0 {
        eprintln!("[openscreen-compositor] atempo: avfilter_graph_config a échoué");
        return None;
    }

    let sink_frame = FrameGuard(av_frame_alloc());
    if sink_frame.0.is_null() {
        return None;
    }

    // Alimentation : le PCM passe par trames flt de 4096 échantillons, prolongé par la
    // rallonge de silence. `av_buffersrc_add_frame` déplace les références du frame dans le
    // graphe ; on alloue donc une trame neuve par tranche et on la libère après envoi (le
    // shell est vide à ce point). Le drain est entrelacé ici : sans lui la file du buffersrc
    // porterait toute la région d'un coup. La condition d'arrêt est l'entrée épuisée, PAS
    // « on a de quoi remplir la cible » — s'arrêter là couperait la rallonge, et les derniers
    // grains du contenu réel resteraient dans le graphe.
    let source_samples = pcm.first().map(|plane| plane.len()).unwrap_or(0);
    let total_input = source_samples.saturating_add(prime_tail);
    let mut offset = 0usize;
    let mut produced = 0usize;
    let mut drained_to_eof = false;
    while offset < total_input {
        let count = ATEMPO_FEED_CHUNK.min(total_input - offset);
        let mut frame = av_frame_alloc();
        if frame.is_null() {
            eprintln!("[openscreen-compositor] atempo: av_frame_alloc (feed) a échoué");
            return None;
        }
        (*frame).format = AVSampleFormat::AV_SAMPLE_FMT_FLT as i32;
        (*frame).sample_rate = rate;
        (*frame).nb_samples = count as i32;
        av_channel_layout_default(&mut (*frame).ch_layout, AUDIO_OUTPUT_CHANNELS as i32);
        if av_frame_get_buffer(frame, 0) < 0 {
            eprintln!("[openscreen-compositor] atempo: av_frame_get_buffer (feed) a échoué");
            av_frame_free(&mut frame);
            return None;
        }
        // Un seul plan en flt : on écrit entrelacé. Le `write_bytes` couvre à la fois les
        // canaux absents d'une source mono et la rallonge de silence finale.
        let destination = *(*frame).extended_data.add(0) as *mut f32;
        ptr::write_bytes(destination, 0, count * AUDIO_OUTPUT_CHANNELS);
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            if let Some(plane) = pcm.get(channel) {
                let available = plane.len().saturating_sub(offset).min(count);
                for index in 0..available {
                    *destination.add(index * AUDIO_OUTPUT_CHANNELS + channel) =
                        plane[offset + index];
                }
            }
        }
        (*frame).pts = offset as i64;
        let ret = av_buffersrc_add_frame(src_ctx, frame);
        av_frame_free(&mut frame);
        if ret < 0 {
            eprintln!("[openscreen-compositor] atempo: av_buffersrc_add_frame (offset={offset}) a échoué (ret={ret})");
            return None;
        }
        offset += count;
        if atempo_drain(sink_ctx, sink_frame.0, stretched, keep, &mut produced)? {
            drained_to_eof = true;
            break;
        }
    }

    // EOF : le graphe vide alors ses derniers grains.
    if !drained_to_eof {
        if av_buffersrc_add_frame(src_ctx, ptr::null_mut()) < 0 {
            eprintln!("[openscreen-compositor] atempo: flush du buffersrc a échoué, repli WSOLA");
            return None;
        }
        atempo_drain(sink_ctx, sink_frame.0, stretched, keep, &mut produced)?;
    }
    Some(produced)
}

/// Étire le PCM d'un facteur `speed` via une chaîne `abuffer → atempo… → abuffersink` montée
/// en processus, dans l'avfilter LGPL déjà vendored avec l'app (avfilter-11.dll /
/// libavfilter.so.11 / libavfilter.11.dylib voyagent dans le même lot que avcodec — cf.
/// scripts/fetch-ffmpeg.mjs qui copie TOUTES les av*.dll du build BtbN).
///
/// **Deux passes.** atempo ne rend pas exactement `n/tempo` échantillons : il en manque un
/// nombre fixe par chaîne, indépendant de la longueur de l'entrée (mesuré sur n8.1.2 :
/// ~217 pour un étage, ~550 pour deux, ~2 700 pour quatre, soit jusqu'à 56 ms à 0,1×). Le
/// manque ne se rattrape pas en poussant plus d'entrée — c'est une différence de durée
/// rendue, pas une queue retenue — et le combler par des zéros collait un trou de silence
/// devant le segment suivant, puisque le crossfade equal-power ne couvre que les frontières
/// de clip, jamais la concaténation par segment. La première passe mesure donc le manque sur
/// le contenu réel, sans rien garder, et la seconde demande `cible + manque` pour que le
/// contenu remplisse la cible ; le surplus est tronqué. Aux vitesses > 1 le manque est nul et
/// la seconde passe est sautée.
///
/// Retourne `None` sur toute défaillance (montage, négociation, exécution, sortie plus courte
/// que la cible) : l'appelant retombe alors sur le WSOLA d'origine.
unsafe fn avfilter_atempo_stretch(
    pcm: &[Vec<f32>],
    target_samples: usize,
    speed: f64,
) -> Option<PlanarPcm> {
    if !speed.is_finite() || speed <= 0.0 || target_samples == 0 {
        return None;
    }
    let source_samples = pcm.first().map(|plane| plane.len()).unwrap_or(0);
    if source_samples == 0 {
        return None;
    }

    let planes = |capacity: usize| -> PlanarPcm {
        (0..AUDIO_OUTPUT_CHANNELS)
            .map(|_| Vec::with_capacity(capacity))
            .collect()
    };

    let factors = atempo_factors(speed)?;
    let prime_tail = atempo_prime_tail(&factors, speed);
    let mut stretched = planes(target_samples);
    let produced = atempo_pass(pcm, &factors, prime_tail, target_samples, &mut stretched)?;
    let expected = ((source_samples + prime_tail) as f64 / speed).round() as usize;
    let shortfall = expected.saturating_sub(produced);

    if shortfall > 0 {
        // Le contenu réel s'arrête `shortfall` échantillons avant la cible, et ce qui suit
        // dans `stretched` n'est que la rallonge de silence étirée. On rejoue en demandant
        // une cible plus longue du même montant : la chaîne étant la même, elle en perd
        // autant, et le contenu tombe cette fois pile sur `target_samples`.
        let corrected_target = target_samples + shortfall + ATEMPO_LENGTH_GUARD;
        let corrected_speed = source_samples as f64 / corrected_target as f64;
        let corrected_factors = atempo_factors(corrected_speed)?;
        let corrected_tail = atempo_prime_tail(&corrected_factors, corrected_speed);
        let mut corrected = planes(target_samples);
        atempo_pass(
            pcm,
            &corrected_factors,
            corrected_tail,
            target_samples,
            &mut corrected,
        )?;
        if corrected[0].len() >= target_samples {
            stretched = corrected;
        }
    }

    // Plus court que la cible : la chaîne n'a pas fait son travail. On rend `None` — compléter
    // par des zéros exporterait un trou en se faisant passer pour un succès, et le contrat de
    // `stretch_pcm_to_length` est un repli WSOLA sur échec.
    if stretched[0].len() < target_samples {
        eprintln!(
            "[openscreen-compositor] atempo: sortie de {} échantillons pour une cible de {target_samples} (vitesse {speed}, {} étages), repli WSOLA",
            stretched[0].len(),
            factors.len()
        );
        return None;
    }
    Some(stretched)
}

/// Découpe le PCM gardé avec les mêmes spans et la même quantification frame que la vidéo.
pub fn stretch_clip_pcm_by_speed(
    pcm: &[Vec<f32>],
    speed_segments: &[SpeedSegment],
    output_fps: f64,
) -> PlanarPcm {
    let total_source_samples = pcm.first().map(|channel| channel.len()).unwrap_or(0);
    let mut source_cursor = 0usize;
    let mut chunks: Vec<PlanarPcm> = Vec::with_capacity(speed_segments.len());
    for segment in speed_segments {
        let input_samples = ((segment.end_sec - segment.start_sec)
            * AUDIO_OUTPUT_SAMPLE_RATE as f64)
            .round()
            .max(0.0) as usize;
        let input_start = source_cursor;
        let input_end = (input_start + input_samples).min(total_source_samples);
        source_cursor = input_start + input_samples;
        let output_samples = ((segment.frame_count as f64 / output_fps)
            * AUDIO_OUTPUT_SAMPLE_RATE as f64)
            .round()
            .max(0.0) as usize;
        if input_end <= input_start {
            chunks.push(vec![vec![0.0; output_samples]; AUDIO_OUTPUT_CHANNELS]);
            continue;
        }
        let slice: PlanarPcm = (0..AUDIO_OUTPUT_CHANNELS)
            .map(|channel| pcm[channel][input_start..input_end].to_vec())
            .collect();
        chunks.push(stretch_pcm_to_length(&slice, output_samples));
    }

    let mut output = vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
    for chunk in chunks {
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            output[channel].extend_from_slice(&chunk[channel]);
        }
    }
    output
}

#[derive(Clone, Copy)]
pub struct AudioConcatSegmentPlan {
    pub start_sample: usize,
    pub sample_count: usize,
    pub silence: bool,
}

pub struct AudioConcatPlan {
    pub total_samples: usize,
    pub segments: Vec<AudioConcatSegmentPlan>,
}

/// Les offsets sont la somme ENTIÈRE des longueurs arrondies clip par clip ; recalculer depuis
/// une durée cumulée ferait dériver les jonctions sur une longue timeline.
pub fn build_audio_concat_plan(
    output_frame_counts: &[u64],
    has_audio: &[bool],
    output_fps: f64,
) -> AudioConcatPlan {
    let mut cursor = 0usize;
    let mut segments = Vec::with_capacity(output_frame_counts.len());
    for (index, &frame_count) in output_frame_counts.iter().enumerate() {
        let sample_count = if output_fps > 0.0 {
            ((frame_count as f64 / output_fps) * AUDIO_OUTPUT_SAMPLE_RATE as f64)
                .round()
                .max(0.0) as usize
        } else {
            0
        };
        segments.push(AudioConcatSegmentPlan {
            start_sample: cursor,
            sample_count,
            silence: !has_audio.get(index).copied().unwrap_or(false),
        });
        cursor += sample_count;
    }
    AudioConcatPlan { total_samples: cursor, segments }
}

pub fn assemble_concatenated_pcm(
    clip_pcm: &[Option<PlanarPcm>],
    plan: &AudioConcatPlan,
) -> PlanarPcm {
    let mut output = vec![vec![0.0f32; plan.total_samples]; AUDIO_OUTPUT_CHANNELS];
    for (index, segment) in plan.segments.iter().enumerate() {
        if segment.sample_count == 0 || segment.silence {
            continue;
        }
        let Some(Some(pcm)) = clip_pcm.get(index) else {
            continue;
        };
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            let Some(source) = pcm.get(channel) else {
                continue;
            };
            let count = segment.sample_count.min(source.len());
            output[channel][segment.start_sample..segment.start_sample + count]
                .copy_from_slice(&source[..count]);
        }
    }

    for boundary in plan.segments.windows(2) {
        let current = boundary[0];
        let next = boundary[1];
        let fade = AUDIO_BOUNDARY_FADE_SAMPLES
            .min(current.sample_count / 2)
            .min(next.sample_count / 2);
        if fade == 0 {
            continue;
        }
        let tail_start = current.start_sample + current.sample_count - fade;
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            for k in 0..fade {
                let phase = (k as f32 / fade as f32) * PI * 0.5;
                output[channel][tail_start + k] *= phase.cos();
                output[channel][next.start_sample + k] *= phase.sin();
            }
        }
    }
    output
}

/// Mix imported audio tracks (issue #350) over the assembled programme.
///
/// Each track is decoded across its trim window — already resampled to 48 kHz
/// stereo by `decode_clip_audio`, the same path a clip's own audio takes — scaled
/// by its per-track gain (the same `10^(dB/20)` law as `finish_audio`), and summed
/// into the programme at `start_sec`. The programme length is NOT extended: a
/// track that runs past the video is truncated to it, so the audio and video
/// streams stay the same length for the muxer.
///
/// The decode window is capped up front at the room left in the programme after
/// `start_sec`, and a track starting at/after the end is skipped without decoding.
/// `decode_clip_audio` preallocates from the window, so this keeps a long track
/// pinned near a short programme's end from buffering (and clamping away) hours of
/// PCM. `trim_end_sec` must therefore be concrete — the renderer sends
/// `trimEnd ?? durationSec`.
///
/// A track whose file has no decodable audio is skipped — the same degradation a
/// stream-less clip gets.
///
/// Voiceovers go in first, because they are part of what the music ducks under: once they
/// are summed, the programme IS the voice — the recording's own audio plus every take — and
/// `duck_curve` reads it to lower each music bed while someone speaks.
pub fn mix_external_tracks(mut programme: PlanarPcm, tracks: &[SceneAudioTrack]) -> PlanarPcm {
    if programme.first().map_or(true, Vec::is_empty) {
        return programme;
    }
    let (voice, music): (Vec<&SceneAudioTrack>, Vec<&SceneAudioTrack>) = tracks
        .iter()
        .partition(|track| track.kind == SceneAudioTrackKind::Voiceover);
    for track in voice {
        overlay_external_track(&mut programme, track, &[]);
    }
    if !music.is_empty() {
        let duck = duck_curve(&programme);
        for track in music {
            overlay_external_track(&mut programme, track, &duck);
        }
    }
    programme
}

/// One entry of `mix_external_tracks`: decode its window, level it, sum it in under `duck`.
fn overlay_external_track(programme: &mut PlanarPcm, track: &SceneAudioTrack, duck: &[f32]) {
    let programme_len = programme.first().map(Vec::len).unwrap_or(0);
    let offset = (track.start_sec.max(0.0) * AUDIO_OUTPUT_SAMPLE_RATE as f64).round() as usize;
    // A track that starts at or past the programme end contributes nothing —
    // skip it before decoding anything.
    if offset >= programme_len {
        return;
    }
    let trim_start = track.trim_start_sec.max(0.0);
    let Some(trim_end_full) = track.trim_end_sec else {
        // Without a concrete end there is no safe window to decode (see the doc
        // comment); the renderer always resolves one, so this only guards a
        // hand-written scene.
        return;
    };
    // Cap the decode window at the room left in the programme. Everything past
    // `offset` that overflows is discarded by `overlay_track_pcm` anyway, so
    // decoding it only wastes time and memory — a three-hour track placed at
    // second 9 of a ten-second export must not buffer three hours of PCM.
    let remaining_sec = (programme_len - offset) as f64 / AUDIO_OUTPUT_SAMPLE_RATE as f64;
    let trim_end = trim_end_full.min(trim_start + remaining_sec);
    // The track's own length, before that cap. The fades belong to the track, not to
    // whatever the programme had room for — capping first and measuring after is what
    // made a fade-out ramp down at the truncation point instead of at the real end.
    let full_len =
        ((trim_end_full - trim_start).max(0.0) * AUDIO_OUTPUT_SAMPLE_RATE as f64) as usize;
    if trim_end <= trim_start {
        return;
    }
    let decoded = match decode_clip_audio(&track.path, trim_start, trim_end) {
        Ok(Some(pcm)) => pcm,
        _ => return,
    };
    // The app's own range is -60..+12 dB (the inspector slider); clamping at
    // -12 here floored every quiet bed at a tenth of the attenuation asked for.
    // A voiceover is voice, levelled like the recording (see `loudness_gain_db`); its
    // own gain then trims from there, exactly as the preview applies it.
    let normalisation = match track.kind {
        SceneAudioTrackKind::Voiceover => loudness_gain_db(&track.path),
        SceneAudioTrackKind::Music => 0.0,
    };
    let gain = 10.0f32.powf((track.gain_db.clamp(-60.0, 12.0) + normalisation) / 20.0);
    overlay_track_pcm(
        programme,
        &decoded,
        offset,
        gain,
        track.fade_in_sec.max(0.0),
        track.fade_out_sec.max(0.0),
        full_len,
        duck,
    );
}

/// How much of a hit file gets decoded. The bundled samples are a few hundred milliseconds;
/// the window is what keeps a wrong path from buffering an hour of "click".
/// ponytail: fixed window, read the file's own duration if longer hits are ever shipped.
const CLICK_HIT_WINDOW_SEC: f64 = 1.0;

/// Sum the take's click hits over the assembled programme: two decodes for the whole take,
/// then one add per hit — unlike an imported track, which decodes once per placement.
///
/// The hits arrive already placed on the programme by the app, through the projection it lays
/// imported audio tracks out with, so speeding a section up cannot leave the sound behind.
pub fn mix_click_hits(mut programme: PlanarPcm, clicks: &SceneClickSound) -> PlanarPcm {
    if clicks.hits.is_empty()
        || clicks.down_path.is_empty()
        || clicks.up_path.is_empty()
        || programme.first().map_or(true, Vec::is_empty)
    {
        return programme;
    }
    let (down, up) = (
        decode_click_hit(&clicks.down_path),
        decode_click_hit(&clicks.up_path),
    );
    if down.is_empty() || up.is_empty() {
        eprintln!("[audio] click hits undecodable; export keeps the picture only");
        return programme;
    }
    overlay_click_hits(&mut programme, &down, &up, &clicks.hits);
    programme
}

fn decode_click_hit(path: &str) -> PlanarPcm {
    decode_clip_audio(path, 0.0, CLICK_HIT_WINDOW_SEC)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Placement and level, with no ffmpeg in sight. `overlay_track_pcm` truncates at the
/// programme's end, so a hit the edit pushed past it is simply not heard.
fn overlay_click_hits(
    programme: &mut PlanarPcm,
    down: &PlanarPcm,
    up: &PlanarPcm,
    hits: &[SceneClickHit],
) {
    for hit in hits {
        let offset = (hit.time_sec.max(0.0) * AUDIO_OUTPUT_SAMPLE_RATE as f64).round() as usize;
        let gain = hit.gain.clamp(0.0, 4.0);
        overlay_track_pcm(
            programme,
            if hit.release { up } else { down },
            offset,
            gain,
            0.0,
            0.0,
            0,
            &[],
        );
    }
}

/// How far a music bed dips while someone speaks.
pub const DUCK_DEPTH_DB: f32 = -10.0;
/// A 10 ms stretch of the voice counts as speech above this RMS level. The voice is already
/// loudness-normalised here, so speech sits well above it, and a room's noise floor — even
/// raised by the normalisation's full boost — well below.
const DUCK_THRESHOLD_DBFS: f32 = -35.0;
/// Pauses shorter than this keep the music down: the gaps between words and phrases.
const DUCK_HOLD_SEC: f64 = 0.5;
/// The dip starts this long before the voice does, so the first syllable is already clear.
const DUCK_ATTACK_SEC: f64 = 0.25;
/// And takes this long to come back up once a pause outlasts the hold.
const DUCK_RELEASE_SEC: f64 = 0.6;
/// Resolution of the envelope: 10 ms.
const DUCK_BLOCK: usize = AUDIO_OUTPUT_SAMPLE_RATE as usize / 100;

/// The gain a music bed takes under `voice`, one linear value per `DUCK_BLOCK` of the
/// programme: 1 in the clear, `DUCK_DEPTH_DB` while someone speaks, with straight ramps in dB
/// between. The export holds the whole voice, so it looks ahead: the dip is already complete
/// when the first word starts.
fn duck_curve(voice: &PlanarPcm) -> Vec<f32> {
    let len = voice.first().map(Vec::len).unwrap_or(0);
    let blocks = len.div_ceil(DUCK_BLOCK);
    let threshold = 10.0f32.powf(DUCK_THRESHOLD_DBFS / 10.0);
    let speaking: Vec<bool> = (0..blocks)
        .map(|block| {
            let range = block * DUCK_BLOCK..((block + 1) * DUCK_BLOCK).min(len);
            let samples = (range.len() * voice.len()) as f32;
            let energy: f32 = voice
                .iter()
                .map(|channel| channel[range.clone()].iter().map(|s| s * s).sum::<f32>())
                .sum();
            energy / samples > threshold
        })
        .collect();
    let blocks_of = |sec: f64| (sec * 100.0).round() as usize;
    let (attack, hold, release) = (
        blocks_of(DUCK_ATTACK_SEC),
        blocks_of(DUCK_HOLD_SEC),
        blocks_of(DUCK_RELEASE_SEC),
    );
    // Down from `attack` blocks before any speech until `hold` blocks after it.
    let mut ducked = vec![false; blocks];
    let mut last = None;
    for block in 0..blocks {
        if speaking[block] {
            last = Some(block);
        }
        ducked[block] = last.is_some_and(|spoken| block - spoken <= hold);
    }
    let mut next = None;
    for block in (0..blocks).rev() {
        if speaking[block] {
            next = Some(block);
        }
        ducked[block] |= next.is_some_and(|spoken| spoken - block <= attack);
    }
    let (down, up) = (
        DUCK_DEPTH_DB / attack as f32,
        -DUCK_DEPTH_DB / release as f32,
    );
    let mut db = 0.0f32;
    ducked
        .into_iter()
        .map(|down_here| {
            db = if down_here {
                (db + down).max(DUCK_DEPTH_DB)
            } else {
                (db + up).min(0.0)
            };
            10.0f32.powf(db / 20.0)
        })
        .collect()
}

/// `duck_curve` at one programme sample, interpolated between its blocks so the level never
/// steps. An empty curve is no ducking at all.
fn duck_gain_at(curve: &[f32], sample: usize) -> f32 {
    let block = sample / DUCK_BLOCK;
    let Some(&from) = curve.get(block).or(curve.last()) else {
        return 1.0;
    };
    let to = curve.get(block + 1).copied().unwrap_or(from);
    from + (to - from) * (sample % DUCK_BLOCK) as f32 / DUCK_BLOCK as f32
}

/// Sum one decoded track into the programme at `offset` samples, scaled by `gain`,
/// truncated at the programme's end. Split out of `mix_external_tracks` so the
/// placement/gain/clamp math is testable without ffmpeg, exactly like
/// `mix_aligned_tracks` is split from the decode above.
fn overlay_track_pcm(
    programme: &mut PlanarPcm,
    decoded: &PlanarPcm,
    offset: usize,
    gain: f32,
    fade_in_sec: f64,
    fade_out_sec: f64,
    // The track's length before the programme cap, in samples, or 0 when nothing capped it.
    // `decoded` may be shorter because the decode window was capped at the room left in the
    // programme; the ramps belong to the track, not to the room.
    full_len: usize,
    // `duck_curve` over the programme for a music bed, empty for a voiceover.
    duck: &[f32],
) {
    let programme_len = programme.first().map(Vec::len).unwrap_or(0);
    if offset >= programme_len {
        return;
    }
    let room = programme_len - offset;
    // The ramps are measured against the DECODED length, not the room left in the
    // programme: a track running past the end is cut off there, and a fade-out
    // timed to the cut would ramp down over audio the export never reaches.
    let decoded_len = decoded.iter().map(Vec::len).max().unwrap_or(0);
    let envelope_len = full_len.max(decoded_len);
    let (fade_in, fade_out) = resolve_fade_samples(envelope_len, fade_in_sec, fade_out_sec);
    for channel in 0..AUDIO_OUTPUT_CHANNELS {
        let Some(source) = decoded.get(channel) else {
            continue;
        };
        let count = source.len().min(room);
        let dst = &mut programme[channel];
        for k in 0..count {
            dst[offset + k] += source[k]
                * gain
                * fade_envelope(k, envelope_len, fade_in, fade_out)
                * duck_gain_at(duck, offset + k);
        }
    }
}

/// Fade lengths in samples, reduced to fit inside `len`.
///
/// Fades that do not fit share the window in proportion rather than being clamped
/// independently: clamping each to the length first would turn an asymmetric pair
/// into a symmetric one, losing the shape asked for. Kept identical to the app's
/// `resolveFadeSecs` so the preview and the render agree.
fn resolve_fade_samples(len: usize, fade_in_sec: f64, fade_out_sec: f64) -> (usize, usize) {
    if len == 0 {
        return (0, 0);
    }
    let rate = AUDIO_OUTPUT_SAMPLE_RATE as f64;
    let mut fade_in = fade_in_sec.max(0.0) * rate;
    let mut fade_out = fade_out_sec.max(0.0) * rate;
    let total = fade_in + fade_out;
    if total > len as f64 && total > 0.0 {
        let scale = len as f64 / total;
        fade_in *= scale;
        fade_out *= scale;
    }
    (fade_in.round() as usize, fade_out.round() as usize)
}

/// Linear ramp factor at sample `k` of a `len`-sample track.
fn fade_envelope(k: usize, len: usize, fade_in: usize, fade_out: usize) -> f32 {
    let mut v = 1.0f32;
    if fade_in > 0 && k < fade_in {
        v = v.min(k as f32 / fade_in as f32);
    }
    if fade_out > 0 && len > k {
        let remaining = len - k;
        if remaining <= fade_out {
            v = v.min(remaining as f32 / fade_out as f32);
        }
    }
    v
}

/// Encodeur AAC attaché au muxer avant son header. Les paquets utilisent le même interleaver
/// que la vidéo ; les pts restent en unités échantillon jusqu'au rescale vers l'AVStream.
pub(crate) struct AacEncoder {
    context: *mut AVCodecContext,
    stream: *mut AVStream,
    packet: *mut AVPacket,
}

impl AacEncoder {
    pub(crate) unsafe fn open(output: *mut AVFormatContext) -> Result<Self> {
        let name = CString::new("aac")?;
        let codec = avcodec_find_encoder_by_name(name.as_ptr());
        if codec.is_null() {
            bail!("encodeur aac introuvable");
        }
        let context = avcodec_alloc_context3(codec);
        if context.is_null() {
            bail!("aac avcodec_alloc_context3");
        }
        (*context).sample_fmt = AVSampleFormat::AV_SAMPLE_FMT_FLTP;
        (*context).sample_rate = AUDIO_OUTPUT_SAMPLE_RATE;
        (*context).bit_rate = AUDIO_BITRATE;
        (*context).time_base = AVRational { num: 1, den: AUDIO_OUTPUT_SAMPLE_RATE };
        av_channel_layout_default(&mut (*context).ch_layout, AUDIO_OUTPUT_CHANNELS as i32);
        averr(avcodec_open2(context, codec, ptr::null_mut()), "aac avcodec_open2")?;

        let stream = avformat_new_stream(output, ptr::null());
        if stream.is_null() {
            bail!("aac avformat_new_stream");
        }
        averr(
            avcodec_parameters_from_context((*stream).codecpar, context),
            "aac parameters_from_context",
        )?;
        (*stream).time_base = (*context).time_base;
        let packet = av_packet_alloc();
        if packet.is_null() {
            bail!("aac av_packet_alloc");
        }
        Ok(Self { context, stream, packet })
    }

    pub(crate) unsafe fn encode(&mut self, pcm: &[Vec<f32>], output: *mut AVFormatContext) -> Result<()> {
        let total_samples = pcm.first().map(|channel| channel.len()).unwrap_or(0);
        let frame_size = if (*self.context).frame_size > 0 {
            (*self.context).frame_size as usize
        } else {
            1024
        };
        let mut offset = 0usize;
        while offset < total_samples {
            let sample_count = frame_size.min(total_samples - offset);
            let mut frame = av_frame_alloc();
            if frame.is_null() {
                bail!("aac av_frame_alloc");
            }
            (*frame).format = (*self.context).sample_fmt as i32;
            (*frame).sample_rate = AUDIO_OUTPUT_SAMPLE_RATE;
            (*frame).nb_samples = sample_count as i32;
            averr(
                av_channel_layout_copy(&mut (*frame).ch_layout, &(*self.context).ch_layout),
                "aac channel_layout_copy",
            )?;
            averr(av_frame_get_buffer(frame, 0), "aac frame_get_buffer")?;
            averr(av_frame_make_writable(frame), "aac frame_make_writable")?;
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                let destination = *(*frame).extended_data.add(channel) as *mut f32;
                ptr::write_bytes(destination, 0, sample_count);
                if let Some(source) = pcm.get(channel) {
                    let available = source.len().saturating_sub(offset).min(sample_count);
                    if available > 0 {
                        ptr::copy_nonoverlapping(source.as_ptr().add(offset), destination, available);
                    }
                }
            }
            (*frame).pts = offset as i64;
            averr(avcodec_send_frame(self.context, frame), "aac send_frame")?;
            self.drain(output)?;
            av_frame_free(&mut frame);
            offset += sample_count;
        }
        averr(avcodec_send_frame(self.context, ptr::null()), "aac flush")?;
        self.drain(output)
    }

    unsafe fn drain(&mut self, output: *mut AVFormatContext) -> Result<()> {
        loop {
            let ret = avcodec_receive_packet(self.context, self.packet);
            if ret == AVERROR_EAGAIN || ret == AVERROR_EOF {
                return Ok(());
            }
            averr(ret, "aac receive_packet")?;
            (*self.packet).stream_index = (*self.stream).index;
            av_packet_rescale_ts(self.packet, (*self.context).time_base, (*self.stream).time_base);
            averr(
                av_interleaved_write_frame(output, self.packet),
                "aac interleaved_write_frame",
            )?;
            av_packet_unref(self.packet);
        }
    }
}

impl Drop for AacEncoder {
    fn drop(&mut self) {
        unsafe {
            av_packet_free(&mut self.packet);
            avcodec_free_context(&mut self.context);
        }
    }
}

#[cfg(test)]
mod hold_tests {
    use super::*;

    /// Les images tenues allongent le CRÉNEAU audio du clip sans allonger son PCM, et
    /// `assemble_concatenated_pcm` laisse des zéros dans ce qui dépasse. Le silence d'une
    /// pause est donc gratuit : aucun fichier muet à décoder, aucune entrée de mix en plus.
    #[test]
    fn a_longer_slot_than_pcm_leaves_silence_at_its_tail() {
        // 2s de créneau à 1 fps, mais seulement 1s de PCM décodé.
        let plan = build_audio_concat_plan(&[2], &[true], 1.0);
        let one_sec = AUDIO_OUTPUT_SAMPLE_RATE as usize;
        let pcm = vec![Some(vec![vec![0.5f32; one_sec]; AUDIO_OUTPUT_CHANNELS])];
        let out = assemble_concatenated_pcm(&pcm, &plan);
        assert_eq!(out[0].len(), 2 * one_sec);
        assert!((out[0][0] - 0.5).abs() < 1e-6, "le vrai son est bien là");
        assert_eq!(out[0][2 * one_sec - 1], 0.0, "la queue du créneau est du silence");
    }

    /// Et le son réel n'est PAS étiré pour remplir le créneau : la voix garde son rythme.
    #[test]
    fn the_clips_own_audio_is_not_stretched_to_fill_the_hold() {
        let plan = build_audio_concat_plan(&[4], &[true], 1.0);
        let one_sec = AUDIO_OUTPUT_SAMPLE_RATE as usize;
        let mut source = vec![0.0f32; one_sec];
        source[0] = 1.0;
        let pcm = vec![Some(vec![source.clone(), source])];
        let out = assemble_concatenated_pcm(&pcm, &plan);
        // L'impulsion reste au premier échantillon, pas répartie sur quatre secondes.
        assert!((out[0][0] - 1.0).abs() < 1e-6);
        assert_eq!(out[0][1], 0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Même contenu sur les deux canaux : le mixage travaille canal par canal, donc asserter sur
    /// un seul suffit, mais les deux plans doivent exister (le format de sortie est stéréo).
    fn planar(samples: &[f32]) -> PlanarPcm {
        vec![samples.to_vec(), samples.to_vec()]
    }

    /// Un sinus 440 Hz de `secs` secondes sur les deux canaux.
    fn sine(secs: f64) -> PlanarPcm {
        let total = (secs * AUDIO_OUTPUT_SAMPLE_RATE as f64).round() as usize;
        let mut pcm: PlanarPcm = vec![Vec::with_capacity(total); AUDIO_OUTPUT_CHANNELS];
        for i in 0..total {
            let t = i as f32 / AUDIO_OUTPUT_SAMPLE_RATE as f32;
            let sample = (2.0 * PI * 440.0 * t).sin() * 0.5;
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                pcm[channel].push(sample);
            }
        }
        pcm
    }

    /// Hauteur mesurée par passages à zéro montants sur une fenêtre d'une seconde.
    fn pitch_hz(plane: &[f32], start: usize) -> usize {
        let window = (AUDIO_OUTPUT_SAMPLE_RATE as usize).min(plane.len().saturating_sub(start + 1));
        (start..start + window)
            .filter(|&i| plane[i] <= 0.0 && plane[i + 1] > 0.0)
            .count()
    }

    /// Énergie RMS des `count` derniers échantillons.
    fn tail_rms(plane: &[f32], count: usize) -> f32 {
        let start = plane.len().saturating_sub(count);
        let slice = &plane[start..];
        if slice.is_empty() {
            return 0.0;
        }
        (slice.iter().map(|v| v * v).sum::<f32>() / slice.len() as f32).sqrt()
    }

    /// Les presets réellement cliquables dans l'éditeur (`SPEED_OPTIONS`), plus les bornes
    /// `MIN_PLAYBACK_SPEED` / `MAX_PLAYBACK_SPEED` de `src/components/video-editor/types.ts`.
    const EDITOR_SPEEDS: [f64; 13] = [
        0.1, 0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2.0, 3.0, 4.0, 5.0, 10.0, 100.0,
    ];

    #[test]
    fn atempo_covers_every_editor_speed_without_a_silent_tail() {
        // Le bug que ce test verrouille : atempo n'émet jamais sa dernière fenêtre, et
        // compléter le manque par des zéros collait jusqu'à 181 ms de blanc (0,1×, quatre
        // étages) devant le segment suivant — un dropout audible dans un export « réussi ».
        // La rallonge de silence en entrée fait sortir les derniers grains pour de bon, donc
        // la fin de région doit porter autant de signal que son milieu, à toute vitesse et
        // sur des spans courts comme longs.
        for &speed in &EDITOR_SPEEDS {
            for &secs in &[0.05f64, 0.5, 3.0] {
                let pcm = sine(secs);
                let source = pcm[0].len();
                let target = (source as f64 / speed).round() as usize;
                if target == 0 {
                    continue;
                }
                let stretched = unsafe { avfilter_atempo_stretch(&pcm, target, speed) }
                    .unwrap_or_else(|| {
                        panic!("atempo doit couvrir {speed}× sur {secs}s (cible {target})")
                    });
                for plane in &stretched {
                    assert_eq!(plane.len(), target, "vitesse {speed}× durée {secs}s");
                }
                // 10 ms de queue : le zero-padding d'avant en laissait au moins 5 ms à 0,1×.
                // Le trou : un silence numérique en fin de région. Zéro tolérance — la
                // correction de tempo est faite pour que le contenu tombe pile sur la cible.
                let trailing_silence =
                    stretched[0].iter().rev().take_while(|v| **v == 0.0).count();
                assert_eq!(
                    trailing_silence, 0,
                    "{trailing_silence} échantillons de silence en fin de région à {speed}× sur {secs}s"
                );
                let tail = (AUDIO_OUTPUT_SAMPLE_RATE as usize / 100).min(target);
                assert!(
                    tail_rms(&stretched[0], tail) > 0.05,
                    "queue sans énergie à {speed}× sur {secs}s : rms={}",
                    tail_rms(&stretched[0], tail)
                );
            }
        }
    }

    #[test]
    fn atempo_preserves_pitch_through_a_chain_of_stages() {
        // 0,25× et 0,1× sortent des bornes [0.5, 100] d'un seul atempo et passent donc par
        // la chaîne multi-étages — le cas que le test d'origine (1,25×, un seul maillon)
        // ne touchait pas, alors que 0,25× est un preset de la liste déroulante.
        for &speed in &[0.1f64, 0.25, 0.5] {
            let pcm = sine(2.0);
            let target = (pcm[0].len() as f64 / speed).round() as usize;
            let stretched = unsafe { avfilter_atempo_stretch(&pcm, target, speed) }
                .unwrap_or_else(|| panic!("la chaîne atempo doit monter à {speed}×"));
            let measured = pitch_hz(&stretched[0], target / 2);
            assert!(
                (measured as f64 - 440.0).abs() <= 2.0,
                "hauteur à {speed}× : {measured} Hz (un rééchantillonnage la déplacerait)"
            );
        }
    }

    #[test]
    fn stretch_pcm_to_length_is_exact_at_every_editor_speed() {
        // Contrat de bout en bout, repli WSOLA compris : quelle que soit la branche prise,
        // la longueur rendue est exactement celle que le plan de concaténation attend.
        for &speed in &EDITOR_SPEEDS {
            let pcm = sine(0.5);
            let target = (pcm[0].len() as f64 / speed).round() as usize;
            let stretched = stretch_pcm_to_length(&pcm, target);
            assert_eq!(stretched.len(), AUDIO_OUTPUT_CHANNELS);
            for plane in &stretched {
                assert_eq!(plane.len(), target, "vitesse {speed}×");
            }
        }
    }

    #[test]
    fn wsola_fallback_still_stretches_and_keeps_pitch() {
        // Le chemin de repli reste atteignable (avfilter absent d'un build, graphe qui ne
        // monte pas) et sa recopie de buffer a été remplacée par un curseur de lecture :
        // ce test verrouille qu'il rend toujours la bonne durée à la bonne hauteur.
        let pcm = sine(2.0);
        let speed = 0.5;
        let target = (pcm[0].len() as f64 / speed).round() as usize;
        let mut stretcher = WsolaTimeStretcher::new(
            AUDIO_OUTPUT_SAMPLE_RATE,
            AUDIO_OUTPUT_CHANNELS,
            speed,
            target,
        );
        let mut emitted: PlanarPcm = vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
        for chunk in [stretcher.push(&pcm), stretcher.flush()] {
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                emitted[channel].extend_from_slice(&chunk[channel]);
            }
        }
        // Le WSOLA vise la durée sans la garantir à l'échantillon près : c'est
        // `stretch_pcm_to_length` qui recadre. On tolère 1 % ici.
        let produced = emitted[0].len() as f64;
        assert!(
            (produced - target as f64).abs() / (target as f64) < 0.02,
            "WSOLA a rendu {produced} pour une cible de {target}"
        );
        let measured = pitch_hz(&emitted[0], target / 2);
        assert!(
            (measured as f64 - 440.0).abs() <= 3.0,
            "hauteur WSOLA : {measured} Hz"
        );
    }

    #[test]
    fn atempo_factors_split_out_of_range_speeds() {
        // Dans les bornes : un seul maillon.
        assert_eq!(atempo_factors(1.25), Some(vec![1.25]));
        assert_eq!(atempo_factors(0.5), Some(vec![0.5]));
        // Hors bornes : chaîne dont le produit reconstitue la vitesse.
        assert_eq!(atempo_factors(0.2), Some(vec![0.5, 0.5, 0.8]));
        assert_eq!(atempo_factors(250.0), Some(vec![100.0, 2.5]));
        for speed in [0.07f64, 0.3, 1.0, 3.7, 4_000.0] {
            let product: f64 = atempo_factors(speed).expect("dans le plafond").iter().product();
            assert!((product - speed).abs() < 1e-9, "produit={product} attendu={speed}");
        }
        // MIN_PLAYBACK_SPEED tient largement dans le plafond.
        assert_eq!(atempo_factors(0.1).map(|f| f.len()), Some(4));
    }

    #[test]
    fn atempo_declines_a_chain_it_would_have_to_stack() {
        // `speed` est `source_samples / target_samples`, pas la vitesse cliquée : une scène
        // corrompue où une poignée d'échantillons vise une cible d'une heure produit un
        // ratio arbitrairement petit. Sans plafond le chaînage empilait une trentaine
        // d'étages — plus d'un millier pour un subnormal — chacun avec sa perte d'amorçage.
        assert_eq!(atempo_factors(1.0 / 48_000.0 / 3_600.0), None);
        assert_eq!(atempo_factors(f64::MIN_POSITIVE), None);
        assert_eq!(atempo_factors(1e30), None);
        // Et le repli tient le contrat de longueur : c'est le WSOLA qui prend la main.
        let pcm = sine(0.05);
        let target = pcm[0].len() * 5_000;
        let stretched = stretch_pcm_to_length(&pcm, target);
        for plane in &stretched {
            assert_eq!(plane.len(), target);
        }
    }

    #[test]
    fn single_track_passes_through_unchanged() {
        let track = planar(&[0.25, -0.5, 0.75]);
        let mixed = mix_aligned_tracks(&[(0.0, &track)], 0.0, 3);
        assert_eq!(mixed[0], vec![0.25, -0.5, 0.75]);
        assert_eq!(mixed[1], vec![0.25, -0.5, 0.75]);
    }

    // Imported audio track overlay (issue #350).
    #[test]
    fn overlay_sums_at_offset_with_gain() {
        let mut programme = planar(&[0.1, 0.1, 0.1, 0.1]);
        // ×2 gain, placed at sample offset 1.
        overlay_track_pcm(&mut programme, &planar(&[0.2, 0.2]), 1, 2.0, 0.0, 0.0, 0, &[]);
        assert_eq!(programme[0], vec![0.1, 0.5, 0.5, 0.1]);
        assert_eq!(programme[1], vec![0.1, 0.5, 0.5, 0.1]);
    }

    #[test]
    fn overlay_truncates_a_track_that_runs_past_the_programme() {
        let mut programme = planar(&[0.0, 0.0, 0.0]);
        // A 4-sample track placed at offset 2 has room for only 1 sample.
        overlay_track_pcm(&mut programme, &planar(&[1.0, 1.0, 1.0, 1.0]), 2, 1.0, 0.0, 0.0, 0, &[]);
        assert_eq!(programme[0], vec![0.0, 0.0, 1.0]);
    }

    #[test]
    fn overlay_past_the_end_is_a_no_op() {
        let mut programme = planar(&[0.3, 0.3]);
        overlay_track_pcm(&mut programme, &planar(&[1.0]), 5, 1.0, 0.0, 0.0, 0, &[]);
        assert_eq!(programme[0], vec![0.3, 0.3]);
    }

    fn hit(time_sec: f64, gain: f32, release: bool) -> SceneClickHit {
        SceneClickHit { time_sec, gain, release }
    }

    #[test]
    fn click_hits_sum_at_their_time_and_pick_their_sample() {
        // down is 1.0 and up is 0.5, so the level heard at each offset says which sample played.
        let (down, up) = (planar(&[1.0]), planar(&[0.5]));
        let tick = 1.0 / AUDIO_OUTPUT_SAMPLE_RATE as f64;
        let mut programme = planar(&[0.0, 0.0, 0.0]);
        overlay_click_hits(
            &mut programme,
            &down,
            &up,
            &[
                hit(0.0, 1.0, false),
                hit(tick, 1.0, true),
                hit(2.0 * tick, 0.5, false),
            ],
        );
        assert_eq!(programme[0], vec![1.0, 0.5, 0.5]);
    }

    #[test]
    fn a_click_hit_the_edit_pushed_past_the_programme_is_not_heard() {
        let mut programme = planar(&[0.25, 0.25]);
        overlay_click_hits(
            &mut programme,
            &planar(&[1.0]),
            &planar(&[1.0]),
            &[hit(5.0, 1.0, false)],
        );
        assert_eq!(programme[0], vec![0.25, 0.25]);
    }

    #[test]
    fn click_hits_are_decoded_from_files_and_summed_at_their_time() {
        // The whole point of the scene carrying hits instead of a baked bed: the samples live in
        // their own files and are read here, so this walks the same decode a real track does.
        let dir = std::env::temp_dir();
        let down = dir.join(format!("openscreen-click-down-{}.wav", std::process::id()));
        let up = dir.join(format!("openscreen-click-up-{}.wav", std::process::id()));
        write_wav(&down, &planar(&[0.5, 0.5]));
        write_wav(&up, &planar(&[0.25, 0.25]));
        let clicks = SceneClickSound {
            down_path: down.to_str().unwrap().into(),
            up_path: up.to_str().unwrap().into(),
            hits: vec![hit(0.0, 1.0, false), hit(1.0 / 48_000.0, 1.0, true)],
        };
        let out = mix_click_hits(planar(&[0.0; 4]), &clicks);
        let _ = std::fs::remove_file(&down);
        let _ = std::fs::remove_file(&up);
        // Each sample is two frames long: the press covers 0..1 and the hit placed one frame in
        // covers 1..2, so the seam carries both and the programme is untouched past them.
        assert_eq!(
            out[0].iter().map(|v| (v * 100.0).round() / 100.0).collect::<Vec<_>>(),
            vec![0.5, 0.75, 0.25, 0.0]
        );
    }

    #[test]
    fn mix_external_tracks_skips_empty_windows() {
        let programme = planar(&[0.4, 0.4]);
        let tracks = vec![SceneAudioTrack {
            path: "/nope.mp3".into(),
            start_sec: 0.0,
            gain_db: 0.0,
            trim_start_sec: 2.0,
            trim_end_sec: Some(1.0), // end <= start: empty window, never decoded
            ..Default::default()
        }];
        // The empty window is skipped before any decode, so the programme is
        // untouched even though the path does not exist.
        let out = mix_external_tracks(programme, &tracks);
        assert_eq!(out[0], vec![0.4, 0.4]);
    }

    #[test]
    fn mix_external_tracks_skips_a_track_that_starts_past_the_programme() {
        // 2 samples = ~0.00004 s of programme at 48 kHz; the track starts at 1 s, so
        // its offset is past the end. It must be skipped before any decode is
        // attempted (the path does not exist), never buffering its window.
        let programme = planar(&[0.4, 0.4]);
        let tracks = vec![SceneAudioTrack {
            path: "/nope.mp3".into(),
            start_sec: 1.0,
            gain_db: 0.0,
            trim_start_sec: 0.0,
            trim_end_sec: Some(3600.0),
            ..Default::default()
        }];
        let out = mix_external_tracks(programme, &tracks);
        assert_eq!(out[0], vec![0.4, 0.4]);
    }

    #[test]
    fn single_track_is_not_clamped() {
        // Promesse de non-régression : une source mono-piste ressort telle quelle, y compris
        // hors pleine échelle.
        let track = planar(&[1.5, -1.5]);
        let mixed = mix_aligned_tracks(&[(0.0, &track)], 0.0, 2);
        assert_eq!(mixed[0], vec![1.5, -1.5]);
    }

    #[test]
    fn silent_first_track_does_not_swallow_the_microphone() {
        // Le cas de l'issue #108 : l'enregistreur natif macOS écrit l'audio système en première
        // piste (silencieuse si rien ne joue) et le micro en seconde. `av_find_best_stream` ne
        // rendait que la première, et l'export sortait muet.
        let system_audio = planar(&[0.0, 0.0, 0.0]);
        let microphone = planar(&[0.3, -0.4, 0.5]);
        let mixed = mix_aligned_tracks(&[(0.0, &system_audio), (0.0, &microphone)], 0.0, 3);
        assert_eq!(mixed[0], vec![0.3, -0.4, 0.5]);
    }

    #[test]
    fn tracks_are_summed() {
        let a = planar(&[0.1, 0.2]);
        let b = planar(&[0.2, 0.3]);
        let mixed = mix_aligned_tracks(&[(0.0, &a), (0.0, &b)], 0.0, 2);
        assert!((mixed[0][0] - 0.3).abs() < 1e-6);
        assert!((mixed[0][1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_multi_track_sum_past_full_scale_is_not_clipped_at_decode() {
        // The loudness gain comes next and often brings a hot mix down; squaring the peaks
        // off here would bake in a clip the rest of the chain could have avoided. The
        // limiter in `finish_audio` is the one place the signal meets a ceiling.
        let a = planar(&[0.8, -0.8]);
        let b = planar(&[0.8, -0.8]);
        let mixed = mix_aligned_tracks(&[(0.0, &a), (0.0, &b)], 0.0, 2);
        assert!((mixed[0][0] - 1.6).abs() < 1e-6);
        assert!((mixed[0][1] + 1.6).abs() < 1e-6);
    }

    #[test]
    fn a_track_starting_late_is_zero_padded_at_the_front() {
        // La piste commence 1 ms après le début de la fenêtre demandée : 48 échantillons de
        // silence devant, son contenu ensuite. Sans ce recadrage, sommer désalignerait les pistes.
        let late = planar(&[0.5; 8]);
        let mixed = mix_aligned_tracks(&[(0.001, &late)], 0.0, 64);
        assert_eq!(&mixed[0][..48], &[0.0f32; 48][..]);
        assert_eq!(&mixed[0][48..56], &[0.5f32; 8][..]);
        assert_eq!(&mixed[0][56..], &[0.0f32; 8][..]);
    }

    #[test]
    fn a_track_decoded_early_has_its_prefetch_trimmed() {
        // Le seek audio retombe sur une trame antérieure à la fenêtre : cette prélecture est
        // coupée, pas mixée.
        let mut samples = vec![0.0f32; 48];
        samples.extend_from_slice(&[0.5; 8]);
        let early = planar(&samples);
        let mixed = mix_aligned_tracks(&[(-0.001, &early)], 0.0, 8);
        assert_eq!(mixed[0], vec![0.5; 8]);
    }

    /// The gain must be the SAME scalar the editor preview feeds its GainNode
    /// (`10 ** (dB / 20)`), because that identity is the whole parity guarantee: nothing
    /// else stands between what the editor plays and what this writes.
    #[test]
    fn output_trim_is_the_same_scalar_the_preview_applies() {
        // 0.15 × +12 dB is 0.597, and the waveform between those two samples of opposite sign
        // overshoots them by about a quarter: still under the limiter's ceiling, so nothing
        // but the trim acts.
        for gain_db in [-12.0f32, -6.0206, 0.0, 6.0206, 12.0] {
            let result = finish_audio(
                planar(&[0.15, -0.15]),
                SceneAudio { gain_db },
            );
            let expected = 0.15 * 10.0f32.powf(gain_db / 20.0);
            assert!(
                (result[0][0] - expected).abs() < 1e-6,
                "gain {gain_db} dB: got {}, want {expected}",
                result[0][0]
            );
            assert!((result[0][1] + expected).abs() < 1e-6);
        }
    }

    #[test]
    fn out_of_range_gain_is_clamped_to_the_editor_bound() {
        // A hand-edited project, the AI edition agent, or a future UI change must not be
        // able to ask for a gain the slider cannot display.
        let quiet = finish_audio(planar(&[0.5]), SceneAudio { gain_db: -99.0 });
        let floor = 0.5 * 10.0f32.powf(-12.0 / 20.0);
        assert!((quiet[0][0] - floor).abs() < 1e-6);

        let loud = finish_audio(planar(&[0.1]), SceneAudio { gain_db: 99.0 });
        let ceiling = 0.1 * 10.0f32.powf(12.0 / 20.0);
        assert!((loud[0][0] - ceiling).abs() < 1e-6);
    }

    #[test]
    fn fades_that_fit_are_left_alone() {
        let rate = AUDIO_OUTPUT_SAMPLE_RATE as f64;
        let (fin, fout) = resolve_fade_samples(rate as usize, 0.1, 0.2);
        assert_eq!(fin, (0.1 * rate).round() as usize);
        assert_eq!(fout, (0.2 * rate).round() as usize);
    }

    #[test]
    fn fades_too_long_for_the_track_share_it_in_proportion() {
        // 6 s + 4 s of fade on a 2 s track → 1.2 s / 0.8 s, not a clamped 1 s / 1 s.
        // Mirrors `resolveFadeSecs` on the app side; the two must agree or the
        // preview and the render shape the same track differently.
        let rate = AUDIO_OUTPUT_SAMPLE_RATE as f64;
        let len = (2.0 * rate) as usize;
        let (fin, fout) = resolve_fade_samples(len, 6.0, 4.0);
        assert_eq!(fin, (1.2 * rate).round() as usize);
        assert_eq!(fout, (0.8 * rate).round() as usize);
        assert!(fin + fout <= len + 1);
    }

    #[test]
    fn a_fade_in_longer_than_the_track_still_reaches_full_volume() {
        // Left unreduced this holds the gain near zero for the whole track — the
        // layer exports silent.
        let (fin, fout) = resolve_fade_samples(100, 10.0, 0.0);
        assert_eq!((fin, fout), (100, 0));
        assert!((fade_envelope(99, 100, fin, fout) - 0.99).abs() < 1e-3);
    }

    #[test]
    fn the_envelope_ramps_at_both_edges_and_holds_between() {
        assert_eq!(fade_envelope(0, 100, 10, 10), 0.0);
        assert!((fade_envelope(5, 100, 10, 10) - 0.5).abs() < 1e-6);
        assert_eq!(fade_envelope(50, 100, 10, 10), 1.0);
        assert!((fade_envelope(95, 100, 10, 10) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn overlay_applies_the_fade_over_the_decoded_length() {
        // The ramps are measured against the DECODED length, not the room left in
        // the programme: a fade-out timed to the programme's end would ramp down
        // over audio the export never reaches.
        let mut programme = planar(&[0.0, 0.0, 0.0, 0.0]);
        let decoded = planar(&[1.0, 1.0, 1.0, 1.0]);
        // A 4-sample fade-in at 48 kHz is far below one sample of real time, so
        // ask for the whole decoded length in seconds.
        let four = 4.0 / AUDIO_OUTPUT_SAMPLE_RATE as f64;
        overlay_track_pcm(&mut programme, &decoded, 0, 1.0, four, 0.0, 0, &[]);
        assert_eq!(programme[0][0], 0.0);
        assert!(programme[0][1] > 0.0 && programme[0][1] < 1.0);
        assert!(programme[0][3] > programme[0][1]);
    }

    #[test]
    fn a_capped_track_keeps_its_fade_out_at_its_real_end() {
        // The decode window is capped at the room left in the programme, so `decoded` is
        // SHORTER than the track. Measuring the ramp against what came back would put the
        // fade-out at the truncation point — the export would hear a track fading out that
        // is in fact being cut off mid-sentence.
        let mut programme = planar(&[0.0, 0.0, 0.0, 0.0]);
        let decoded = planar(&[1.0, 1.0, 1.0, 1.0]);
        let four = 4.0 / AUDIO_OUTPUT_SAMPLE_RATE as f64;
        // The track really runs eight samples; the programme had room for four.
        overlay_track_pcm(&mut programme, &decoded, 0, 1.0, 0.0, four, 8, &[]);
        // Nothing audible has started to ramp: the fade belongs to samples 4..8, which the
        // programme never reaches.
        for k in 0..4 {
            assert_eq!(programme[0][k], 1.0, "sample {k} should be untouched");
        }
    }

    #[test]
    fn a_track_gain_below_the_output_bound_is_honoured() {
        // The per-track gain range is the inspector's -60..+12, NOT the project
        // output trim's ±12: clamping here at -12 floored every quiet bed at a
        // tenth of the attenuation asked for.
        let mut programme = planar(&[0.0]);
        let decoded = planar(&[1.0]);
        let gain = 10.0f32.powf(-40.0 / 20.0);
        overlay_track_pcm(&mut programme, &decoded, 0, gain, 0.0, 0.0, 0, &[]);
        assert!((programme[0][0] - gain).abs() < 1e-9);
        assert!(programme[0][0] < 10.0f32.powf(-12.0 / 20.0));
    }

    /// `secs` of a 1 kHz tone per segment, at the segment's level in dBFS (sine peak, as
    /// EBU Tech 3341 states its test signals), on both channels, phase continuous.
    fn tone_segments(segments: &[(f32, f64)]) -> PlanarPcm {
        let rate = AUDIO_OUTPUT_SAMPLE_RATE as f64;
        let mut plane = Vec::new();
        for &(dbfs, secs) in segments {
            let amplitude = 10.0f32.powf(dbfs / 20.0);
            for _ in 0..(secs * rate).round() as usize {
                let t = plane.len() as f64 / rate;
                plane.push(amplitude * (2.0 * std::f64::consts::PI * 1000.0 * t).sin() as f32);
            }
        }
        vec![plane.clone(), plane]
    }

    fn loudness_of(pcm: &PlanarPcm) -> Option<f64> {
        let mut meter = LoudnessMeter::new();
        meter.push(pcm);
        meter.integrated()
    }

    fn assert_lufs(measured: Option<f64>, expected: f64) {
        let measured = measured.expect("a signal above the absolute gate has a loudness");
        assert!(
            (measured - expected).abs() <= 0.1,
            "measured {measured:.3} LUFS, EBU Tech 3341 wants {expected} ±0.1"
        );
    }

    // The EBU Tech 3341 minimum-requirement cases that exercise what this meter computes:
    // calibration, the relative gate and the absolute gate.
    #[test]
    fn a_stereo_1khz_tone_reads_its_own_level_in_lufs() {
        assert_lufs(loudness_of(&tone_segments(&[(-23.0, 20.0)])), -23.0);
        assert_lufs(loudness_of(&tone_segments(&[(-33.0, 20.0)])), -33.0);
    }

    #[test]
    fn the_relative_gate_ignores_the_quiet_passages() {
        assert_lufs(
            loudness_of(&tone_segments(&[(-36.0, 10.0), (-23.0, 60.0), (-36.0, 10.0)])),
            -23.0,
        );
        assert_lufs(
            loudness_of(&tone_segments(&[(-26.0, 20.0), (-20.0, 20.1), (-26.0, 20.0)])),
            -23.0,
        );
    }

    #[test]
    fn the_absolute_gate_ignores_near_silence() {
        assert_lufs(
            loudness_of(&tone_segments(&[
                (-72.0, 10.0),
                (-36.0, 10.0),
                (-23.0, 60.0),
                (-36.0, 10.0),
                (-72.0, 10.0),
            ])),
            -23.0,
        );
        // Nothing but silence and a tone under the gate: no loudness to correct.
        assert_eq!(loudness_of(&tone_segments(&[(-80.0, 5.0)])), None);
        assert_eq!(loudness_of(&vec![vec![0.0; 48_000]; 2]), None);
    }

    #[test]
    fn feeding_the_meter_in_windows_changes_nothing() {
        // The file walk feeds one minute at a time; the filter state and the 100 ms steps
        // must carry across the seams, uneven ones included.
        let pcm = tone_segments(&[(-30.0, 3.0), (-18.0, 4.0), (-40.0, 3.0)]);
        let mut meter = LoudnessMeter::new();
        let mut start = 0;
        for length in [1usize, 4799, 4801, 100_000, 7] {
            let end = start + length;
            meter.push(&pcm.iter().map(|plane| plane[start..end].to_vec()).collect::<Vec<_>>());
            start = end;
        }
        meter.push(&pcm.iter().map(|plane| plane[start..].to_vec()).collect::<Vec<_>>());
        let whole = loudness_of(&pcm).unwrap();
        assert!((meter.integrated().unwrap() - whole).abs() < 1e-9);
    }

    #[test]
    fn the_gain_brings_a_file_to_the_target_and_caps_the_boost() {
        assert_eq!(loudness_gain_for(Some(-23.0)), 7.0);
        assert_eq!(loudness_gain_for(Some(-10.0)), -6.0);
        // A room-noise recording at −50 LUFS is raised 12 dB, not 34.
        assert_eq!(loudness_gain_for(Some(-50.0)), LOUDNESS_MAX_BOOST_DB as f32);
        assert_eq!(loudness_gain_for(None), 0.0);
    }

    /// A 16-bit stereo 48 kHz WAV of `pcm`: ffmpeg reads it, so the test walks the same
    /// decode as a real recording without a media fixture.
    fn write_wav(path: &std::path::Path, pcm: &PlanarPcm) {
        let frames = pcm[0].len();
        let data_len = (frames * 4) as u32;
        let mut bytes = Vec::with_capacity(44 + frames * 4);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&48_000u32.to_le_bytes());
        bytes.extend_from_slice(&(48_000u32 * 4).to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for index in 0..frames {
            for plane in pcm {
                let value = (plane[index].clamp(-1.0, 1.0) * 32767.0).round() as i16;
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn a_file_is_measured_whole_across_its_windows() {
        // 125 s crosses two window seams and ends inside a third, zero-padded window: the
        // walk must neither stop early nor count the padding.
        let path = std::env::temp_dir().join(format!("openscreen-loudness-{}.wav", std::process::id()));
        write_wav(&path, &tone_segments(&[(-23.0, 5.0), (-29.0, 115.0), (-23.0, 5.0)]));
        let file = path.to_str().unwrap();
        let (_, more) = decode_audio_window(file, 60.0, 120.0).unwrap().unwrap();
        assert!(more, "audio continues past 120 s");
        let (_, more) = decode_audio_window(file, 120.0, 180.0).unwrap().unwrap();
        assert!(!more, "the file ends at 125 s");
        let measured = measure_file_loudness(file).unwrap();
        let expected = loudness_of(&tone_segments(&[(-23.0, 5.0), (-29.0, 115.0), (-23.0, 5.0)]));
        let _ = std::fs::remove_file(&path);
        assert!(
            (measured.unwrap() - expected.unwrap()).abs() < 0.05,
            "file walk {measured:?} vs whole signal {expected:?}"
        );
    }

    #[test]
    fn an_unreadable_file_is_left_as_recorded() {
        assert_eq!(loudness_gain_db("/no/such/recording.mp4"), 0.0);
    }

    #[test]
    fn a_signal_under_the_ceiling_leaves_finishing_untouched() {
        let pcm = sine(1.0);
        let result = finish_audio(pcm.clone(), SceneAudio { gain_db: 0.0 });
        assert_eq!(result, pcm, "the limiter must be transparent below its ceiling");
    }

    #[test]
    fn the_limiter_holds_its_ceiling_and_the_length() {
        // A tone at +6 dBFS with a +12 dB trim on top, and a burst 20 dB hotter still: the
        // old clamp squared every one of these off at full scale.
        let mut pcm = sine(1.0);
        for plane in pcm.iter_mut() {
            for (index, sample) in plane.iter_mut().enumerate() {
                *sample *= if (24_000..24_480).contains(&index) { 40.0 } else { 4.0 };
            }
        }
        let len = pcm[0].len();
        let result = finish_audio(pcm, SceneAudio { gain_db: 12.0 });
        assert_eq!(result[0].len(), len);
        let peak = result.iter().flatten().fold(0.0f32, |peak, s| peak.max(s.abs()));
        assert!(peak <= LIMITER_CEILING * (1.0 + 1e-6), "peak {peak} over the ceiling");
        assert!(peak > LIMITER_CEILING * 0.99, "the ceiling is used, not undershot: {peak}");
    }

    /// The limiter's gain curve on the plain sample peaks, without makeup: the shape of the
    /// ramp and of the release, which the true-peak envelope only widens by its kernel.
    fn limit_on_samples(pcm: &mut PlanarPcm) {
        let envelope: Vec<f32> = (0..pcm[0].len())
            .map(|i| pcm.iter().fold(0.0f32, |peak, channel| peak.max(channel[i].abs())))
            .collect();
        apply_limiter(pcm, &envelope, 1.0);
    }

    #[test]
    fn the_gain_ramps_down_before_a_peak_and_recovers_after_it() {
        // A steady 0.5 with one sample at 2.0 halfway: the level must glide down over the
        // look-ahead to exactly what the peak needs, and come back up afterwards, instead of
        // stepping at the peak.
        let spike = 24_000;
        let mut plane = vec![0.5f32; 48_000];
        plane[spike] = 2.0;
        let mut pcm = vec![plane.clone(), plane];
        limit_on_samples(&mut pcm);
        let out = &pcm[0];
        assert_eq!(out[spike - LIMITER_LOOKAHEAD - 1], 0.5, "untouched before the ramp");
        assert!((out[spike] - LIMITER_CEILING).abs() < 1e-6, "the peak lands on the ceiling");
        let floor = 0.5 * LIMITER_CEILING / 2.0;
        let step = (0.5 - floor) / LIMITER_LOOKAHEAD as f32;
        for index in spike - LIMITER_LOOKAHEAD..spike - 1 {
            let fall = out[index] - out[index + 1];
            assert!(
                fall >= 0.0 && fall <= step * 1.01,
                "sample {index}: a {fall} drop is not a straight {step} ramp"
            );
        }
        // Five release time constants later the gain is back within 1 %.
        let later = spike + (5.0 * LIMITER_RELEASE_SEC * 48_000.0) as usize;
        assert!(out[later] > 0.495 && out[later] <= 0.5, "not recovered: {}", out[later]);
    }

    #[test]
    fn the_limiter_moves_both_channels_together() {
        // A peak on the left alone must lower the right by the same gain, or the stereo
        // image would lurch towards the right on every limited peak.
        let mut pcm = vec![vec![0.5f32; 4_800], vec![0.5f32; 4_800]];
        pcm[0][2_400] = 2.0;
        limit_peaks(&mut pcm);
        assert!((pcm[1][2_400] - 0.5 * LIMITER_CEILING / 2.0).abs() < 1e-6);
    }

    #[test]
    fn a_peak_between_the_samples_is_held_under_the_ceiling() {
        // A full-scale 12 kHz tone sampled 45° off its crests: every sample reads 0.707,
        // under the ceiling, while the waveform they encode peaks at 1.0. Limiting samples
        // let it through untouched; the true-peak limiter must bring the tone itself down.
        let len = 48_000;
        let plane: Vec<f32> = (0..len)
            .map(|i| (PI / 2.0 * i as f32 + PI / 4.0).sin())
            .collect();
        assert!(plane.iter().all(|s| s.abs() <= LIMITER_CEILING), "the samples are all under");
        let result = finish_audio(vec![plane.clone(), plane], SceneAudio { gain_db: 0.0 });
        // Away from the edges the samples are the tone's at 45°: its amplitude is theirs × √2.
        let amplitude = result[0][len / 4..3 * len / 4]
            .iter()
            .fold(0.0f32, |peak, s| peak.max(s.abs()))
            * std::f32::consts::SQRT_2;
        assert!(amplitude <= LIMITER_CEILING * 1.01, "the tone peaks at {amplitude}");
        assert!(amplitude > LIMITER_CEILING * 0.98, "and is not pushed far under: {amplitude}");
    }

    /// True peak in dBTP, measured independently of the limiter's own envelope: 8× instead
    /// of 4×, and a longer Blackman-windowed sinc instead of its short Hann one.
    fn true_peak_dbtp(pcm: &PlanarPcm) -> f64 {
        const FACTOR: usize = 8;
        const HALF: isize = 16;
        let mut peak = 0.0f64;
        for channel in pcm {
            let len = channel.len() as isize;
            for index in 0..len {
                for phase in 0..FACTOR {
                    let fraction = phase as f64 / FACTOR as f64;
                    let mut point = 0.0f64;
                    for tap in (1 - HALF)..=HALF {
                        let source = index + tap;
                        if source < 0 || source >= len {
                            continue;
                        }
                        let t = tap as f64 - fraction;
                        let x = std::f64::consts::PI * t;
                        let sinc = if t == 0.0 { 1.0 } else { x.sin() / x };
                        let w = std::f64::consts::PI * t / HALF as f64;
                        let window = 0.42 + 0.5 * w.cos() + 0.08 * (2.0 * w).cos();
                        point += f64::from(channel[source as usize]) * sinc * window;
                    }
                    peak = peak.max(point.abs());
                }
            }
        }
        20.0 * peak.log10()
    }

    /// A voice-like test signal: four syllables a second of a 150 Hz pulse train with
    /// harmonics up to 20 kHz falling as `1 / k^rolloff`, at uneven levels, every fifth
    /// syllable a pause. `drive` scales the loudest syllable's crests against full scale, and
    /// whatever goes over is clipped there, as a converter would.
    fn voice(secs: f64, rolloff: f64, drive: f64) -> PlanarPcm {
        let rate = AUDIO_OUTPUT_SAMPLE_RATE as f64;
        // 150 Hz is exactly 320 samples at 48 kHz: one period, computed once.
        let period: Vec<f64> = (0..320)
            .map(|i| {
                (1..=133)
                    .map(|k| {
                        let k = f64::from(k);
                        (2.0 * std::f64::consts::PI * 150.0 * k * i as f64 / rate).cos()
                            / k.powf(rolloff)
                    })
                    .sum()
            })
            .collect();
        let crest = period.iter().fold(0.0f64, |peak, s| peak.max(s.abs()));
        let plane: Vec<f32> = (0..(secs * rate) as usize)
            .map(|i| {
                let t = i as f64 / rate;
                let syllable = (t * 4.0) as usize;
                let level = match syllable % 5 {
                    4 => 0.0,
                    other => [1.0, 0.4, 0.52, 0.28][other],
                };
                let envelope = level * (std::f64::consts::PI * t * 4.0).sin().powi(2);
                (envelope * period[i % 320] / crest * drive).clamp(-1.0, 1.0) as f32
            })
            .collect();
        vec![plane.clone(), plane]
    }

    /// `pcm` through the export's own AAC encoder into an .m4a, and back through
    /// `decode_clip_audio`: what a player reads from the exported file.
    fn through_aac(pcm: &PlanarPcm, name: &str) -> PlanarPcm {
        let path = std::env::temp_dir()
            .join(format!("openscreen-{name}-{}.m4a", std::process::id()));
        let file = CString::new(path.to_str().unwrap()).unwrap();
        unsafe {
            let mut output: *mut AVFormatContext = ptr::null_mut();
            let allocated = avformat_alloc_output_context2(
                &mut output,
                ptr::null(),
                ptr::null(),
                file.as_ptr(),
            );
            averr(allocated, "alloc_output_context2").unwrap();
            let mut encoder = AacEncoder::open(output).unwrap();
            let mut io: *mut AVIOContext = ptr::null_mut();
            averr(avio_open(&mut io, file.as_ptr(), AVIO_FLAG_WRITE as i32), "avio_open").unwrap();
            crate::ffi::sn_fmt_set_pb(output, io);
            averr(avformat_write_header(output, ptr::null_mut()), "write_header").unwrap();
            encoder.encode(pcm, output).unwrap();
            averr(av_write_trailer(output), "write_trailer").unwrap();
            drop(encoder);
            avio_closep(&mut io);
            avformat_free_context(output);
        }
        let seconds = pcm[0].len() as f64 / AUDIO_OUTPUT_SAMPLE_RATE as f64;
        let decoded = decode_clip_audio(path.to_str().unwrap(), 0.0, seconds);
        let _ = std::fs::remove_file(&path);
        decoded.unwrap().expect("the file has an audio stream")
    }

    #[test]
    fn a_clipped_voice_exports_under_minus_one_dbtp_and_keeps_what_loudness_it_can() {
        // #1157: a voice clipped at the source, recorded through AAC (which puts its squared
        // crests back over full scale), raised by the loudness gain: the export read +0.5 dBTP.
        let mut recording = through_aac(&voice(8.0, 1.0, 2.0), "clipped-recording");
        let gain = loudness_gain_for(loudness_of(&recording));
        assert!(gain > 1.0, "the fixture needs raising, like #1157's +1.6 dB: {gain}");
        apply_gain_db(&mut recording, gain);
        assert_lufs(loudness_of(&recording), -16.0);
        let hot = true_peak_dbtp(&recording);
        assert!(hot > 1.0, "crests over full scale, like #1157's +4.9 dBTP: {hot:.2}");
        let unmade = limited_loudness(&recording, &true_peak_envelope(&recording), 1.0).unwrap();

        let finished = finish_audio(recording, SceneAudio { gain_db: 0.0 });
        let exported = through_aac(&finished, "clipped-export");
        let peak = true_peak_dbtp(&exported);
        assert!(peak <= -1.0, "true peak {peak:.2} dBTP, over −1");
        // Clipped crests come every pitch period, so the ceiling holds the voiced passages
        // whatever the gain: −16 is out of reach (see `LIMITER_MAX_MAKEUP_DB`). What the
        // makeup can do is give back part of what the limiter took, and never overshoot.
        let loudness = loudness_of(&exported).unwrap();
        assert!(
            loudness > unmade + 0.3,
            "{loudness:.2} LUFS, no better than {unmade:.2} without makeup"
        );
        assert!(loudness < -15.9, "{loudness:.2} LUFS, louder than the normalisation asked");
    }

    #[test]
    fn a_voice_with_a_few_hot_transients_exports_at_the_target_under_minus_one_dbtp() {
        // Not clipped, mellow, with a plosive every two seconds that the loudness gain lifts
        // over the ceiling: the limiter only touches those, and the makeup gives back what it
        // took, so this one lands on −16.
        let mut recording = voice(8.0, 2.0, 0.6);
        for start in (9_000..384_000).step_by(96_000) {
            for offset in 0..96 {
                let burst = 0.9 * (2.0 * PI * 2_000.0 * offset as f32 / 48_000.0).sin();
                for plane in recording.iter_mut() {
                    plane[start + offset] += burst;
                }
            }
        }
        let gain = loudness_gain_for(loudness_of(&recording));
        apply_gain_db(&mut recording, gain);
        assert!(true_peak_dbtp(&recording) > -1.0, "the plosives need limiting");

        let finished = finish_audio(recording, SceneAudio { gain_db: 0.0 });
        let exported = through_aac(&finished, "plosive-export");
        let loudness = loudness_of(&exported).unwrap();
        let peak = true_peak_dbtp(&exported);
        assert!((loudness + 16.0).abs() <= 0.2, "{loudness:.2} LUFS, not −16");
        assert!(peak <= -1.0, "true peak {peak:.2} dBTP, over −1");
    }

    #[test]
    fn sharp_mixed_transients_come_out_under_the_ceiling() {
        // A quiet tone under bursts of 16 random samples up to ±2 and lone clicks of either
        // sign: the gain changes inside the dozen samples an interpolated point reads, which
        // a single pass on the envelope measured beforehand does not account for.
        let mut state = 0x2545_f491_u32;
        let mut random = move || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        };
        let len = 96_000;
        let mut pcm: PlanarPcm = vec![
            (0..len).map(|i| 0.1 * (2.0 * PI * 200.0 * i as f32 / 48_000.0).sin()).collect();
            2
        ];
        for start in (500..len - 32).step_by(1_000) {
            for offset in 0..16 {
                for plane in pcm.iter_mut() {
                    plane[start + offset] += 2.0 * random();
                }
            }
            let click = if random() > 0.0 { 1.8 } else { -1.8 };
            pcm[0][start + 24] += click;
            pcm[1][start + 25] -= click * 0.6;
        }

        let envelope = true_peak_envelope(&pcm);
        let mut single = pcm.clone();
        apply_limiter(&mut single, &envelope, loudness_makeup(&pcm, &envelope));
        let single_peak = true_peak_envelope(&single).into_iter().fold(0.0f32, f32::max);
        assert!(single_peak > LIMITER_CEILING, "the fixture must reach past one pass");

        let result = finish_audio(pcm, SceneAudio { gain_db: 0.0 });
        let peak = true_peak_envelope(&result).into_iter().fold(0.0f32, f32::max);
        assert!(peak <= LIMITER_CEILING * 1.000_01, "{peak} over {LIMITER_CEILING}");
    }

    #[test]
    fn makeup_is_bounded_on_a_signal_that_is_all_peaks() {
        // A full-scale square wave has nothing quieter to raise: the search must stop at its
        // bound instead of driving the gain up without end, and still hold the ceiling.
        let plane: Vec<f32> = (0..48_000)
            .map(|i| if (i / 24) % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let pcm = vec![plane.clone(), plane];
        let envelope = true_peak_envelope(&pcm);
        let makeup = loudness_makeup(&pcm, &envelope);
        assert!(makeup <= 10.0f32.powf(LIMITER_MAX_MAKEUP_DB as f32 / 20.0) * 1.0001);
        let result = finish_audio(pcm, SceneAudio { gain_db: 0.0 });
        assert!(true_peak_envelope(&result).iter().all(|&p| p <= LIMITER_CEILING * 1.01));
    }

    /// The music's level under a voice, in dB, at `sec` into the programme.
    fn duck_db_at(curve: &[f32], sec: f64) -> f32 {
        20.0 * duck_gain_at(curve, (sec * AUDIO_OUTPUT_SAMPLE_RATE as f64) as usize).log10()
    }

    #[test]
    fn music_dips_under_the_voice_and_comes_back_up() {
        // 2 s of room tone, 2 s of speech-level signal, 3 s of room tone.
        let voice = tone_segments(&[(-120.0, 2.0), (-20.0, 2.0), (-120.0, 3.0)]);
        let curve = duck_curve(&voice);
        assert_eq!(duck_db_at(&curve, 0.5), 0.0, "in the clear");
        // Looking ahead: already down when the first word starts, half way down half an
        // attack earlier.
        assert!((duck_db_at(&curve, 2.0) - DUCK_DEPTH_DB).abs() < 0.01);
        assert!((duck_db_at(&curve, 2.0 - DUCK_ATTACK_SEC / 2.0) - DUCK_DEPTH_DB / 2.0).abs() < 0.5);
        assert!((duck_db_at(&curve, 3.0) - DUCK_DEPTH_DB).abs() < 0.01);
        // Held through the hold after the last word, then released over the release.
        assert!((duck_db_at(&curve, 4.0 + DUCK_HOLD_SEC - 0.05) - DUCK_DEPTH_DB).abs() < 0.01);
        let back = 4.0 + DUCK_HOLD_SEC + DUCK_RELEASE_SEC + 0.05;
        assert_eq!(duck_db_at(&curve, back), 0.0, "back up once the pause is long enough");
        // Never a step: from one 10 ms block to the next, the level moves by at most one
        // attack increment.
        let steepest = curve
            .windows(2)
            .map(|pair| (20.0 * (pair[1] / pair[0]).log10()).abs())
            .fold(0.0f32, f32::max);
        let attack_step = -DUCK_DEPTH_DB / (DUCK_ATTACK_SEC * 100.0) as f32;
        assert!(steepest <= attack_step + 1e-3, "a {steepest} dB step in the envelope");
    }

    #[test]
    fn a_breath_between_words_keeps_the_music_down() {
        // Releasing in every gap between words is the pumping a ducker must not do.
        let voice = tone_segments(&[(-20.0, 1.0), (-120.0, 0.3), (-20.0, 1.0)]);
        let curve = duck_curve(&voice);
        for sec in [1.05, 1.15, 1.25] {
            assert!((duck_db_at(&curve, sec) - DUCK_DEPTH_DB).abs() < 0.01, "released at {sec} s");
        }
    }

    #[test]
    fn no_voice_leaves_the_music_alone() {
        // Silence, and a noise floor raised by the normalisation's full boost: neither is
        // someone speaking.
        let floor = -50.0 + LOUDNESS_MAX_BOOST_DB as f32;
        for voice in [tone_segments(&[(-120.0, 2.0)]), tone_segments(&[(floor, 2.0)])] {
            assert!(duck_curve(&voice).iter().all(|&gain| gain == 1.0));
        }
    }

    #[test]
    fn a_music_bed_is_summed_under_the_duck_curve_and_a_voiceover_is_not() {
        let voice = tone_segments(&[(-120.0, 1.0), (-20.0, 1.0)]);
        let curve = duck_curve(&voice);
        let bed = vec![vec![0.5f32; 96_000]; 2];
        let mut ducked = vec![vec![0.0f32; 96_000]; 2];
        overlay_track_pcm(&mut ducked, &bed, 0, 1.0, 0.0, 0.0, 0, &curve);
        let mut flat = vec![vec![0.0f32; 96_000]; 2];
        overlay_track_pcm(&mut flat, &bed, 0, 1.0, 0.0, 0.0, 0, &[]);
        assert_eq!(flat[0][72_000], 0.5, "no curve, no dip");
        assert!((ducked[0][24_000] - 0.5).abs() < 1e-6, "in the clear");
        let under = 0.5 * 10.0f32.powf(DUCK_DEPTH_DB / 20.0);
        assert!((ducked[0][72_000] - under).abs() < 1e-4, "under the voice: {}", ducked[0][72_000]);
    }
}
