import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  // The SDK and the RFQ maker relay (mounted at /api/rfq) are workspace packages shipped as TypeScript source.
  transpilePackages: ['@novation/mm-bot', '@novation/sdk'],
};

export default nextConfig;
