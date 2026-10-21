import { Tooltip } from "@/components/ui/tooltip";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import type { AgentTurnUsage } from "@/native/contracts";

/** Provider-reported usage for this turn, separate from the context-window budget. */
export function ChatUsageSummary({
	usage,
	durationMs,
	running = false,
}: {
	usage?: AgentTurnUsage;
	durationMs?: number;
	running?: boolean;
}) {
	const { locale } = useI18n();
	const t = useScopedT("editor");
	if (!usage || (running && usage.status === "unavailable")) return null;
	const format = (value: number) => new Intl.NumberFormat(locale).format(value);
	const tokens =
		usage.totalTokens >= 1000
			? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(usage.totalTokens / 1000)}k`
			: format(usage.totalTokens);
	const summaryTokens = running ? `≥${tokens}` : tokens;
	const summary =
		usage.status === "unavailable" ? "" : t("chat.usageComplete", { tokens: summaryTokens });
	const usageDescription =
		usage.status === "unavailable"
			? t("chat.usageUnavailable")
			: !running && usage.status === "partial"
				? t("chat.usagePartial", { tokens: summaryTokens })
				: t("chat.usageComplete", { tokens: summaryTokens });
	const duration =
		!running && durationMs !== undefined
			? new Intl.NumberFormat(locale, {
					style: "unit",
					unit: "second",
					unitDisplay: "narrow",
					maximumFractionDigits: 0,
				}).format(Math.round(durationMs / 1000))
			: "";
	const line = [summary, duration].filter(Boolean).join(" · ");
	if (!line) return null;
	const details = [
		[usageDescription, duration].filter(Boolean).join(" · "),
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
				{line}
			</span>
		</Tooltip>
	);
}
