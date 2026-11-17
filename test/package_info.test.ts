import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/package_info.js";

describe("packageVersion", () => {
    it("reads the version from the package manifest", () => {
        const manifest = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version: string };

        expect(packageVersion()).toBe(manifest.version);
    });
});
