/** @type {import('next').NextConfig} */
const nextConfig = {
  // Output standalone for Docker
  output: 'standalone',

  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: process.env.S3_PUBLIC_HOSTNAME || 'localhost',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '9000',
        pathname: '/**',
      },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  // Security headers
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },

  // Redirects
  async redirects() {
    return [
      {
        source: '/dashboard',
        destination: '/dashboard/projects',
        permanent: true,
      },
    ];
  },

  // Rewrites for internal API proxying (if needed)
  async rewrites() {
    return [
      {
        source: '/internal/asr/:path*',
        destination: 'http://asr-worker:8001/:path*',
      },
      {
        source: '/internal/tts/:path*',
        destination: 'http://tts-worker:8002/:path*',
      },
      {
        source: '/internal/ai/:path*',
        destination: 'http://ai-worker:8003/:path*',
      },
      {
        source: '/internal/render/:path*',
        destination: 'http://render-worker:8004/:path*',
      },
    ];
  },

  // Webpack configuration
  webpack: (config, { isServer, dev }) => {
    // Optimize for production
    if (!dev && !isServer) {
      config.optimization.splitChunks = {
        chunks: 'all',
        cacheGroups: {
          default: false,
          vendors: false,
          commons: {
            name: 'commons',
            chunks: 'all',
            minChunks: 2,
          },
          lib: {
            test: /[\\/]node_modules[\\/]/,
            name(module) {
              const packagePath = module.context?.match(/[\\/]node_modules[\\/](.*?)(?:[\\/]|$)/);
              if (!packagePath) return null;
              const packageName = packagePath[1];
              return `npm.${packageName.replace('@', '')}`;
            },
            chunks: 'all',
          },
        },
      };
    }

    // Handle node: protocol imports
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      crypto: false,
    };

    return config;
  },

  // Environment variables validation
  env: {
    NEXT_PUBLIC_APP_URL: process.env.APP_URL,
    NEXT_PUBLIC_S3_BUCKET: process.env.S3_BUCKET,
  },

  // Powered by header
  poweredByHeader: false,

  // Compression
  compress: true,

  // React strict mode
  reactStrictMode: true,

  // SWC minify
  swcMinify: true,
};

module.exports = nextConfig;
