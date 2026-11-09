import { getWelcomeMessage } from "../src/index.js"
import { describe, it, expect } from "vitest";

describe("first test suit",()=>{
    it("return afk agent welcome message",()=>{
        expect(getWelcomeMessage()).toBe("AFK Agent is ready.")
    });
});

