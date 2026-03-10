import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SeoMetaSchema = z.object({
  title: z.string().describe("Page title"),
  description: z.string().describe("Page meta description (≤160 chars recommended)"),
  keywords: z.array(z.string()).describe("SEO keywords"),
  page_type: z
    .enum(["article", "product", "landing", "home"])
    .describe("Page type for structured data"),
  url: z.string().optional().describe("Canonical page URL"),
  image_url: z.string().optional().describe("OG/Twitter image URL"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildJsonLd(
  type: string,
  title: string,
  description: string,
  url: string,
  imageUrl: string,
): object {
  const base = {
    "@context": "https://schema.org",
    name: title,
    description,
    ...(url ? { url } : {}),
    ...(imageUrl ? { image: imageUrl } : {}),
  };

  switch (type) {
    case "article":
      return {
        ...base,
        "@type": "Article",
        headline: title,
        datePublished: new Date().toISOString().split("T")[0],
        author: { "@type": "Person", name: "Author" },
      };
    case "product":
      return {
        ...base,
        "@type": "Product",
        offers: {
          "@type": "Offer",
          priceCurrency: "USD",
          price: "0.00",
          availability: "https://schema.org/InStock",
        },
      };
    case "home":
      return {
        ...base,
        "@type": "WebSite",
        potentialAction: {
          "@type": "SearchAction",
          target: `${url ?? ""}/search?q={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      };
    default: // landing
      return { ...base, "@type": "WebPage" };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handleSeoMeta({ title: "Buy Widgets", description: "Best widgets online", keywords: ["widget", "shop"], page_type: "product", url: "https://example.com/widgets", image_url: "https://example.com/og.jpg" })

export function handleSeoMeta(args: z.infer<typeof SeoMetaSchema>): string {
  const { title, description, keywords, page_type, url, image_url } = args;
  const canonicalUrl = url ?? "https://example.com/YOUR_PAGE";
  const ogImage = image_url ?? "https://example.com/og-image.jpg";
  const keywordStr = keywords.join(", ");

  const jsonLd = buildJsonLd(page_type, title, description, canonicalUrl, ogImage);
  const jsonLdStr = JSON.stringify(jsonLd, null, 2);

  const descWarning =
    description.length > 160
      ? `\n⚠️  Description is ${description.length} chars (recommended ≤160)`
      : "";

  const metaTags = `<!-- Primary Meta Tags -->
<title>${title}</title>
<meta name="title" content="${title}" />
<meta name="description" content="${description}" />
<meta name="keywords" content="${keywordStr}" />
<link rel="canonical" href="${canonicalUrl}" />

<!-- Open Graph / Facebook -->
<meta property="og:type" content="${page_type === "article" ? "article" : "website"}" />
<meta property="og:url" content="${canonicalUrl}" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:image" content="${ogImage}" />

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:url" content="${canonicalUrl}" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
<meta name="twitter:image" content="${ogImage}" />

<!-- JSON-LD Structured Data -->
<script type="application/ld+json">
${jsonLdStr}
</script>`;

  const lines: string[] = [
    `✅ SEO meta for: ${title}${descWarning}`,
    `📄 Page type: ${page_type} | Keywords: ${keywords.length}`,
    ``,
    "```html",
    metaTags,
    "```",
    ``,
    `💡 Reasoning: Generated complete SEO metadata including primary tags, Open Graph, ` +
      `Twitter Card, and ${page_type} JSON-LD structured data. ` +
      `Replace placeholder URLs with your actual canonical URL and OG image. ` +
      `For Next.js, use the \`metadata\` export. For Nuxt, use \`useHead()\`.`,
  ];

  return lines.join("\n");
}
