import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ResponsiveLayoutSchema = z.object({
  description: z.string().describe("Wireframe description (e.g. 'sidebar left, main content, right panel')"),
  framework: z
    .enum(["tailwind", "css-grid", "flexbox"])
    .describe("CSS framework/technique to use"),
  breakpoints: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe("Breakpoint names to handle (e.g. ['mobile', 'tablet', 'desktop'])"),
  container: z
    .enum(["full", "centered", "sidebar"])
    .optional()
    .default("centered")
    .describe("Layout container type"),
});

// ---------------------------------------------------------------------------
// Layout builders
// ---------------------------------------------------------------------------

function buildTailwindLayout(
  description: string,
  breakpoints: string[],
  container: string,
): string {
  const hasMobile = breakpoints.some((b) => /mobile|sm|xs/i.test(b));
  const hasTablet = breakpoints.some((b) => /tablet|md/i.test(b));
  const hasDesktop = breakpoints.some((b) => /desktop|lg|xl/i.test(b));

  const colsClass =
    container === "sidebar"
      ? `grid-cols-1${hasTablet ? " md:grid-cols-[260px_1fr]" : ""}${hasDesktop ? " lg:grid-cols-[280px_1fr_240px]" : ""}`
      : `grid-cols-1${hasTablet ? " md:grid-cols-2" : ""}${hasDesktop ? " lg:grid-cols-3" : ""}`;

  const containerClass =
    container === "full"
      ? "w-full"
      : container === "sidebar"
        ? "max-w-screen-xl mx-auto px-4"
        : "max-w-screen-lg mx-auto px-4 sm:px-6 lg:px-8";

  const isSidebar = container === "sidebar";

  const code = `{/* ${description} */}
<div class="${containerClass}">

  {/* Mobile-first responsive ${isSidebar ? "sidebar layout" : "grid"} */}
  <div class="grid ${colsClass} gap-6 py-8">

    ${isSidebar ? `{/* Sidebar — hidden on mobile, visible md+ */}
    <aside class="${hasMobile ? "hidden md:block " : ""}sticky top-4 h-fit">
      <nav>
        {/* Sidebar navigation */}
      </nav>
    </aside>

    {/* Main content */}
    <main class="min-w-0">
      {/* Primary content */}
    </main>

    ${hasDesktop ? `{/* Right panel — visible lg+ */}
    <aside class="hidden lg:block space-y-6">
      {/* Right panel widgets */}
    </aside>` : ""}` : `{/* Grid cells — adjust col-span as needed */}
    <section class="col-span-1${hasDesktop ? " lg:col-span-2" : ""}">
      {/* Main content */}
    </section>

    <aside class="${hasMobile ? "col-span-1" : ""}${hasTablet ? " md:col-span-1" : ""}">
      {/* Secondary content */}
    </aside>`}

  </div>
</div>`;

  return code;
}

function buildCssGridLayout(
  description: string,
  breakpoints: string[],
  container: string,
): { html: string; css: string } {
  const hasMobile = breakpoints.some((b) => /mobile|sm|xs/i.test(b));
  const hasTablet = breakpoints.some((b) => /tablet|md/i.test(b));
  const hasDesktop = breakpoints.some((b) => /desktop|lg|xl/i.test(b));

  const isSidebar = container === "sidebar";

  const html = `<!-- ${description} -->
<div class="page-container">
  <div class="layout-grid">
    ${isSidebar ? `<aside class="sidebar">
      <!-- Sidebar -->
    </aside>
    <main class="main-content">
      <!-- Main content -->
    </main>
    <aside class="right-panel">
      <!-- Right panel -->
    </aside>` : `<section class="primary">
      <!-- Primary content -->
    </section>
    <aside class="secondary">
      <!-- Secondary content -->
    </aside>`}
  </div>
</div>`;

  const mobileGrid = isSidebar
    ? `grid-template-columns: 1fr;\n  grid-template-areas:\n    "main"\n    "sidebar"\n    "right";`
    : `grid-template-columns: 1fr;\n  grid-template-areas:\n    "primary"\n    "secondary";`;

  const tabletGrid = isSidebar
    ? `grid-template-columns: 260px 1fr;\n    grid-template-areas:\n      "sidebar main"\n      "sidebar right";`
    : `grid-template-columns: 2fr 1fr;\n    grid-template-areas:\n      "primary secondary";`;

  const desktopGrid = isSidebar
    ? `grid-template-columns: 280px 1fr 240px;\n      grid-template-areas: "sidebar main right";`
    : `grid-template-columns: repeat(3, 1fr);\n      grid-template-areas: "primary primary secondary";`;

  const css = `.page-container {
  width: 100%;
  max-width: ${container === "full" ? "100%" : "1200px"};
  margin: 0 auto;
  padding: 0 1rem;
}

.layout-grid {
  display: grid;
  gap: 1.5rem;
  /* Mobile — single column */
  ${mobileGrid}
}

${hasTablet ? `@media (min-width: 768px) {
  .layout-grid {
    ${tabletGrid}
  }
}` : ""}

${hasDesktop ? `@media (min-width: 1024px) {
  .layout-grid {
    ${desktopGrid}
  }
}` : ""}

${isSidebar ? `.sidebar   { grid-area: sidebar; }
.main-content { grid-area: main; }
.right-panel  { grid-area: right; }` : `.primary   { grid-area: primary; }
.secondary { grid-area: secondary; }`}`;

  return { html, css };
}

