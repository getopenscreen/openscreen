export interface ProjectAppearanceDefaults {
	wallpaper: string;
	wallpaperMotion: "none" | "drift" | "aurora" | "waves";
	aspectRatio: `${number}:${number}` | "native";
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
	borderRadius: number;
	padding: number;
	webcamLayoutPreset: "picture-in-picture" | "vertical-stack" | "dual-frame" | "no-webcam";
	webcamMaskShape: "rectangle" | "circle" | "square" | "rounded";
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: number;
	webcamPosition: { cx: number; cy: number } | null;
	webcamBackgroundMode: "none" | "transparent" | "blur" | "custom";
	webcamWallpaper: string;
	webcamBlurIntensity: number;
	cursor: {
		size: number;
		smoothing: number;
		motionBlur: number;
		clickBounce: number;
		volume: number;
		clipToBounds: boolean;
		autoHide: boolean;
	};
	cursorShow: boolean;
	cursorAutoHide: boolean;
	cursorTheme: string;
	autoFocusAll: boolean;
}

/** The factory appearance every new project starts from. */
export const DEFAULT_PROJECT_APPEARANCE: ProjectAppearanceDefaults = {
	wallpaper: "/wallpapers/wallpaper1.jpg",
	wallpaperMotion: "none",
	aspectRatio: "16:9",
	shadowIntensity: 0.2,
	showBlur: false,
	motionBlurAmount: 0.2,
	borderRadius: 40,
	padding: 50,
	webcamLayoutPreset: "picture-in-picture",
	webcamMaskShape: "rectangle",
	webcamMirrored: false,
	webcamReactiveZoom: true,
	webcamSizePreset: 25,
	webcamPosition: null,
	webcamBackgroundMode: "none",
	webcamWallpaper: "/wallpapers/wallpaper1.jpg",
	webcamBlurIntensity: 0.5,
	cursor: {
		size: 3,
		smoothing: 0.67,
		motionBlur: 0.35,
		clickBounce: 2.5,
		volume: 0,
		clipToBounds: false,
		autoHide: false,
	},
	cursorShow: true,
	cursorAutoHide: false,
	cursorTheme: "default",
	autoFocusAll: false,
};
