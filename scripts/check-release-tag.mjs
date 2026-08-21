import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const expected = `v${manifest.version}`;
const actual = process.env.RELEASE_TAG;

if (actual !== expected) {
  throw new Error(`Release tag must match package.json: expected ${expected}, received ${actual ?? "nothing"}.`);
}
