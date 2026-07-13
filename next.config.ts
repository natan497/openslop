import type { NextConfig } from "next";
import { BLOB_BASE_URL } from "./lib/blob";

// Must track the same blob URLs lib/blob.ts + lib/api/asset-bundle.ts read —
// an unlisted hostname 404s in an optimized <Image> (e.g. ProjectsList).
const blobPatterns = Array.from(
	new Map(
		[process.env.NEXT_PUBLIC_BLOB_URL, BLOB_BASE_URL]
			.filter((url): url is string => Boolean(url))
			.map((url) => {
				const parsed = URL.parse(url);
				if (!parsed) {
					throw new Error(
						`Invalid blob URL (check NEXT_PUBLIC_BLOB_URL): ${url}`,
					);
				}
				return [
					parsed.hostname,
					{
						protocol: parsed.protocol.slice(0, -1) as "http" | "https",
						hostname: parsed.hostname,
					},
				] as const;
			}),
	).values(),
);

const SECURITY_HEADERS = [
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "X-Frame-Options", value: "SAMEORIGIN" },
	{
		key: "Strict-Transport-Security",
		value: "max-age=63072000; includeSubDomains; preload",
	},
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
	images: {
		remotePatterns: [...blobPatterns, { hostname: "picsum.photos" }],
	},
	experimental: {
		optimizePackageImports: [
			"lucide-react",
			"radix-ui",
			"@dnd-kit/core",
			"@dnd-kit/sortable",
			"@dnd-kit/utilities",
			"lodash",
		],
	},
	async headers() {
		return [{ source: "/:path*", headers: SECURITY_HEADERS }];
	},
};

const loadConfig = async (): Promise<NextConfig> => {
	if (process.env.ANALYZE !== "true") return nextConfig;
	const { default: withBundleAnalyzer } = await import("@next/bundle-analyzer");
	return withBundleAnalyzer({ enabled: true })(nextConfig);
};

export default loadConfig;
