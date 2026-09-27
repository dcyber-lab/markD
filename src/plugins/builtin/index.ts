import type { MarkdPlugin } from "../api";
import { alerts } from "./alerts";
import { basics } from "./basics";
import { codeBlocks } from "./code-blocks";
import { emojiShortcodes } from "./emoji";
import { footnotesPlugin } from "./footnotes";
import { frontMatter } from "./front-matter";
import { images } from "./images";
import { lists } from "./lists";
import { math } from "./math";
import { mermaidDiagrams } from "./mermaid";
import { s3 } from "./s3";
import { tables } from "./tables";
import { wordCount } from "./word-count";

/** Features that ship with markd, written against the same API as third-party plugins. */
export const builtinPlugins: MarkdPlugin[] = [
  basics,
  lists,
  codeBlocks,
  tables,
  alerts,
  footnotesPlugin,
  emojiShortcodes,
  math,
  mermaidDiagrams,
  frontMatter,
  images,
  s3,
  wordCount,
];
