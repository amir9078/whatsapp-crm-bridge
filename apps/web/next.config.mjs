/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@wcb/shared'],
  eslint: { ignoreDuringBuilds: true }, // linted at the monorepo root
};

export default nextConfig;
