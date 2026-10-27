import { useScopedT } from "@/contexts/I18nContext";
import type { ChatExecutionStep } from "@/lib/ai-edition/chatExecution";
import { ChatMarkdown } from "./ChatMarkdown";

export function ChatExecutionSteps({ steps }: { steps?: ChatExecutionStep[] }) {
	const t = useScopedT("editor");
	if (!steps?.length) return null;
	return (
		<section
			aria-label={t("chat.executionSteps")}
			style={{ margin: "6px 0", font: "12px/1.5 var(--font-body)", color: "var(--muted)" }}
		>
			{steps.map((step) => (
				<details key={step.id} style={{ marginBottom: 4 }}>
					<summary
						style={{
							cursor: "pointer",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
							color:
								step.kind === "tool" && step.status === "failed"
									? "var(--danger, var(--fg))"
									: undefined,
						}}
					>
						{step.kind === "reasoning" ? (
							t("chat.stepReasoning")
						) : (
							<>
								<span>
									{step.status === "succeeded"
										? "✓"
										: step.status === "failed"
											? "✗"
											: step.status === "stopped"
												? "■"
												: "…"}
								</span>{" "}
								<strong>{step.name}</strong>
								{step.arguments ? ` · ${step.arguments}` : ""}
								{" · "}
								{t(`chat.stepStatus.${step.status}`)}
								{step.durationMs !== undefined ? ` · ${(step.durationMs / 1000).toFixed(1)}s` : ""}
							</>
						)}
					</summary>
					{step.kind === "tool" && step.arguments ? (
						<pre style={{ overflowX: "auto", whiteSpace: "pre-wrap" }}>{step.arguments}</pre>
					) : null}
					{step.kind === "reasoning" ? (
						<ChatMarkdown text={step.text} />
					) : step.summary ? (
						<ChatMarkdown text={step.summary} />
					) : null}
				</details>
			))}
		</section>
	);
}
