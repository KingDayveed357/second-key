// Witness web: judge page, shopper page, phone HOLD approval and the ops console.
// Role API keys stay server-side (lib/server); the browser only ever talks to /api/* on this host.
// Type-checking runs from the repo (`pnpm typecheck`, tsconfig in this folder) because the repo uses
// TypeScript 7, so Next's own build-time check is skipped rather than run against a different compiler.

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  // Witness was folded into Second Key: its judge page is the developer conformance suite now.
  async redirects() {
    return [
      { source: "/witness", destination: "/developers", permanent: false },
      { source: "/shop", destination: "/pay", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      // Second Key reviewer and guardian pages handle a credential: never cache them (ADR-0020 §5).
      { source: "/holds/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/guardian", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
