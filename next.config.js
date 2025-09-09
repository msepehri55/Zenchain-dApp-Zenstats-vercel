/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Dev-only tweaks for Windows watchers/caching
  webpack: (config, { dev }) => {
    if (dev) {
      // Disable persistent FS cache in dev (Windows rename lock issues)
      config.cache = { type: 'memory' };
    }
    return config;
  },
  webpackDevMiddleware: (config) => {
    // Ignore Windows system files that cause EINVAL lstat warnings
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        'C:/pagefile.sys',
        'C:/swapfile.sys',
        'C:/DumpStack.log.tmp'
      ]
    };
    return config;
  }
};
module.exports = nextConfig;