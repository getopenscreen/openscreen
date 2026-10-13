import { Tooltip } from "@/components/ui/tooltip";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import type { AgentTurnUsage } from "@/native/contracts";

/** Provider-reported usage for this turn, separate from the context-window budget. */
export function ChatUsageSummary({ usage }: { usage?: AgentTurnUsage }) {
	const { locale } = useI18n();
	const t = useScopedT("editor");
	if (!usage) return null;
	const format = (value: number) => new Intl.NumberFormat(locale).format(value);
	const summary =
		usage.status === "unavailable"
			? t("chat.usageUnavailable")
			: usage.status === "partial"
				? t("chat.usagePartial", { tokens: format(usage.totalTokens) })
				: t("chat.usageComplete", {
						tokens: format(usage.totalTokens),
						calls: format(usage.modelCallCount),
					});
	const details = [
		summary,
		t("chat.usageCoverage", {
			counted: format(usage.countedCallCount),
			calls: format(usage.modelCallCount),
		}),
	];
	if (usage.status !== "unavailable") {
		details.push(
			t("chat.usageInput", { tokens: format(usage.inputTokens) }),
			t("chat.usageOutput", { tokens: format(usage.outputTokens) }),
		);
	}
	for (const [key, value] of [
		["usageCachedInput", usage.cachedInputTokens],
		["usageCacheCreation", usage.cacheCreationInputTokens],
		["usageReasoning", usage.reasoningOutputTokens],
	] as const) {
		if (value !== undefined) details.push(t(`chat.${key}`, { tokens: format(value) }));
	}
	const description = details.join(" · ");
	return (
		<Tooltip content={description}>
			<span
				tabIndex={0}
				aria-label={description}
				style={{
					font: "500 11px/1.5 var(--font-body)",
					color: "var(--muted)",
					fontVariantNumeric: "tabular-nums",
				}}
			>
				{summary}
			</span>
		</Tooltip>
	);
}
