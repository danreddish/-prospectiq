/** @type {import('next').NextConfig} */

// Who is allowed to frame /embed. Set here rather than in netlify.toml because
// @netlify/plugin-nextjs serves app-router pages through its own handler and
// does not apply netlify.toml header rules to them.
// *.netlify.app is required while the parent site is tested on its Netlify
// preview URL, before the custom domain is attached.
const EMBED_FRAME_ANCESTORS =
  "frame-ancestors 'self' https://aiwealthpartners.co.uk https://www.aiwealthpartners.co.uk https://*.netlify.app;"

const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    return [
      {
        source: '/embed',
        headers: [
          { key: 'Content-Security-Policy', value: EMBED_FRAME_ANCESTORS },
        ],
      },
      {
        source: '/embed/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: EMBED_FRAME_ANCESTORS },
        ],
      },
    ]
  },
}

module.exports = nextConfig
