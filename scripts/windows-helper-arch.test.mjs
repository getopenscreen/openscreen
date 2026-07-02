import { describe, expect, it } from "vitest";
import {
	SUPPORTED_ARCHES,
	normalizeArch,
	resolveTargetArch,
	resolveVcvarsArch,
	winBinDirName,
} from "./windows-helper-arch.mjs";

describe("normalizeArch", () => {
	it("maps known aliases to canonical arches", () => {
		expect(normalizeArch("x64")).toBe("x64");
		expect(normalizeArch("amd64")).toBe("x64");
		expect(normalizeArch("x86_64")).toBe("x64");
		expect(normalizeArch("arm64")).toBe("arm64");
		expect(normalizeArch("aarch64")).toBe("arm64");
		expect(normalizeArch("ARM64")).toBe("arm64");
	});

	it("returns undefined for empty or unknown values", () => {
		expect(normalizeArch(undefined)).toBeUndefined();
		expect(normalizeArch("")).toBeUndefined();
		expect(normalizeArch("mips")).toBeUndefined();
	});
});

describe("resolveTargetArch", () => {
	it("prefers the CLI arch over env and host", () => {
		expect(resolveTargetArch({ cliArch: "arm64", envArch: "x64", hostArch: "x64" })).toBe("arm64");
	});

	it("falls back to env when no CLI arch", () => {
		expect(resolveTargetArch({ envArch: "arm64", hostArch: "x64" })).toBe("arm64");
	});

	it("defaults to the host arch when nothing explicit is given", () => {
		expect(resolveTargetArch({ hostArch: "arm64" })).toBe("arm64");
		expect(resolveTargetArch({ hostArch: "x64" })).toBe("x64");
	});

	it("throws on an invalid explicit arch", () => {
		expect(() => resolveTargetArch({ cliArch: "mips", hostArch: "x64" })).toThrow(/Invalid/);
	});

	it("throws on an unsupported host with no explicit arch", () => {
		expect(() => resolveTargetArch({ hostArch: "ppc64" })).toThrow(/host/i);
	});
});

describe("resolveVcvarsArch", () => {
	it("returns native tokens when host equals target", () => {
		expect(resolveVcvarsArch("x64", "x64")).toBe("x64");
		expect(resolveVcvarsArch("arm64", "arm64")).toBe("arm64");
	});

	it("returns cross tokens as <host>_<target>", () => {
		expect(resolveVcvarsArch("x64", "arm64")).toBe("x64_arm64");
		expect(resolveVcvarsArch("arm64", "x64")).toBe("arm64_x64");
	});
});

describe("winBinDirName", () => {
	it("builds the packaged bin folder name", () => {
		expect(winBinDirName("x64")).toBe("win32-x64");
		expect(winBinDirName("arm64")).toBe("win32-arm64");
	});
});

it("exposes the supported arch list", () => {
	expect(SUPPORTED_ARCHES).toEqual(["x64", "arm64"]);
});
