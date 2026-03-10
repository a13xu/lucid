import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const GenerateComponentSchema = z.object({
  description: z.string().describe("Natural language description of the component"),
  framework: z.enum(["react", "vue", "nuxt"]).describe("Target framework"),
  styling: z.enum(["tailwind", "css-modules", "none"]).describe("Styling approach"),
  typescript: z.boolean().describe("Whether to use TypeScript"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function buildReactComponent(
  name: string,
  description: string,
  styling: string,
  typescript: boolean,
): { code: string; lang: string } {
  const ts = typescript;
  let styleImport = "";
  let classAttr = "";

  if (styling === "tailwind") {
    classAttr = `className="flex flex-col gap-4"`;
  } else if (styling === "css-modules") {
    styleImport = `\nimport styles from "./${name}.module.css";`;
    classAttr = `className={styles.container}`;
  }

  const propsBlock = ts
    ? `\ninterface ${name}Props {\n  // TODO: define props\n}\n`
    : "";

  const fnSignature = ts
    ? `export const ${name}: React.FC<${name}Props> = (_props) => {`
    : `export const ${name} = (_props) => {`;

  const reactImport = ts ? `import React from "react";` : `import React from "react";`;

  const code = `${reactImport}${styleImport}
${propsBlock}
// ${description}
${fnSignature}
  return (
    <div ${classAttr}>
      {/* ${description} */}
    </div>
  );
};

export default ${name};`;

  return { code, lang: ts ? "tsx" : "jsx" };
}

function buildVueComponent(
  name: string,
  description: string,
  styling: string,
  typescript: boolean,
): { code: string; lang: string } {
  const scriptLang = typescript ? ` lang="ts"` : "";

  let classAttr = "class=\"container\"";
  let styleTag = "";

  if (styling === "tailwind") {
    classAttr = "class=\"flex flex-col gap-4\"";
  } else if (styling === "css-modules") {
    classAttr = `:class="$style.container"`;
    styleTag = `\n<style module>\n.container {\n  /* ${name} styles */\n}\n</style>`;
  } else {
    styleTag = `\n<style scoped>\n.container {\n  /* ${name} styles */\n}\n</style>`;
  }

  const code = `<script setup${scriptLang}>
// ${description}
// TODO: define props and emits
// const props = defineProps<{}>()
</script>

<template>
  <div ${classAttr}>
    <!-- ${description} -->
  </div>
</template>${styleTag}`;

  return { code, lang: "vue" };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handleGenerateComponent({ description: "user profile card with avatar", framework: "react", styling: "tailwind", typescript: true })

export function handleGenerateComponent(
  args: z.infer<typeof GenerateComponentSchema>,
): string {
  const { description, framework, styling, typescript } = args;
  const componentName = toPascalCase(description) || "MyComponent";

  let code: string;
  let lang: string;
  let filename: string;

  if (framework === "react") {
    ({ code, lang } = buildReactComponent(componentName, description, styling, typescript));
    filename = `${componentName}.${typescript ? "tsx" : "jsx"}`;
  } else {
    // vue or nuxt
    ({ code, lang } = buildVueComponent(componentName, description, styling, typescript));
    filename = `${componentName}.vue`;
  }

  const styleNote =
    styling === "tailwind"
      ? "Tailwind CSS utility classes pre-applied"
      : styling === "css-modules"
        ? "CSS Modules — a .module.css file is also needed"
        : "No styling framework — add your own styles";

  const lines: string[] = [
    `✅ Component: ${componentName}`,
    `📄 Filename: ${filename}`,
    `🔧 ${framework.toUpperCase()} | ${styling} | TypeScript: ${typescript}`,
    ``,
    "```" + lang,
    code,
    "```",
    ``,
    `💡 Reasoning: Scaffold for "${description}". ${styleNote}. ` +
      `Fill in props, state, and template logic. ` +
      (framework === "react"
        ? "Define props in the interface and remove unused ones."
        : "Use defineProps<>() and defineEmits<>() as needed."),
  ];

  return lines.join("\n");
}
