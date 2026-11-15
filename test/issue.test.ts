import { describe, it, expect } from "vitest";
import {
    deriveTaskId,
    parseIssueUrl,
    slugify,
} from "../src/github/fetch_issues.js";
import type { GitHubIssue } from "../src/github/fetch_issues.js";

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
    return {
        number: 102,
        owner: "Sagnik2503",
        repo: "afk-agent",
        title: "Add a slug utility and tests",
        body: "",
        url: "https://github.com/Sagnik2503/afk-agent/issues/102",
        ...overrides,
    };
}

describe("parseIssueUrl", () => {
    it("extracts owner, repo, and issue number", () => {
        expect(
            parseIssueUrl("https://github.com/Sagnik2503/afk-agent/issues/102"),
        ).toEqual({ owner: "Sagnik2503", repo: "afk-agent", number: 102 });
    });

    it("tolerates a trailing slash", () => {
        expect(
            parseIssueUrl("https://github.com/owner/repo/issues/7/"),
        ).toEqual({ owner: "owner", repo: "repo", number: 7 });
    });

    it("rejects non-GitHub URLs", () => {
        expect(
            parseIssueUrl("https://gitlab.com/owner/repo/issues/7"),
        ).toBeNull();
        expect(parseIssueUrl("not a url")).toBeNull();
    });
});

describe("slugify", () => {
    it("lowercases and hyphenates a title", () => {
        expect(slugify("Add a slug utility and tests")).toBe(
            "add-a-slug-utility-and-tests",
        );
    });

    it("returns an empty string when there is nothing usable", () => {
        expect(slugify("!!! ???")).toBe("");
    });

    it("caps the slug length", () => {
        expect(slugify("a".repeat(100))).toHaveLength(40);
    });
});

describe("deriveTaskId", () => {
    it("builds a stable issue-based task id", () => {
        expect(deriveTaskId(issue())).toBe(
            "issue-102-add-a-slug-utility-and-tests",
        );
    });

    it("falls back to the issue number when the title is empty", () => {
        expect(deriveTaskId(issue({ title: "🎉" }))).toBe("issue-102");
    });
});
