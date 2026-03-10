import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ScaffoldPageSchema = z.object({
  page_name: z.string().describe("Page name (e.g. 'About', 'Dashboard', 'ProductDetail')"),
  framework: z.enum(["nuxt", "next", "vue"]).describe("Target framework"),
  sections: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe("Page sections (e.g. ['hero', 'features', 'pricing', 'footer'])"),
  seo_title: z.string().optional().describe("Optional SEO title for the page"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function buildNuxtPage(
  pageName: string,
  sections: string[],
  seoTitle: string,
): string {
  const componentName = toPascalCase(pageName) + "Page";
  const sectionComponents = sections.map((s) => {
    const name = toPascalCase(s);
    return `  <!-- ${name} section -->\n  <section id="${s.toLowerCase()}" class="py-16">\n    <h2 class="text-2xl font-bold">{{ /* ${name} heading */ }}</h2>\n    <!-- TODO: ${name} content -->\n  </section>`;
  });

  return `<script setup lang="ts">
// ${componentName}

useHead({
  title: "${seoTitle}",
  meta: [
    { name: "description", content: "TODO: add page description" },
  ],
});

// TODO: fetch page data
// const { data } = await useFetch("/api/${pageName.toLowerCase()}")
</script>

<template>
  <main>
${sectionComponents.join("\n\n")}
  </main>
</template>`;
}

function buildNextPage(
  pageName: string,
  sections: string[],
  seoTitle: string,
): string {
  const componentName = toPascalCase(pageName) + "Page";
  const sectionComponents = sections.map((s) => {
    const name = toPascalCase(s);
    return `      {/* ${name} */}\n      <section id="${s.toLowerCase()}" className="py-16">\n        <h2 className="text-2xl font-bold">{/* ${name} heading */}</h2>\n        {/* TODO: ${name} content */}\n      </section>`;
  });

  return `import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "${seoTitle}",
  description: "TODO: add page description",
};

export default function ${componentName}() {
  return (
    <main>
${sectionComponents.join("\n\n")}
    </main>
  );
}`;
}

function buildVuePage(
  pageName: string,
  sections: string[],
  seoTitle: string,
): string {
  const componentName = toPascalCase(pageName) + "Page";
  const sectionComponents = sections.map((s) => {
    const name = toPascalCase(s);
    return `  <!-- ${name} section -->\n  <section :id="'${s.toLowerCase()}'" class="py-16">\n    <h2 class="text-2xl font-bold"><!-- ${name} heading --></h2>\n    <!-- TODO: ${name} content -->\n  </section>`;
  });

  return `<script setup lang="ts">
// ${componentName}

// TODO: set page title via your router meta or vue-meta
// useTitle("${seoTitle}")

// TODO: fetch page data
// const pageData = ref(null)
</script>

<template>
  <main>
${sectionComponents.join("\n\n")}
  </main>
</template>`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handleScaffoldPage({ page_name: "About", framework: "nuxt", sections: ["hero", "team", "contact"], seo_title: "About Us" })

export function handleScaffoldPage(
  args: z.infer<typeof ScaffoldPageSchema>,
): string {
  const { page_name, framework, sections, seo_title } = args;
  const seoTitle = seo_title ?? page_name;
  const safeName = toPascalCase(page_name) || "Page";

  let code: string;
  let filename: string;
  let lang: string;

  switch (framework) {
    case "nuxt":
      code = buildNuxtPage(page_name, sections, seoTitle);
      filename = `pages/${page_name.toLowerCase()}.vue`;
      lang = "vue";
      break;
    case "next":
      code = buildNextPage(page_name, sections, seoTitle);
      filename = `app/${page_name.toLowerCase()}/page.tsx`;
      lang = "tsx";
      break;
    default: // vue
      code = buildVuePage(page_name, sections, seoTitle);
      filename = `views/${safeName}View.vue`;
      lang = "vue";
  }

  const lines: string[] = [
    `✅ Page scaffold: ${safeName}`,
    `📄 Filename: ${filename}`,
    `🔧 Framework: ${framework} | Sections: ${sections.join(", ")}`,
    ``,
    "```" + lang,
    code,
    "```",
    ``,
    `💡 Reasoning: Generated a ${framework} page with ${sections.length} section(s). ` +
      `SEO title set to "${seoTitle}". ` +
      `Each section has a placeholder — implement content and connect to your data layer.`,
  ];

  return lines.join("\n");
}
