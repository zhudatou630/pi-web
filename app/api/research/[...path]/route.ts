import { researchService } from "@/lib/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(req: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const route = path.join("/");
  // The browser can never use the private model gateway or arbitrary upstream paths.
  if (!/^(health|runs|runs\/[a-f0-9-]{36}(\/(action|artifact))?|notifications|notifications\/[a-f0-9]{24}\/ack)$/.test(route)) {
    return Response.json({ error: "Route not found" }, { status: 404 });
  }
  try {
    const service = await researchService();
    const target = new URL(`${service.url}/v1/${route}`);
    if (route.endsWith("/artifact")) {
      target.searchParams.set("path", new URL(req.url).searchParams.get("path") || "");
    }
    const response = await fetch(target, {
      method: req.method,
      headers: { "Authorization": `Bearer ${service.token}`, "Content-Type": "application/json" },
      ...(req.method === "POST" ? { body: await req.text() } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    for (const name of ["Content-Type", "Content-Disposition", "Content-Length"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return Response.json({ error: "Research worker is unavailable. Run scripts/start.ps1 in the research workspace." }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST };
