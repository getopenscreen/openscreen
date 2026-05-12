// swift-tools-version: 5.9

import PackageDescription

let package = Package(
	name: "OpenScreenScreenCaptureKitHelper",
	platforms: [
		.macOS(.v13)
	],
	products: [
		.executable(
			name: "openscreen-screencapturekit-helper",
			targets: ["OpenScreenScreenCaptureKitHelper"]
		)
	],
	targets: [
		.executableTarget(
			name: "OpenScreenScreenCaptureKitHelper",
			path: "Sources/OpenScreenScreenCaptureKitHelper"
		)
	]
)
