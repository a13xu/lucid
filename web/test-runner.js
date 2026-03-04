import { stmts } from "./db.js";

function getByPath(obj, path) {
  if (typeof obj !== "object" || obj === null) return undefined;
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function evaluateAssertions(assertions, statusCode, parsedBody, rawBody) {
  return assertions.map((a) => {
    switch (a.type) {
      case "status": {
        const pass = statusCode === a.expected;
        return { type: "status", expected: a.expected, actual: statusCode, pass };
      }
      case "body_key_exists": {
        const actual =
          typeof parsedBody === "object" && parsedBody !== null
            ? a.key in parsedBody
            : false;
        return { type: "body_key_exists", expected: `key "${a.key}" exists`, actual, pass: actual };
      }
      case "body_json_path": {
        const actual = getByPath(parsedBody, a.path);
        const pass = JSON.stringify(actual) === JSON.stringify(a.expected);
        return { type: "body_json_path", expected: a.expected, actual, pass };
      }
      case "body_contains": {
        const pass = rawBody.includes(a.value);
        return { type: "body_contains", expected: `contains "${a.value}"`, actual: pass, pass };
      }
      default:
        return { type: a.type, expected: null, actual: null, pass: false };
    }
  });
}

export async function runTest(def) {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const headers = JSON.parse(def.headers);
    const assertions = JSON.parse(def.assertions);

    const fetchOptions = {
      method: def.method,
      headers,
      signal: controller.signal,
    };
    if (def.body && ["POST", "PUT", "PATCH"].includes(def.method)) {
      fetchOptions.body = def.body;
    }

    const response = await fetch(def.url, fetchOptions);
    clearTimeout(timeout);
    const duration_ms = Date.now() - startTime;

    const rawBody = await response.text();
    let parsedBody = rawBody;
    try { parsedBody = JSON.parse(rawBody); } catch { /* keep as string */ }

    const responseHeaders = {};
    response.headers.forEach((v, k) => { responseHeaders[k] = v; });

    const assertions_result = evaluateAssertions(assertions, response.status, parsedBody, rawBody);
    const allPass = assertions.length === 0 || assertions_result.every(r => r.pass);

    return {
      status: allPass ? "pass" : "fail",
      status_code: response.status,
      response_body: rawBody,
      response_headers: responseHeaders,
      duration_ms,
      error_message: null,
      assertions_result,
    };
  } catch (err) {
    clearTimeout(timeout);
    const duration_ms = Date.now() - startTime;
    const message = err instanceof Error
      ? (err.name === "AbortError" ? "Request timed out (10s)" : err.message)
      : String(err);
    return {
      status: "error",
      status_code: null,
      response_body: null,
      response_headers: {},
      duration_ms,
      error_message: message,
      assertions_result: [],
    };
  }
}

export function saveTestRun(testDefId, result) {
  const res = stmts.insertTestRun.run(
    testDefId,
    result.status,
    result.status_code,
    result.response_body,
    JSON.stringify(result.response_headers),
    result.duration_ms,
    result.error_message,
    JSON.stringify(result.assertions_result)
  );
  const id = Number(res.lastInsertRowid);
  return {
    id,
    test_def_id: testDefId,
    status: result.status,
    status_code: result.status_code,
    response_body: result.response_body,
    response_headers: JSON.stringify(result.response_headers),
    duration_ms: result.duration_ms,
    error_message: result.error_message,
    assertions_result: JSON.stringify(result.assertions_result),
    run_at: Math.floor(Date.now() / 1000),
  };
}

export async function runAllForTask(taskId) {
  const defs = stmts.getTestsByTaskId.all(taskId);
  const results = await Promise.all(
    defs.map(async (def) => {
      const result = await runTest(def);
      const row = saveTestRun(def.id, result);
      return { ...row, test_name: def.name };
    })
  );
  return results;
}
