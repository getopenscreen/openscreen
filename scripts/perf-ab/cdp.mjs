// Minimal Chrome DevTools Protocol client over Node's global WebSocket.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listTargets(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/list`);
		return await res.json();
	} catch {
		return null;
	}
}

/** Polls until `pick(targets)` returns a page target, or throws after timeoutMs. */
export async function waitTarget(port, pick, timeoutMs = 60000, everyMs = 20) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const targets = await listTargets(port);
		const t = targets && pick(targets.filter((x) => x.type === "page"));
		if (t) return t;
		await sleep(everyMs);
	}
	throw new Error("target not found in time");
}

export async function connect(target) {
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((ok, ko) => {
		ws.onopen = ok;
		ws.onerror = ko;
	});
	let next = 1;
	const pending = new Map();
	const listeners = [];
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { ok, ko } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? ko(new Error(JSON.stringify(msg.error))) : ok(msg.result);
		} else if (msg.method) {
			for (const l of listeners) l(msg);
		}
	};
	const send = (method, params = {}, sessionId = undefined) =>
		new Promise((ok, ko) => {
			const id = next++;
			pending.set(id, { ok, ko });
			ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (r.exceptionDetails)
			throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
		return r.result.value;
	};
	const key = async (key, code, vk) => {
		await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk });
		await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
	};
	return { send, evaluate, key, on: (fn) => listeners.push(fn), close: () => ws.close() };
}
