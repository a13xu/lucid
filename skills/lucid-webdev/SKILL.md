---
name: lucid-webdev
description: Web development helpers — component and page scaffolding, API clients, SEO meta, design tokens, and accessibility, security, and performance audits via Lucid's web dev tools. Use for UI and frontend work.
argument-hint: "[what you are building: component/page/api/audit]"
allowed-tools:
  - mcp__lucid__lucid_toolsets
  - mcp__lucid__generate_component
  - mcp__lucid__scaffold_page
  - mcp__lucid__seo_meta
  - mcp__lucid__accessibility_audit
  - mcp__lucid__api_client
  - mcp__lucid__test_generator
  - mcp__lucid__responsive_layout
  - mcp__lucid__security_scan
  - mcp__lucid__design_tokens
  - mcp__lucid__perf_hints
  - Write
  - Edit
---

These tools start disabled. Enable them for the session with
`lucid_toolsets(enable=["webdev"])`.

The generators give a starting skeleton and the auditors give a checklist-driven pass.
Either way, adapt the output to the project's existing conventions rather than pasting
it in as-is.

| Task | Tool |
|---|---|
| React/Vue component | `generate_component(description, framework, styling, typescript)` |
| Full page | `scaffold_page(page_name, framework, sections, seo_title)` |
| SEO meta tags | `seo_meta(title, description, keywords, page_type, url, image_url)` |
| Accessibility audit | `accessibility_audit(code, wcag_level, framework)` |
| API client | `api_client(endpoint, method, response_schema, auth, base_url_var)` |
| Test scaffolding | `test_generator(code, test_framework, test_type, component_framework)` |
| Responsive layout | `responsive_layout(description, framework, breakpoints, container)` |
| Security scan | `security_scan(code, language, context)` |
| Design tokens | `design_tokens(brand_name, primary_color, mood, output_format)` |
| Performance hints | `perf_hints(code, framework, context)` |

Run `/lucid-audit` on the result before calling it done.
