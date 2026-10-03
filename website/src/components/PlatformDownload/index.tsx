import Link from "@docusaurus/Link";
import { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { directDownloadUrl } from "../../lib/download-target";
import { type AssetKind, findAsset, type LatestRelease } from "../../lib/release";
import PlatformIcon from "./PlatformIcon";
import styles from "./styles.module.css";
import useDownloadTarget from "./useDownloadTarget";

export default function PlatformDownload({ className }: { className: string }) {
	const { siteConfig } = useDocusaurusContext();
	const release = (siteConfig.customFields?.latestRelease ?? null) as LatestRelease;
	const target = useDownloadTarget();
	const [open, setOpen] = useState(false);
	const group = useRef<HTMLDivElement>(null);
	const chooser = useRef<HTMLButtonElement>(null);
	const optionsId = useId();
	const url = directDownloadUrl(target, release);
	const macChoice = target.os === "macos" && !target.kind;
	const options: { kind: AssetKind; label: string }[] =
		target.os === "macos"
			? [
					{ kind: "macArm", label: "Apple Silicon (M1, M2, M3…)" },
					{ kind: "macIntel", label: "Intel" },
				]
			: target.os === "linux" && target.kind
				? [
						{ kind: "deb", label: "Debian / Ubuntu · .deb" },
						{ kind: "rpm", label: "Fedora / RHEL · .rpm" },
						{ kind: "pacman", label: "Arch / Manjaro · .pacman" },
						{ kind: "appImage", label: "AppImage" },
					]
				: [];
	const available = options.flatMap((option) => {
		const asset = findAsset(release, option.kind);
		return asset ? [{ ...option, url: asset.url }] : [];
	});
	const label =
		target.os === "macos"
			? translate({ id: "download.cta.mac", message: "Download for Mac" })
			: target.os === "windows"
				? translate({ id: "download.cta.windows", message: "Download for Windows" })
				: target.os === "linux"
					? translate({ id: "download.cta.linux", message: "Download for Linux" })
					: translate({ id: "home.hero.download", message: "Download" });
	const chooserLabel = macChoice
		? translate({ id: "download.cta.chooseMac", message: "Choose your Mac" })
		: translate({ id: "download.cta.otherVersions", message: "Other versions" });
	const content = (
		<>
			<PlatformIcon os={target.os} />
			<span>{label}</span>
		</>
	);
	const needsChoice = macChoice && available.length > 0;
	const hasSplit = !needsChoice && available.length > 0;

	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (event.target instanceof Node && !group.current?.contains(event.target)) setOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
				chooser.current?.focus();
			}
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);

	return (
		<div
			ref={group}
			className={styles.group}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
			}}
		>
			{needsChoice ? (
				<button
					ref={chooser}
					type="button"
					className={clsx(className, styles.main)}
					data-platform-download={target.os}
					aria-expanded={open}
					aria-controls={optionsId}
					onClick={() => setOpen(!open)}
				>
					{content}
					<ChevronDown size={15} aria-hidden="true" />
				</button>
			) : url ? (
				<a
					className={clsx(className, styles.main, hasSplit && styles.split)}
					href={url}
					data-platform-download={target.os}
					data-download-kind={target.kind ?? "store"}
				>
					{content}
				</a>
			) : (
				<Link
					className={clsx(className, styles.main)}
					to="/download"
					data-platform-download={target.os ?? "unknown"}
				>
					{content}
				</Link>
			)}
			{hasSplit ? (
				<button
					ref={chooser}
					type="button"
					className={clsx(className, styles.chooser)}
					aria-label={chooserLabel}
					aria-expanded={open}
					aria-controls={optionsId}
					onClick={() => setOpen(!open)}
				>
					<ChevronDown size={15} aria-hidden="true" />
				</button>
			) : null}
			{open ? (
				<div className={styles.options} id={optionsId}>
					<p>{chooserLabel}</p>
					<ul>
						{available.map((option) => (
							<li key={option.kind}>
								<a
									href={option.url}
									onClick={() => setOpen(false)}
									data-download-kind={option.kind}
								>
									{option.label}
								</a>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}
