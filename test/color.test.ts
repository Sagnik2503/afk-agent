import { describe, expect, it } from "vitest";
import { createColors } from "../src/ui/color.js";

describe("createColors", () => {
    it("leaves text plain when stdout is not a TTY", () => {
        const color = createColors({ isTTY: false, env: {} });

        expect(color.bold("afk-agent")).toBe("afk-agent");
        expect(color.red("FAILED")).toBe("FAILED");
    });

    it("wraps text in ANSI when stdout is a TTY", () => {
        const color = createColors({ isTTY: true, env: {} });

        expect(color.red("FAILED")).toBe("\u001b[31mFAILED\u001b[0m");
        expect(color.bold("afk-agent")).toBe("\u001b[1mafk-agent\u001b[0m");
    });

    it("disables colour when NO_COLOR is set, even on a TTY", () => {
        const color = createColors({ isTTY: true, env: { NO_COLOR: "1" } });

        expect(color.green("SUCCESS")).toBe("SUCCESS");
    });

    it("disables colour when NO_COLOR is set to an empty value", () => {
        const color = createColors({ isTTY: true, env: { NO_COLOR: "" } });

        expect(color.cyan("phase")).toBe("phase");
    });
});
