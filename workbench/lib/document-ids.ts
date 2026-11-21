import { AsyncLocalStorage } from "node:async_hooks";

export interface DocumentIdLedger {
	schema: 1;
	ids: Array<{ prefix: string; id: string }>;
}

const MAX_ALLOCATIONS = 4096;
const UUID_ID = /^[a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateDocumentIdLedger(value: unknown): asserts value is DocumentIdLedger {
	const v = value as DocumentIdLedger | null;
	if (
		!v ||
		v.schema !== 1 ||
		!Array.isArray(v.ids) ||
		v.ids.length > MAX_ALLOCATIONS ||
		Object.keys(v).sort().join(",") !== "ids,schema"
	) {
		throw new Error("Invalid document ID ledger");
	}
	const seen = new Set<string>();
	for (const entry of v.ids) {
		if (
			!entry ||
			typeof entry.prefix !== "string" ||
			typeof entry.id !== "string" ||
			Object.keys(entry).sort().join(",") !== "id,prefix" ||
			!UUID_ID.test(entry.id) ||
			!entry.id.startsWith(`${entry.prefix}_`) ||
			seen.has(entry.id)
		) {
			throw new Error("Invalid or duplicate document ID allocation");
		}
		seen.add(entry.id);
	}
}

interface Scope {
	ledger: DocumentIdLedger;
	replay?: DocumentIdLedger;
	seen: Set<string>;
	closed: boolean;
	failure?: string;
}
const scopes = new AsyncLocalStorage<Scope>();

/** Workbench instrumentation calls the unchanged production generator in record
 * mode. Replay returns only exact recorded allocations, never fixes model args. */
export function allocateDocumentId(prefix: string, production: () => string): string {
	const scope = scopes.getStore();
	if (!scope) return production();
	const refuse = (message: string): never => {
		scope.failure = message;
		throw new Error(message);
	};
	if (scope.closed || scope.ledger.ids.length >= MAX_ALLOCATIONS) {
		return refuse("Document ID scope closed or allocation limit exceeded");
	}
	const index = scope.ledger.ids.length;
	const expected = scope.replay?.ids[index];
	if (scope.replay && (!expected || expected.prefix !== prefix)) {
		return refuse("Document ID replay allocation order/prefix mismatch");
	}
	const id = expected?.id ?? production();
	if (!UUID_ID.test(id) || !id.startsWith(`${prefix}_`) || scope.seen.has(id)) {
		return refuse("Document ID allocation collides or has an invalid prefix");
	}
	scope.seen.add(id);
	scope.ledger.ids.push({ prefix, id });
	return id;
}

export function documentIdScope(document: unknown, replay?: DocumentIdLedger) {
	if (replay) validateDocumentIdLedger(replay);
	const scope: Scope = {
		ledger: { schema: 1, ids: [] },
		replay,
		seen: new Set(JSON.stringify(document).match(/[a-z]+_[0-9a-f-]{36}/g) ?? []),
		closed: false,
	};
	return {
		ledger: scope.ledger,
		run: <T>(fn: () => Promise<T>) => scopes.run(scope, fn),
		complete: () => {
			if (scope.failure) throw new Error(scope.failure);
			if (replay && scope.ledger.ids.length !== replay.ids.length) {
				throw new Error("Document ID replay ledger was not fully consumed");
			}
		},
		close: () => {
			scope.closed = true;
		},
	};
}
