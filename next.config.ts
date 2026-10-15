import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OpenTelemetry and Langfuse use dynamic requires that webpack should not bundle.
  serverExternalPackages: [
    "@langfuse/otel",
    "@langfuse/tracing",
    "@langfuse/core",
    "@opentelemetry/api",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/resources",
  ],
};

export default nextConfig;
