import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { registerMetaTools } from "./meta.js";
import { registerGoogleTools } from "./google.js";
import { timingSafeEqual } from "./util.js";

export interface Env {
  /** Long random string; the connector URL is https://<worker>/mcp/<MCP_SECRET> */
  MCP_SECRET: string;
  META_ACCESS_TOKEN?: string;
  META_API_VERSION?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
}

function buildServer(env: Env) {
  const server = new McpServer(
    { name: "reklam-connector", version: "1.0.0" },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        "Meta Ads (Facebook/Instagram), Google Analytics 4 ve Google Search Console'a erişim sağlar. " +
        "Meta bütçeleri hesabın para biriminin en küçük biriminde (kuruş/cent) verilir: 250 TL = 25000. " +
        "Yeni kampanya/reklam seti/reklamlar varsayılan olarak PAUSED oluşturulur; yayına almadan önce kullanıcıdan onay alın. " +
        "Bütçe artırma, durum değişikliği ve silme gibi harcamayı etkileyen işlemlerden önce yapılacak değişikliği kullanıcıya özetleyin.",
    },
  );
  registerMetaTools(server, env);
  registerGoogleTools(server, env);
  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        meta: Boolean(env.META_ACCESS_TOKEN),
        google: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON),
      });
    }

    const match = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!env.MCP_SECRET || env.MCP_SECRET.length < 24) {
      return new Response("MCP_SECRET secret'ı tanımlı değil veya çok kısa (en az 24 karakter).", { status: 500 });
    }
    if (!match || !timingSafeEqual(match[1], env.MCP_SECRET)) {
      return new Response("Not found", { status: 404 });
    }

    // Stateless: a fresh server + transport per request, JSON responses instead of SSE.
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
