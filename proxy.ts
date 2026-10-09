import { NextResponse, type NextRequest } from "next/server";
import { getAuthRetryAfterMs, recordAuthFailure, retryAfterSeconds } from "@/lib/web-auth-throttle";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidWebSessionToken,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
} from "@/lib/web-auth";

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      const host = request.headers.get("host") ?? "";
      return new NextResponse(
        `Untrusted host "${host}". If you reach Pi Web through this name, add its hostname to PI_WEB_ALLOWED_HOSTS and restart.`,
        { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    if (request.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  let authenticated = isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, password);
  const authorization = isApiRequest ? request.headers.get("authorization") : null;
  if (!authenticated && authorization && /^Basic\s/i.test(authorization)) {
    // Check before the web-auth exemption: GET must not be a password oracle.
    // Even correct Basic credentials are blocked; otherwise the answer leaks.
    const retryAfterMs = getAuthRetryAfterMs();
    if (retryAfterMs > 0) {
      return new NextResponse("Too many failed attempts", {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds(retryAfterMs)) },
      });
    }
    authenticated = isValidBasicAuthorization(authorization, password);
    if (!authenticated) recordAuthFailure();
    // Basic authenticates every request: success must not reset an interleaved
    // guesser's failures back to the base delay.
  }
  if (request.nextUrl.pathname === "/login") {
    return authenticated
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) {
        loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      }
      return NextResponse.redirect(loginUrl);
    }
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
