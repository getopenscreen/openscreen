import { HtmlClassNameProvider, PageMetadata, ThemeClassNames } from "@docusaurus/theme-common";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import BlogLayout from "@theme/BlogLayout";
import type { Props } from "@theme/BlogListPage";
import BlogListPageStructuredData from "@theme/BlogListPage/StructuredData";
import BlogListPaginator from "@theme/BlogListPaginator";
import BlogPostItems from "@theme/BlogPostItems";
import Heading from "@theme/Heading";
import SearchMetadata from "@theme/SearchMetadata";
import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * Ejected from @docusaurus/theme-classic 3.10.1 for one change: the stock list
 * page renders no h1, so /blog/ had none. The heading reuses the tag pages'
 * header markup. Everything else is the upstream component.
 */
export default function BlogListPage(props: Props): ReactNode {
	const { metadata, items, sidebar } = props;
	const {
		siteConfig: { title: siteTitle },
	} = useDocusaurusContext();
	const { blogDescription, blogTitle, permalink } = metadata;
	const title = permalink === "/" ? siteTitle : blogTitle;

	return (
		<HtmlClassNameProvider
			className={clsx(ThemeClassNames.wrapper.blogPages, ThemeClassNames.page.blogListPage)}
		>
			<PageMetadata title={title} description={blogDescription} />
			<SearchMetadata tag="blog_posts_list" />
			<BlogListPageStructuredData {...props} />
			<BlogLayout sidebar={sidebar}>
				<header className="margin-bottom--xl">
					<Heading as="h1">{blogTitle}</Heading>
				</header>
				<BlogPostItems items={items} />
				<BlogListPaginator metadata={metadata} />
			</BlogLayout>
		</HtmlClassNameProvider>
	);
}
