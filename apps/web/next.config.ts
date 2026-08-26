import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The entire future Docker story, for one line now (hosting-and-growth-path).
  output: 'standalone',
  // Workspace packages ship TypeScript source, not a build artifact.
  transpilePackages: ['@degencage/rules'],
  typedRoutes: true,
};

export default nextConfig;
