import fs from "node:fs";
import { renderReducerCatalogueMarkdown } from "../src/lib/reducers";

const path = "docs/EVENTS.md";
const start = "<!-- reducer-catalogue:start -->";
const end = "<!-- reducer-catalogue:end -->";
const markdown = fs.readFileSync(path, "utf8");
if (!markdown.includes(start) || !markdown.includes(end)) {
  throw new Error(`docs/EVENTS.md is missing ${start} / ${end}`);
}
const next = markdown.replace(
  new RegExp(`${start}[\\s\\S]*?${end}`),
  `${start}\n${renderReducerCatalogueMarkdown()}\n${end}`,
);
fs.writeFileSync(path, next);
console.log("wrote reducer catalogue into docs/EVENTS.md");
