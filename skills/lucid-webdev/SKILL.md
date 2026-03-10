---
name: lucid-webdev
description: Web development code generation tools — generate components, pages, SEO meta, API clients, tests, layouts, design tokens, and analyze accessibility and performance.
argument-hint: "[component | page | seo | a11y | api | test | layout | security | tokens | perf]"
---

# Lucid Web Dev Tools

10 tools for common web development tasks. Pick the one that matches what you need:

## Component & Page Generation

### Generate a component
```
generate_component(
  description="user profile card with avatar and edit button",
  framework="vue",          # react | vue | nuxt
  styling="tailwind",       # tailwind | css-modules | none
  typescript=true
)
```

### Generate a page scaffold
```
scaffold_page(
  page_name="ProductDetail",
  framework="nuxt",          # nuxt | next | vue
  sections=["hero", "specs", "reviews", "cta"],
  seo_title="Product Detail"
)
```

## SEO & Accessibility

### Generate SEO metadata
```
seo_meta(
  title="Buy Widgets — Best Price",
  description="Shop our range of premium widgets with free delivery.",
  keywords=["widgets", "buy widgets", "widget shop"],
  page_type="product",       # article | product | landing | home
  url="https://example.com/widgets",
  image_url="https://example.com/og/widgets.jpg"
)
```
Returns: HTML meta tags + Open Graph + Twitter Card + JSON-LD structured data.

### Audit accessibility (WCAG)
```
accessibility_audit(
  code="<your HTML/JSX/Vue snippet>",
  wcag_level="AA",           # A | AA | AAA
  framework="vue"            # html | jsx | vue
)
```
Returns: violations with severity (critical/warning/info), WCAG criterion, and corrected code.

## API & Testing

### Generate a typed API client
```
api_client(
  endpoint="/users/:id",
  method="GET",              # GET | POST | PUT | PATCH | DELETE
  response_schema="{ id: string; name: string; email: string }",
  auth="bearer",             # bearer | cookie | apikey | none
  base_url_var="NEXT_PUBLIC_API_URL"
)
```

### Generate tests
```
test_generator(
  code="<your function or component source>",
  test_framework="vitest",   # vitest | jest | playwright
  test_type="unit",          # unit | integration | e2e
  component_framework="vue"  # vue | react | none
)
```

## Layout & Design

### Generate a responsive layout
```
responsive_layout(
  description="sidebar left 260px, main content, right panel 240px",
  framework="tailwind",      # tailwind | css-grid | flexbox
  breakpoints=["mobile", "tablet", "desktop"],
  container="sidebar"        # full | centered | sidebar
)
```

### Generate design tokens
```
design_tokens(
  brand_name="Acme",
  primary_color="#6366F1",   # hex or name (blue, green, etc.)
  mood="minimal",            # minimal | bold | playful | corporate
  output_format="css-variables"  # css-variables | tailwind-config | json
)
```

## Security & Performance

### Scan for security vulnerabilities
```
security_scan(
  code="<your code snippet>",
  language="typescript",     # javascript | typescript | html | vue
  context="frontend"         # frontend | backend | api
)
```
Detects: XSS, eval/injection, hardcoded secrets, SQL injection, open redirects, CORS issues.

### Analyze Core Web Vitals issues
```
perf_hints(
  code="<your component or page source>",
  framework="vue",           # react | vue | nuxt | vanilla
  context="page"             # component | page | layout
)
```
Detects: missing image dimensions (CLS), render-blocking scripts (FCP), fetch-in-render (TTFB), heavy click handlers (INP), missing useMemo/computed.
