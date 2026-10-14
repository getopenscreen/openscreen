// www.getopenscreen.com only: every request goes to the same path on the apex, as
// GitHub Pages did. Deployed by hand (`npx wrangler deploy` in this folder); it has no
// reason to change with the site.
export default {
	fetch(request) {
		const url = new URL(request.url);
		url.protocol = "https:";
		url.hostname = "getopenscreen.com";
		return Response.redirect(url.toString(), 301);
	},
};
