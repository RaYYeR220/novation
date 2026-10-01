import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  // The SDK is a workspace package shipped as TypeScript source.
  transpilePackages: ['@novation/sdk'],
};

export default nextConfig;
