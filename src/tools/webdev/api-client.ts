import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ApiClientSchema = z.object({
  endpoint: z.string().describe("API endpoint path (e.g. /users/:id or /api/products)"),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
    .describe("HTTP method"),
  request_schema: z
    .string()
    .optional()
    .describe("TypeScript type/interface string describing the request body"),
  response_schema: z
    .string()
    .optional()
    .describe("TypeScript type/interface string describing the response"),
  auth: z
    .enum(["bearer", "cookie", "apikey", "none"])
    .describe("Authentication strategy"),
  base_url_var: z
    .string()
    .optional()
    .describe("Environment variable name for the base URL (e.g. NEXT_PUBLIC_API_URL)"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function endpointToFunctionName(endpoint: string, method: string): string {
  const parts = endpoint
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":") || (seg.startsWith("{") && seg.endsWith("}"))) {
        const name = seg.replace(/[:{}]/g, "");
        return "By" + name.charAt(0).toUpperCase() + name.slice(1);
      }
      return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
    })
    .join("");

  const methodPrefix: Record<string, string> = {
    GET: "fetch",
    POST: "create",
    PUT: "update",
    PATCH: "patch",
    DELETE: "delete",
  };
  return (methodPrefix[method] ?? "call") + parts;
}

function buildAuthHeaders(auth: string): string {
  switch (auth) {
    case "bearer":
      return `    "Authorization": \`Bearer \${token}\`,`;
    case "apikey":
      return `    "X-Api-Key": apiKey,`;
    default:
      return "";
  }
}

function buildFunctionSignature(
  fnName: string,
  method: string,
  endpoint: string,
  requestSchema: string | undefined,
  auth: string,
): string {
  const params: string[] = [];

  // Path params
  const pathParams = [...endpoint.matchAll(/:([a-zA-Z_]+)|{([a-zA-Z_]+)}/g)];
  for (const m of pathParams) {
    params.push(`${m[1] ?? m[2]}: string`);
  }

  // Body param for write methods
  if (["POST", "PUT", "PATCH"].includes(method)) {
    const bodyType = requestSchema ? "RequestBody" : "Record<string, unknown>";
    params.push(`body: ${bodyType}`);
  }

  // Auth params
  if (auth === "bearer") params.push("token: string");
  if (auth === "apikey") params.push("apiKey: string");

  return `async function ${fnName}(${params.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handleApiClient({ endpoint: "/users/:id", method: "GET", response_schema: "{ id: string; name: string; email: string }", auth: "bearer", base_url_var: "NEXT_PUBLIC_API_URL" })

export function handleApiClient(args: z.infer<typeof ApiClientSchema>): string {
  const { endpoint, method, request_schema, response_schema, auth, base_url_var } = args;

  const fnName = endpointToFunctionName(endpoint, method);
  const baseUrlVar = base_url_var ?? "API_BASE_URL";
  const responseType = response_schema ? "ResponseData" : "unknown";
  const authHeaders = buildAuthHeaders(auth);
  const signature = buildFunctionSignature(fnName, method, endpoint, request_schema, auth);

  // Build path interpolation
  const pathWithVars = endpoint.replace(/:([a-zA-Z_]+)/g, "${$1}").replace(/\{([a-zA-Z_]+)\}/g, "${$1}");
  const hasBody = ["POST", "PUT", "PATCH"].includes(method);

  const typeBlock: string[] = [];
  if (request_schema && hasBody) {
    typeBlock.push(`type RequestBody = ${request_schema};`);
  }
  if (response_schema) {
    typeBlock.push(`type ResponseData = ${response_schema};`);
  }

  const cookieComment = auth === "cookie" ? "\n  // Cookies sent automatically by browser" : "";
  const credentialsOption = auth === "cookie" ? '\n    credentials: "include",' : "";

  const bodyOption = hasBody
    ? `\n    body: JSON.stringify(body),`
    : "";

  const code = `${typeBlock.length ? typeBlock.join("\n") + "\n\n" : ""}const BASE_URL = process.env.${baseUrlVar} ?? "";

export ${signature}: Promise<${responseType}> {
  const url = \`\${BASE_URL}${pathWithVars}\`;

  const response = await fetch(url, {
    method: "${method}",
    headers: {${authHeaders ? "\n" + authHeaders : ""}
      "Content-Type": "application/json",
      "Accept": "application/json",
    },${credentialsOption}${bodyOption}
  });${cookieComment}

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(\`\${method} \${url} failed: \${response.status} \${errorText}\`);
  }

  if (response.status === 204) {
    return undefined as ${responseType};
  }

  return response.json() as Promise<${responseType}>;
}

// Usage example:
// const data = await ${fnName}(${buildUsageExample(endpoint, method, request_schema, auth)});`;

  const lines: string[] = [
    `✅ API client: ${method} ${endpoint}`,
    `📄 Function: ${fnName}`,
    `🔧 Auth: ${auth} | Base URL: process.env.${baseUrlVar}`,
    ``,
    "```typescript",
    code,
    "```",
    ``,
    `💡 Reasoning: Generated a typed fetch wrapper for ${method} ${endpoint}. ` +
      `Throws on non-2xx responses with status + body in the error message. ` +
      `204 No Content returns \`undefined\`. ` +
      (auth === "cookie"
        ? "Uses credentials: include for cookie-based auth. "
        : auth === "bearer"
          ? "Pass the JWT/token as the `token` parameter. "
          : auth === "apikey"
            ? "Pass the API key as the `apiKey` parameter. "
            : "") +
      `Replace type aliases with your actual interfaces.`,
  ];

  return lines.join("\n");
}

function buildUsageExample(
  endpoint: string,
  method: string,
  requestSchema: string | undefined,
  auth: string,
): string {
  const pathParams = [...endpoint.matchAll(/:([a-zA-Z_]+)|{([a-zA-Z_]+)}/g)].map(
    (m) => `"${m[1] ?? m[2]}-value"`,
  );
  const parts = [...pathParams];
  if (["POST", "PUT", "PATCH"].includes(method)) {
    parts.push(requestSchema ? "{ /* body */ }" : "{}");
  }
  if (auth === "bearer") parts.push('"YOUR_TOKEN"');
  if (auth === "apikey") parts.push('"YOUR_API_KEY"');
  return parts.join(", ");
}
