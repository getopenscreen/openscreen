// L0 — native Responses requests are evidence in their own wire shape.
// These assertions intentionally inspect the request objects the provider saw:
// top-level instructions, role-preserving input, flat function schemas, and
// call_id-linked outputs. They do not exercise a live provider.

import { describe, expect, it } from "vitest";
import { hashRequest, hashResponsesRequest } from "../lib/cassette";
import type { CapturedRequest } from "../lib/model-server";
import { applyRequestPolicy, transportIdentity } from "../lib/transport";
import { systemTextOf, wireFromRequests } from "../lib/wire";

function request(round: number, body: unknown): CapturedRequest {
	return { round, systemChars: 0, toolNames: [], messages: [], raw: body };
}

const responsesTransport = transportIdentity({
	wireApi: "responses",
	maxOutputTokens: 2048,
});

describe("native Responses wire transcript", () => {
	it("keeps top-level instructions and input roles in priority order", () => {
		const topInstructions = "Top-level policy: preserve the document and use the supplied tools.";
		const systemText = "System policy from the input history.";
		const developerText = "Developer policy from the input history.";
		const wire = wireFromRequests([
			request(0, {
				model: "gpt-5-test",
				instructions: topInstructions,
				input: [
					{ type: "message", role: "system", content: [{ type: "input_text", text: systemText }] },
					{
						type: "message",
						role: "developer",
						content: [{ type: "input_text", text: developerText }],
					},
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Apply the edit." }],
					},
				],
				tools: [],
			}),
		]);

		expect(wire.instructionMessages).toEqual([
			{ role: "developer", blocks: [topInstructions] },
			{ role: "system", blocks: [{ type: "input_text", text: systemText }] },
			{ role: "developer", blocks: [{ type: "input_text", text: developerText }] },
		]);
		expect(wire.systemBlocks).toEqual([
			topInstructions,
			{ type: "input_text", text: systemText },
			{ type: "input_text", text: developerText },
		]);
		expect(wire.systemChars).toBe(`${topInstructions}\n${systemText}\n${developerText}`.length);
		expect(systemTextOf(wire)).toBe(
			`[developer]\n${topInstructions}\n[system]\n${systemText}\n[developer]\n${developerText}`,
		);
		expect(wire.instructionMessages?.map((message) => message.role)).toEqual([
			"developer",
			"system",
			"developer",
		]);
	});

	it("reads flat Responses function schemas without a Chat wrapper", () => {
		const parameters = {
			type: "object",
			properties: {
				startSec: { type: "number" },
				endSec: { type: "number" },
			},
			required: ["startSec", "endSec"],
		};
		const wire = wireFromRequests([
			request(0, {
				input: [{ type: "message", role: "user", content: "Add a zoom." }],
				tools: [
					{
						type: "function",
						name: "addZoom",
						description: "Add a zoom segment.",
						parameters,
					},
				],
			}),
		]);

		expect(wire.toolsSent).toEqual([
			{
				name: "addZoom",
				description: "Add a zoom segment.",
				parameters,
			},
		]);
		expect(wire.toolNames).toEqual(["addZoom"]);
	});

	it("pairs arguments and results by call_id, ignoring item_id", () => {
		const wire = wireFromRequests([
			request(0, {
				input: [{ type: "message", role: "user", content: "Make both edits." }],
				tools: [],
			}),
			request(1, {
				input: [
					{
						type: "function_call",
						id: "fc_item_a",
						item_id: "response_item_a",
						call_id: "call_a",
						name: "addZoom",
						arguments: '{"startSec":1,"endSec":2}',
					},
					{
						type: "function_call",
						id: "fc_item_b",
						item_id: "response_item_b",
						call_id: "call_b",
						name: "addZoom",
						arguments: '{"startSec":9,"endSec":10}',
					},
				],
			}),
			request(2, {
				input: [
					// A real history repeats the function-call items. They must not
					// create a second call in the transcript.
					{
						type: "function_call",
						id: "fc_item_a",
						call_id: "call_a",
						name: "addZoom",
						arguments: '{"startSec":1,"endSec":2}',
					},
					{
						type: "function_call",
						id: "fc_item_b",
						call_id: "call_b",
						name: "addZoom",
						arguments: '{"startSec":9,"endSec":10}',
					},
					{
						type: "function_call_output",
						id: "output_item_for_b",
						item_id: "fc_item_a",
						call_id: "call_b",
						output: '{"zoomId":"zoom_b","startSec":9,"endSec":10}',
					},
					{
						type: "function_call_output",
						id: "output_item_for_a",
						item_id: "fc_item_b",
						call_id: "call_a",
						output: '{"zoomId":"zoom_a","startSec":1,"endSec":2}',
					},
				],
			}),
		]);

		expect(wire.calls).toHaveLength(2);
		expect(wire.calls.map((call) => call.id)).toEqual(["call_a", "call_b"]);
		expect(wire.calls[0]).toMatchObject({
			name: "addZoom",
			argsJson: '{"startSec":1,"endSec":2}',
			args: { startSec: 1, endSec: 2 },
			resultJson: '{"zoomId":"zoom_a","startSec":1,"endSec":2}',
			resultOk: true,
			mutating: true,
		});
		expect(wire.calls[1]).toMatchObject({
			args: { startSec: 9, endSec: 10 },
			resultJson: '{"zoomId":"zoom_b","startSec":9,"endSec":10}',
			resultOk: true,
		});
	});

	it("keeps malformed arguments and marks missing or failed results", () => {
		const wire = wireFromRequests([
			request(0, { input: [{ type: "message", role: "user", content: "Inspect the document." }] }),
			request(1, {
				input: [
					{
						type: "function_call",
						id: "fc_bad_args",
						call_id: "call_bad_args",
						name: "addZoom",
						arguments: "{not-json",
					},
					{
						type: "function_call",
						id: "fc_missing",
						call_id: "call_missing",
						name: "getCurrentDocument",
						arguments: "{}",
					},
					{
						type: "function_call",
						id: "fc_failed",
						call_id: "call_failed",
						name: "getCurrentDocument",
						arguments: "{}",
					},
				],
			}),
			request(2, {
				input: [
					{
						type: "function_call_output",
						id: "out_failed",
						item_id: "fc_bad_args",
						call_id: "call_failed",
						output: '{"error":"synthetic tool failure"}',
					},
				],
			}),
		]);

		expect(wire.calls[0]).toMatchObject({
			argsJson: "{not-json",
			args: undefined,
			resultJson: undefined,
			resultOk: false,
		});
		expect(wire.calls[1]).toMatchObject({
			args: {},
			resultJson: undefined,
			resultOk: false,
			mutating: false,
		});
		expect(wire.calls[2]).toMatchObject({
			resultJson: '{"error":"synthetic tool failure"}',
			resultOk: false,
		});
	});
});

