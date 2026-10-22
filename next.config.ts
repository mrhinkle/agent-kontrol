import type { NextConfig } from "next";

const publicDocs = ["./docs/MCP.md", "./docs/API.md", "./docs/AGENTS.md"];

// Vercel copies these into the route functions. The Docker image copies the
// same files itself: `next start` does not unpack this list.
const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/llms.txt": publicDocs,
    "/docs/[name]": publicDocs,
  },
};

export default nextConfig;
