/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['nimbus.piranha-wyvern.ts.net', '127.0.0.1'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