describe("Responses request fingerprints", () => {
	const body = {
		model: "gpt-5-test",
		instructions: "Keep edits bounded.",
		reasoning: { effort: "medium" },
		input: [
			{ type: "message", role: "developer", content: "Use addZoom." },
			{ type: "message", role: "user", content: "Zoom the clip." },
			{
				type: "function_call",
				id: "fc_00000000-0000-4000-8000-000000000001",
				call_id: "call_00000000-0000-4000-8000-000000000001",
				name: "addZoom",
				arguments: '{"startSec":1,"endSec":2}',
			},
		],
		tools: [
			{
				type: "function",
				name: "addZoom",
				description: "Add a zoom.",
				parameters: { type: "object", properties: { startSec: { type: "number" } } },
			},
		],
	};

	it("binds schema, role, and full effective request changes", () => {
		const inbound = { ...body, store: true, max_output_tokens: 1 };
		const effective = applyRequestPolicy(inbound, responsesTransport);
		const effectiveInput = effective.input as Array<Record<string, unknown>>;
		const effectiveTools = effective.tools as Array<Record<string, unknown>>;

		expect(effective).toEqual({ ...inbound, store: false, max_output_tokens: 2048 });
		expect(inbound.store).toBe(true);
		expect(hashResponsesRequest(effective)).not.toBe(hashResponsesRequest(inbound));
		expect(hashResponsesRequest(effective)).not.toBe(
			hashResponsesRequest({
				...effective,
				input: effectiveInput.map((item) =>
					item.role === "developer" ? { ...item, role: "system" } : item,
				),
			}),
		);
		expect(hashResponsesRequest(effective)).not.toBe(
			hashResponsesRequest({
				...effective,
				tools: effectiveTools.map((tool) => ({
					...tool,
					parameters: {
						...(tool.parameters as Record<string, unknown>),
						additionalProperties: false,
					},
				})),
			}),
		);
		expect(hashResponsesRequest(effective)).not.toBe(
			hashResponsesRequest({ ...effective, max_output_tokens: 1025 }),
		);
	});

	it("keeps the historical Chat request hash compatible", () => {
		const legacy = {
			messages: [
				{ role: "system", content: "legacy system" },
				{ role: "user", content: "hello" },
			],
			tools: [{ function: { name: "addZoom", description: "legacy description" } }],
		};
		const expected = "b9b440f97c5d361e";

		expect(hashRequest(legacy)).toBe(expected);
		expect(
			hashRequest({ ...legacy, model: "gpt-5-test", stream: true, max_output_tokens: 2048 }),
		).toBe(expected);
		expect(hashResponsesRequest({ ...legacy, model: "gpt-5-test" })).not.toBe(expected);
	});
});
