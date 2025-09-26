// middleware.js
import { NextResponse } from 'next/server';

export const config = {
  matcher: ['/admin', '/api/admin/:path*'],
};

export default function middleware(req) {
  const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || '';
  const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || '';

  const auth = req.headers.get('authorization');
  if (auth) {
    const [scheme, encoded] = auth.split(' ');
    if (scheme === 'Basic') {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const [user, pass] = decoded.split(':');
      if (user === BASIC_AUTH_USER && pass === BASIC_AUTH_PASS) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse('Auth required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Secure Area"' },
  });
}