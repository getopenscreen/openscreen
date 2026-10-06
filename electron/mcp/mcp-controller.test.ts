import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentNotFoundError } from "../ai-edition/document-service";
import { McpController } from "./mcp-controller";
import { DEFAULT_MCP_PORT, McpSettingsStore, type McpTokenCrypto } from "./mcp-settings-store";
import type { McpToolDeps } from "./openscreen-mcp-server";

// Reversible and visibly not plaintext, so a test can tell the token was encrypted.
const fakeCrypto: McpTokenCrypto = {
	isEncryptionAvailable: () => true,
	encryptString: (plain) => Buffer.from(`enc:${plain}`),
	decryptString: (encrypted) => encrypted.toString().replace(/^enc:/, ""),
};

const deps: McpToolDeps = {
	host: { snapshot: async () => null, apply: async () => "no-editor" },
	projects: {
		listProjects: async () => [],
		getProject: async (id) => {
			throw new DocumentNotFoundError(id);
		},
		saveProject: async (document) => document,
	},
	editsAllowed: () => true,
	version: "0.0.0",
};

let dir: string;
let controller: McpController | null = null;
let blocker: Server | null = null;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-mcp-"));
});

afterEach(async () => {
	await controller?.stop();
	controller = null;
	await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
	blocker = null;
	rmSync(dir, { recursive: true, force: true });
});

/** A free port, found by binding one and letting it go. */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

async function initializeStatus(url: string, token: string) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "t", version: "0" },
			},
		}),
	});
	return response.status;
}

describe("McpSettingsStore", () => {
	it("is off by default, on the default port", () => {
		const store = new McpSettingsStore(dir, fakeCrypto);
		expect(store.getSettings()).toEqual({
			enabled: false,
			port: DEFAULT_MCP_PORT,
			allowEdits: false,
		});
	});

	it("keeps MCP edits off unless they were turned on explicitly", async () => {
		expect(new McpSettingsStore(dir, fakeCrypto).getSettings().allowEdits).toBe(false);
		await new McpSettingsStore(dir, fakeCrypto).setSettings({ enabled: true });
		expect(new McpSettingsStore(dir, fakeCrypto).getSettings().allowEdits).toBe(false);
		await new McpSettingsStore(dir, fakeCrypto).setSettings({ allowEdits: true });
		expect(new McpSettingsStore(dir, fakeCrypto).getSettings().allowEdits).toBe(true);
	});

	it("keeps the token encrypted on disk and stable across instances", async () => {
		const token = await new McpSettingsStore(dir, fakeCrypto).getToken();
		expect(readFileSync(path.join(dir, "mcp-token.enc"), "utf8")).toBe(`enc:${token}`);
		expect(await new McpSettingsStore(dir, fakeCrypto).getToken()).toBe(token);
	});

	it("refuses a port outside the unprivileged range", async () => {
		const store = new McpSettingsStore(dir, fakeCrypto);
		await expect(store.setSettings({ port: 80 })).rejects.toThrow(/1024/);
	});

	it("will not mint a token without OS encryption", async () => {
		const store = new McpSettingsStore(dir, { ...fakeCrypto, isEncryptionAvailable: () => false });
		await expect(store.getToken()).rejects.toThrow(/safeStorage/);
	});
});

describe("McpController", () => {
	it("does not listen until enabled", async () => {
		controller = new McpController(new McpSettingsStore(dir, fakeCrypto), deps);
		await controller.startIfEnabled();
		const status = await controller.getStatus();
		expect(status.running).toBe(false);
		expect(status.token).toBeNull();
	});

	it("starts on enable and stops on disable", async () => {
		const store = new McpSettingsStore(dir, fakeCrypto);
		await store.setSettings({ port: await freePort() });
		controller = new McpController(store, deps);

		const on = await controller.setEnabled(true);
		expect(on.running).toBe(true);
		expect(await initializeStatus(on.url, on.token ?? "")).toBe(200);

		const off = await controller.setEnabled(false);
		expect(off.running).toBe(false);
		await expect(initializeStatus(on.url, on.token ?? "")).rejects.toThrow();
	});

	it("explains a port that is already taken", async () => {
		const port = await freePort();
		blocker = createServer();
		await new Promise<void>((resolve) => blocker?.listen(port, "127.0.0.1", resolve));
		const store = new McpSettingsStore(dir, fakeCrypto);
		await store.setSettings({ port });
		controller = new McpController(store, deps);

		const status = await controller.setEnabled(true);
		expect(status.running).toBe(false);
		expect(status.error).toContain(String(port));
	});

	it("saves the edit permission without restarting the server", async () => {
		const store = new McpSettingsStore(dir, fakeCrypto);
		await store.setSettings({ port: await freePort() });
		controller = new McpController(store, deps);
		const on = await controller.setEnabled(true);
		expect(on.allowEdits).toBe(false);

		const allowed = await controller.setAllowEdits(true);
		expect(allowed.allowEdits).toBe(true);
		expect(allowed.token).toBe(on.token);
		expect(await initializeStatus(allowed.url, allowed.token ?? "")).toBe(200);
	});

	it("locks out the old token once it is regenerated", async () => {
		const store = new McpSettingsStore(dir, fakeCrypto);
		await store.setSettings({ port: await freePort() });
		controller = new McpController(store, deps);
		const before = await controller.setEnabled(true);
		const after = await controller.regenerateToken();

		expect(after.token).not.toBe(before.token);
		expect(await initializeStatus(after.url, before.token ?? "")).toBe(401);
		expect(await initializeStatus(after.url, after.token ?? "")).toBe(200);
	});
});
