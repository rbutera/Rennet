/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['nimbus.piranha-wyvern.ts.net'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
