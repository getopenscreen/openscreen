import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./ChatMarkdown.module.css";

/** Render Markdown as React elements; HTML is skipped and unsafe URL schemes are rejected. */
export function ChatMarkdown({ text }: { text: string }) {
	return (
		<div className={styles.markdown}>
			<Markdown
				skipHtml
				remarkPlugins={[remarkGfm]}
				components={{
					img: ({ alt }) => <span>{alt}</span>,
					a: ({ href, children }) =>
						href && /^(https?:\/\/|mailto:)/i.test(href) ? (
							<a
								href={href}
								target="_blank"
								rel="noopener noreferrer"
								onClick={(event) => {
									if (window.electronAPI?.openExternalUrl) {
										event.preventDefault();
										void window.electronAPI.openExternalUrl(href);
									}
								}}
							>
								{children}
							</a>
						) : (
							<span>{children}</span>
						),
				}}
			>
				{text}
			</Markdown>
		</div>
	);
}
