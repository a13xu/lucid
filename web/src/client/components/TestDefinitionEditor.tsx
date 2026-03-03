import { useState, useEffect } from "react";
import type {
  TestDefinition,
  AssertionFormItem,
  AssertionType,
  HeaderItem,
  CreateTestInput,
  Assertion,
  HttpMethod,
} from "../types";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ASSERTION_TYPES: AssertionType[] = [
  "status",
  "body_key_exists",
  "body_json_path",
  "body_contains",
];
const BODY_METHODS: HttpMethod[] = ["POST", "PUT", "PATCH"];

let _idCounter = 0;
function uid() { return `a-${++_idCounter}`; }

function defToFormAssertions(defs: Assertion[]): AssertionFormItem[] {
  return defs.map(a => {
    const base: AssertionFormItem = {
      _id: uid(),
      type: a.type,
      statusExpected: "",
      key: "",
      path: "",
      pathExpected: "",
      containsValue: "",
    };
    switch (a.type) {
      case "status":
        return { ...base, statusExpected: String(a.expected) };
      case "body_key_exists":
        return { ...base, key: a.key };
      case "body_json_path":
        return { ...base, path: a.path, pathExpected: JSON.stringify(a.expected) };
      case "body_contains":
        return { ...base, containsValue: a.value };
    }
  });
}

function formToAssertions(items: AssertionFormItem[]): Assertion[] {
  return items.map(item => {
    switch (item.type) {
      case "status":
        return { type: "status", expected: Number(item.statusExpected) || 200 };
      case "body_key_exists":
        return { type: "body_key_exists", key: item.key };
      case "body_json_path": {
        let expected: unknown = item.pathExpected;
        try { expected = JSON.parse(item.pathExpected); } catch { /* keep as string */ }
        return { type: "body_json_path", path: item.path, expected };
      }
      case "body_contains":
        return { type: "body_contains", value: item.containsValue };
    }
  });
}

interface TestDefinitionEditorProps {
  initial?: TestDefinition | null;
  taskId: number;
  onSave: (data: CreateTestInput) => Promise<void>;
  onCancel?: () => void;
  isSaving?: boolean;
}

