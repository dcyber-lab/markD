import type { MarkdPlugin } from "../api";
import { basics } from "./basics";
import { codeBlocks } from "./code-blocks";
import { frontMatter } from "./front-matter";
import { images } from "./images";
import { lists } from "./lists";
import { s3 } from "./s3";
import { tables } from "./tables";
import { wordCount } from "./word-count";

/** Features that ship with markd, written against the same API as third-party plugins. */
export const builtinPlugins: MarkdPlugin[] = [basics, lists, codeBlocks, tables, frontMatter, images, s3, wordCount];