function buildFlexboxLayout(
  description: string,
  breakpoints: string[],
  container: string,
): { html: string; css: string } {
  const hasTablet = breakpoints.some((b) => /tablet|md/i.test(b));
  const hasDesktop = breakpoints.some((b) => /desktop|lg|xl/i.test(b));
  const isSidebar = container === "sidebar";

  const html = `<!-- ${description} -->
<div class="page-container">
  <div class="flex-layout">
    ${isSidebar ? `<aside class="flex-sidebar">
      <!-- Sidebar -->
    </aside>
    <main class="flex-main">
      <!-- Main content -->
    </main>` : `<section class="flex-primary">
      <!-- Primary content -->
    </section>
    <aside class="flex-secondary">
      <!-- Secondary content -->
    </aside>`}
  </div>
</div>`;

  const css = `.page-container {
  max-width: ${container === "full" ? "100%" : "1200px"};
  margin: 0 auto;
  padding: 0 1rem;
}

/* Mobile first: stacked */
.flex-layout {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

${hasTablet || hasDesktop ? `@media (min-width: ${hasTablet ? "768px" : "1024px"}) {
  .flex-layout {
    flex-direction: row;
    align-items: flex-start;
  }

  ${isSidebar ? `.flex-sidebar {
    flex: 0 0 260px;
    position: sticky;
    top: 1rem;
  }

  .flex-main {
    flex: 1 1 0;
    min-width: 0; /* prevent overflow */
  }` : `.flex-primary {
    flex: 2 1 0;
    min-width: 0;
  }

  .flex-secondary {
    flex: 1 1 0;
    min-width: 0;
  }`}
}` : ""}`;

  return { html, css };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handleResponsiveLayout({ description: "sidebar left, main content area, right widgets panel", framework: "tailwind", breakpoints: ["mobile", "tablet", "desktop"], container: "sidebar" })

export function handleResponsiveLayout(
  args: z.infer<typeof ResponsiveLayoutSchema>,
): string {
  const { description, framework, breakpoints, container } = args;
  const c = container ?? "centered";

  const lines: string[] = [
    `✅ Responsive layout: ${framework}`,
    `📐 Breakpoints: ${breakpoints.join(", ")} | Container: ${c}`,
    ``,
  ];

  if (framework === "tailwind") {
    const code = buildTailwindLayout(description, breakpoints, c);
    lines.push("```jsx", code, "```");
  } else if (framework === "css-grid") {
    const { html, css } = buildCssGridLayout(description, breakpoints, c);
    lines.push("```html", html, "```", "", "```css", css, "```");
  } else {
    // flexbox
    const { html, css } = buildFlexboxLayout(description, breakpoints, c);
    lines.push("```html", html, "```", "", "```css", css, "```");
  }

  lines.push(
    ``,
    `💡 Reasoning: Mobile-first ${framework} layout for "${description}". ` +
      `Container is "${c}". Breakpoints detected: ${breakpoints.join(", ")}. ` +
      (framework === "tailwind"
        ? "Tailwind responsive prefixes (sm:/md:/lg:) handle breakpoints. "
        : "CSS custom properties can replace hardcoded values. ") +
      "Fill in actual content within each section. Add overflow: hidden to prevent content spillage.",
  );

  return lines.join("\n");
}