export function TestDefinitionEditor({
  initial,
  onSave,
  onCancel,
  isSaving = false,
}: TestDefinitionEditorProps) {
  const [name, setName] = useState("");
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<HeaderItem[]>([]);
  const [body, setBody] = useState("");
  const [assertions, setAssertions] = useState<AssertionFormItem[]>([]);

  // Sync when initial test changes
  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setMethod(initial.method);
      setUrl(initial.url);
      setHeaders(
        Object.entries(initial.headers).map(([k, v]) => ({ _id: uid(), key: k, value: v }))
      );
      setBody(initial.body ?? "");
      setAssertions(defToFormAssertions(initial.assertions));
    } else {
      setName("");
      setMethod("GET");
      setUrl("");
      setHeaders([]);
      setBody("");
      setAssertions([]);
    }
  }, [initial]);

  const addHeader = () => setHeaders(h => [...h, { _id: uid(), key: "", value: "" }]);
  const removeHeader = (id: string) => setHeaders(h => h.filter(x => x._id !== id));
  const updateHeader = (id: string, field: "key" | "value", val: string) =>
    setHeaders(h => h.map(x => x._id === id ? { ...x, [field]: val } : x));

  const addAssertion = () =>
    setAssertions(a => [...a, {
      _id: uid(), type: "status", statusExpected: "200",
      key: "", path: "", pathExpected: "", containsValue: "",
    }]);
  const removeAssertion = (id: string) => setAssertions(a => a.filter(x => x._id !== id));
  const updateAssertion = (id: string, update: Partial<AssertionFormItem>) =>
    setAssertions(a => a.map(x => x._id === id ? { ...x, ...update } : x));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const headersRecord: Record<string, string> = {};
    headers.forEach(h => { if (h.key) headersRecord[h.key] = h.value; });
    await onSave({
      name,
      method,
      url,
      headers: headersRecord,
      body: BODY_METHODS.includes(method) && body ? body : null,
      assertions: formToAssertions(assertions),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Name */}
      <div>
        <label className="block text-xs text-gray-400 mb-1">Test Name</label>
        <input
          required
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Create user returns 201"
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
        />
      </div>

      {/* Method + URL */}
      <div className="flex gap-2">
        <select
          value={method}
          onChange={e => setMethod(e.target.value as HttpMethod)}
          className="bg-gray-700 border border-gray-600 rounded px-2 py-2 text-white text-sm font-mono focus:outline-none focus:border-indigo-500"
        >
          {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          required
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="http://localhost:3000/api/..."
          className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-indigo-500"
        />
      </div>

      {/* Headers */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-400">Headers</label>
          <button type="button" onClick={addHeader}
            className="text-xs text-indigo-400 hover:text-indigo-300">+ Add</button>
        </div>
        {headers.map(h => (
          <div key={h._id} className="flex gap-1 mb-1">
            <input
              value={h.key}
              onChange={e => updateHeader(h._id, "key", e.target.value)}
              placeholder="Key"
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
            />
            <input
              value={h.value}
              onChange={e => updateHeader(h._id, "value", e.target.value)}
              placeholder="Value"
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
            />
            <button type="button" onClick={() => removeHeader(h._id)}
              className="text-gray-500 hover:text-red-400 px-1">×</button>
          </div>
        ))}
        {headers.length === 0 && (
          <p className="text-xs text-gray-600 italic">No headers</p>
        )}
      </div>

      {/* Body (POST/PUT/PATCH only) */}
      {BODY_METHODS.includes(method) && (
        <div>
          <label className="block text-xs text-gray-400 mb-1">Body (JSON)</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={4}
            placeholder='{"key": "value"}'
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-indigo-500 resize-y"
          />
        </div>
      )}

      {/* Assertions */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-400">Assertions</label>
          <button type="button" onClick={addAssertion}
            className="text-xs text-indigo-400 hover:text-indigo-300">+ Add</button>
        </div>
        {assertions.map(a => (
          <div key={a._id} className="flex gap-1 mb-1 items-center bg-gray-900 rounded p-2">
            <select
              value={a.type}
              onChange={e => updateAssertion(a._id, { type: e.target.value as AssertionType })}
              className="bg-gray-700 border border-gray-600 rounded px-1.5 py-1 text-white text-xs focus:outline-none"
            >
              {ASSERTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            {a.type === "status" && (
              <input
                type="number"
                value={a.statusExpected}
                onChange={e => updateAssertion(a._id, { statusExpected: e.target.value })}
                placeholder="200"
                className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs font-mono focus:outline-none"
              />
            )}
            {a.type === "body_key_exists" && (
              <input
                value={a.key}
                onChange={e => updateAssertion(a._id, { key: e.target.value })}
                placeholder="key name"
                className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs font-mono focus:outline-none"
              />
            )}
            {a.type === "body_json_path" && (
              <>
                <input
                  value={a.path}
                  onChange={e => updateAssertion(a._id, { path: e.target.value })}
                  placeholder="user.email"
                  className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs font-mono focus:outline-none"
                />
                <span className="text-gray-500 text-xs">=</span>
                <input
                  value={a.pathExpected}
                  onChange={e => updateAssertion(a._id, { pathExpected: e.target.value })}
                  placeholder='"value" or 42'
                  className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs font-mono focus:outline-none"
                />
              </>
            )}
            {a.type === "body_contains" && (
              <input
                value={a.containsValue}
                onChange={e => updateAssertion(a._id, { containsValue: e.target.value })}
                placeholder="substring to find"
                className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs font-mono focus:outline-none"
              />
            )}

            <button type="button" onClick={() => removeAssertion(a._id)}
              className="text-gray-500 hover:text-red-400 ml-auto">×</button>
          </div>
        ))}
        {assertions.length === 0 && (
          <p className="text-xs text-gray-600 italic">No assertions — test always passes</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={isSaving}
          className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 rounded px-4 py-2 text-white text-sm font-medium transition-colors"
        >
          {isSaving ? "Saving…" : initial ? "Update Test" : "Create Test"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
