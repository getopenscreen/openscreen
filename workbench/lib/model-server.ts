// ponytail: the single seam of the whole workbench — a local OpenAI-compatible
// endpoint the app talks to as `provider: "openai-compatible"`. Three modes
// share one wire format:
//   script  — turns written by hand in a scenario file (offline, deterministic)
//   replay  — turns read back from a cassette (offline, deterministic)
//   record  — proxies to the real provider and writes the cassette (network)
//
// INVARIANT, learned the hard way: every response MUST carry a unique `id`.
// LangGraph's `add_messages` reducer merges by message id, so reusing one id
// makes each new assistant message REPLACE the previous one — the agent then
// silently loses every earlier tool result inside the same turn and the
// workbench measures amnesia that production does not have.

import { createServer, type Server } from "node:http";
import type { WireApi } from "./transport";
import { instructionContentTextOf } from "./wire";

export interface ScriptedToolCall {
	name: string;
	args: unknown;
}
export type ScriptedTurn =
	| { kind: "tools"; calls: ScriptedToolCall[]; opaqueReasoning?: string }
	| { kind: "text"; text: string }
	| { kind: "thinking"; reasoning: string; text: string };

export interface CapturedRequest {
	round: number;
	systemChars: number;
	toolNames: string[];
	messages: Array<{ role: string; content: string; toolCalls: string[] }>;
	raw: unknown;
}

