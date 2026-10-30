import { HOME_HTML } from './_home/html'

// The homepage is the Living Site: a static page whose assets live in public/home/.
// It is served from a route handler so it works the same on Netlify and in `next start`.
// The previous landing page is kept in app/_legacy-home/page.tsx (not routable) for an instant rollback:
// delete this file and move that page back to app/page.tsx.
export const dynamic = 'force-static'

export function GET() {
  return new Response(HOME_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  })
}
