---
name: lucid-webdev
description: Use for web development tasks — generates components, pages, audits, API clients, and performance hints via Lucid's 10 web dev tools.
argument-hint: "[what you are building: component/page/api/audit]"
---

<HARD-GATE>
Before building any web component, page, or API client from scratch:
call the relevant generator tool first. Do not write boilerplate manually.
</HARD-GATE>

## When to invoke

**INVOKE when:** building UI components, scaffolding pages, writing API clients, running accessibility/security/performance audits
**DO NOT INVOKE for:** backend-only logic with no web layer

## Available tools

| Task | Tool |
|---|---|
| Generate a React/Vue component | `generate_component(description, framework, styling, typescript)` |
| Scaffold a full page | `scaffold_page(page_name, framework, sections, seo_title)` |
| SEO meta tags | `seo_meta(title, description, keywords, page_type, url, image_url)` |
| Accessibility audit | `accessibility_audit(code, wcag_level, framework)` |
| API client | `api_client(endpoint, method, response_schema, auth, base_url_var)` |
| Test scaffolding | `test_generator(code, test_framework, test_type, component_framework)` |
| Responsive layout | `responsive_layout(description, framework, breakpoints, container)` |
| Security scan | `security_scan(code, language, context)` |
| Design tokens | `design_tokens(brand_name, primary_color, mood, output_format)` |
| Performance hints | `perf_hints(code, framework, context)` |

## Workflow

1. Call the relevant generator/auditor tool
2. Review output → adapt to project conventions
3. `sync_file(path="<generated file>")` after saving
4. Run /lucid-audit before marking done