export interface ModelServerHandle {
	url: string;
	requests: CapturedRequest[];
	/** Le modèle que le flux s'est attribué, quand un enregistreur l'a lu. Null
	 *  tant qu'aucune réponse n'est passée, et absent des serveurs scriptés. */
	resolvedModel?: string | null;
	/** Safe recorder lifecycle metadata; never contains request/response content. */
	attempts?: Array<{ attempt: number; phase: string; status: string; detail?: string }>;
	close: () => void;
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

function chunk(responseId: string, delta: unknown, finish: string | null) {
	return {
		id: responseId,
		object: "chat.completion.chunk",
		created: 0,
		model: "workbench",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

function capture(round: number, body: Record<string, unknown>): CapturedRequest {
	if (Array.isArray(body.input)) {
		const input = body.input as Array<Record<string, unknown>>;
		return {
			round,
			systemChars:
				(typeof body.instructions === "string" ? body.instructions.length : 0) +
				input
					.filter((item) => item.role === "system" || item.role === "developer")
					.reduce((total, item) => total + JSON.stringify(item.content ?? "").length, 0),
			toolNames: ((body.tools ?? []) as Array<{ name?: string }>).map((tool) => tool.name ?? "?"),
			messages: [],
			raw: body,
		};
	}
	const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
	return {
		round,
		systemChars: instructionContentTextOf(messages).length,
		toolNames: ((body.tools ?? []) as Array<{ function?: { name?: string } }>).map(
			(t) => t.function?.name ?? "?",
		),
		messages: messages.map((m) => ({
			role: String(m.role),
			content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
			toolCalls: ((m.tool_calls ?? []) as Array<{ function?: { name?: string } }>).map(
				(t) => t.function?.name ?? "?",
			),
		})),
		raw: body,
	};
}

function responsesEvent(payload: unknown): string {
	return `event: ${(payload as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function baseResponse(
	id: string,
	model: string,
	output: unknown[],
	usage: Record<string, unknown>,
) {
	return {
		id,
		object: "response",
		created_at: 0,
		status: "completed",
		error: null,
		incomplete_details: null,
		instructions: null,
		max_output_tokens: 2048,
		model,
		output,
		parallel_tool_calls: true,
		previous_response_id: null,
		reasoning: { effort: "medium", summary: null },
		store: false,
		temperature: null,
		text: { format: { type: "text" } },
		tool_choice: "auto",
		tools: [],
		top_p: null,
		truncation: "disabled",
		usage,
	};
}

function responsesBody(turn: ScriptedTurn, round: number, model: string): string {
	const responseId = `resp_wb_${round}`;
	const usage = {
		input_tokens: 100 + round,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 10 + round,
		output_tokens_details: { reasoning_tokens: turn.kind === "tools" ? 3 : 0 },
		total_tokens: 110 + round * 2,
	};
	const events: unknown[] = [];
	events.push({
		type: "response.created",
		sequence_number: 0,
		response: { ...baseResponse(responseId, model, [], usage), status: "in_progress", usage: null },
	});
	const output: unknown[] = [];
	let sequence = 1;
	if (turn.kind === "tools") {
		if (turn.opaqueReasoning) {
			const reasoning = {
				id: `rs_wb_${round}`,
				type: "reasoning",
				status: "completed",
				summary: [],
				encrypted_content: turn.opaqueReasoning,
			};
			output.push(reasoning);
			events.push({
				type: "response.output_item.added",
				sequence_number: sequence++,
				output_index: 0,
				item: reasoning,
			});
			events.push({
				type: "response.output_item.done",
				sequence_number: sequence++,
				output_index: 0,
				item: reasoning,
			});
		}
		turn.calls.forEach((call, index) => {
			const outputIndex = output.length;
			const item = {
				id: `fc_wb_${round}_${index}`,
				type: "function_call",
				status: "completed",
				call_id: `call_wb_${round}_${index}`,
				name: call.name,
				arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args),
			};
			output.push(item);
			events.push({
				type: "response.output_item.added",
				sequence_number: sequence++,
				output_index: outputIndex,
				item,
			});
			events.push({
				type: "response.output_item.done",
				sequence_number: sequence++,
				output_index: outputIndex,
				item,
			});
		});
	} else {
		const text = turn.text;
		const item = {
			id: `msg_wb_${round}`,
			type: "message",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
		};
		output.push(item);
		events.push({
			type: "response.output_item.added",
			sequence_number: sequence++,
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		});
		events.push({
			type: "response.content_part.added",
			sequence_number: sequence++,
			output_index: 0,
			content_index: 0,
			item_id: item.id,
			part: { type: "output_text", text: "", annotations: [], logprobs: [] },
		});
		for (const piece of text.match(/.{1,24}/g) ?? [text]) {
			events.push({
				type: "response.output_text.delta",
				sequence_number: sequence++,
				output_index: 0,
				content_index: 0,
				item_id: item.id,
				delta: piece,
				logprobs: [],
			});
		}
		events.push({
			type: "response.output_text.done",
			sequence_number: sequence++,
			output_index: 0,
			content_index: 0,
			item_id: item.id,
			text,
			logprobs: [],
		});
		events.push({
			type: "response.content_part.done",
			sequence_number: sequence++,
			output_index: 0,
			content_index: 0,
			item_id: item.id,
			part: item.content[0],
		});
		events.push({
			type: "response.output_item.done",
			sequence_number: sequence++,
			output_index: 0,
			item,
		});
	}
	events.push({
		type: "response.completed",
		sequence_number: sequence,
		response: baseResponse(responseId, model, output, usage),
	});
	return events.map(responsesEvent).join("");
}

export async function startScriptedModel(
	script: ScriptedTurn[],
	options: { wireApi?: WireApi; model?: string } = {},
): Promise<ModelServerHandle> {
	const requests: CapturedRequest[] = [];
	let round = 0;

	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			requests.push(capture(round, JSON.parse(body)));
			const turn = script[Math.min(round, script.length - 1)];
			if (!turn) {
				res.writeHead(409, { "content-type": "application/json" });
				res.end('{"error":"script exhausted"}');
				return;
			}
			if (options.wireApi === "responses") {
				const expected = req.url === "/responses" || req.url === "/v1/responses";
				if (!expected) {
					res.writeHead(404, { "content-type": "application/json" });
					res.end('{"error":"responses path required"}');
					return;
				}
				const response = responsesBody(turn, round, options.model ?? "workbench-responses");
				round += 1;
				res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
				res.end(response);
				return;
			}
			const responseId = `wb-${round}`;
			round += 1;

			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(sse(chunk(responseId, { role: "assistant", content: "" }, null)));

			if (turn.kind === "tools") {
				turn.calls.forEach((call, i) => {
					res.write(
						sse(
							chunk(
								responseId,
								{
									tool_calls: [
										{
											index: i,
											id: `call_${responseId}_${i}`,
											type: "function",
											function: {
												name: call.name,
												// ponytail: string, exactly like the wire — a scenario can
												// therefore inject malformed JSON on purpose.
												arguments:
													typeof call.args === "string" ? call.args : JSON.stringify(call.args),
											},
										},
									],
								},
								null,
							),
						),
					);
				});
				res.write(sse(chunk(responseId, {}, "tool_calls")));
			} else {
				const text = turn.kind === "text" ? turn.text : turn.text;
				for (const piece of text.match(/.{1,24}/g) ?? [text]) {
					res.write(sse(chunk(responseId, { content: piece }, null)));
				}
				res.write(sse(chunk(responseId, {}, "stop")));
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("model server has no address");
	return {
		url: `http://127.0.0.1:${addr.port}/v1`,
		requests,
		close: () => server.close(),
	};
}
