// The hast tree of a converted .docx (/api/docx). The server already sanitises the HTML with
// an allowlist; this re-sanitises it with an equally strict schema before anything renders it.
// Pure (no "@/" imports): unit tested with node --test.

import type { Element, Root } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";

/** Embedded images arrive as data URLs of raster types only; anything else loses its src. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/;
const SAFE_HREF = /^(?:https?:|mailto:|#)/i;

/** What the converter emits, nothing more: no classes, styles, events, iframes or forms. */
const DOCX_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr",
    "th", "td", "blockquote", "pre", "hr", "br", "strong", "b", "em", "i", "u", "s", "sub", "sup", "a",
    "img", "code",
  ],
  attributes: {
    a: ["href", "id"],
    img: ["src", "alt"],
    li: ["id"],
    td: ["colSpan", "rowSpan"],
    th: ["colSpan", "rowSpan"],
  },
  protocols: { href: ["http", "https", "mailto"], src: ["data"] },
  required: {},
  strip: ["script", "style", "template", "iframe", "object", "embed", "svg", "math", "noscript", "textarea", "title"],
  // the default ids ("user-content-" prefix) cannot clobber the page's own ids
  clobberPrefix: defaultSchema.clobberPrefix,
  clobber: defaultSchema.clobber,
};

function visitElements(node: Root | Element, fn: (el: Element) => void) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    fn(child);
    visitElements(child, fn);
  }
}

/**
 * Parses and sanitises the converted HTML, keeps bookmark anchors as `<span id>` targets, adds
 * heading ids (as the markdown viewer does) and
 * the markdown line range of every top-level block as its position, so the "changed since
 * viewed" marks (lib/rehype-change-marks.ts) line up with the block diff of the markdown.
 * Positions are left out when the blocks do not match the elements one to one.
 */
export function docxTree(html: string, blocks: [number, number][]): Root {
  const parsed = rehypeRaw()({ type: "root", children: [{ type: "raw", value: html }] } as unknown as Root, undefined as never);
  const tree = rehypeSanitize(DOCX_SCHEMA)(parsed);
  visitElements(tree, (el) => {
    if (el.tagName === "img") {
      const src = el.properties.src;
      if (typeof src !== "string" || !DATA_IMAGE.test(src)) delete el.properties.src;
    } else if (el.tagName === "a") {
      const href = el.properties.href;
      if (href !== undefined && (typeof href !== "string" || !SAFE_HREF.test(href))) delete el.properties.href;
      // A Word bookmark (`<a id="_Toc1"></a>`, the target of the document's own table of contents
      // and cross-references) has no href; the markdown viewer's link component would drop its id.
      if (el.properties.href === undefined && typeof el.properties.id === "string") el.tagName = "span";
    }
  });
  rehypeSlug()(tree);
  const top = tree.children.filter((n): n is Element => n.type === "element");
  for (const el of top) delete el.position;
  if (top.length === blocks.length) {
    top.forEach((el, i) => {
      const [start, end] = blocks[i];
      el.position = { start: { line: start, column: 1 }, end: { line: end, column: 1 } };
    });
  }
  return tree;
}
