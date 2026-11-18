import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { strict as assert } from "node:assert";
const directory = fileURLToPath(new URL("../extensions/dealify-discount/", import.meta.url));
function cli(args, input) {
  const result = spawnSync("shopify", ["app", "function", ...args, "--path", directory], { input, encoding: "utf8", env: { ...process.env, CI: "1" }, maxBuffer: 5 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error));
  return result.stdout;
}
cli(["build"]);
const fixtureDirectory = join(directory, "tests/fixtures");
for (const name of readdirSync(fixtureDirectory).filter(name => name.endsWith(".json")).sort()) {
  const fixture = JSON.parse(readFileSync(join(fixtureDirectory, name), "utf8"));
  const result = JSON.parse(cli(["run", "--export", "cart_lines_discounts_generate_run", "--json"], JSON.stringify(fixture.input)));
  assert.equal(result.success, true, `${name}: execution failed`);
  assert.deepEqual(result.output, fixture.expectedOutput, name);
  console.log(`PASS ${name} (${result.instructions} instructions)`);
}
