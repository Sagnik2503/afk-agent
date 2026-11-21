export type ColorEnv = {
    isTTY: boolean;
    env: NodeJS.ProcessEnv;
};

export type Colors = {
    bold: (text: string) => string;
    dim: (text: string) => string;
    red: (text: string) => string;
    green: (text: string) => string;
    yellow: (text: string) => string;
    cyan: (text: string) => string;
};

const CODES = {
    bold: 1,
    dim: 2,
    red: 31,
    green: 32,
    yellow: 33,
    cyan: 36,
} as const;

type ColorName = keyof typeof CODES;

export function createColors({ isTTY, env }: ColorEnv): Colors {
    const enabled = isTTY && env["NO_COLOR"] === undefined;
    const wrap =
        (name: ColorName) =>
        (text: string): string =>
            enabled ? `\u001b[${CODES[name]}m${text}\u001b[0m` : text;

    return {
        bold: wrap("bold"),
        dim: wrap("dim"),
        red: wrap("red"),
        green: wrap("green"),
        yellow: wrap("yellow"),
        cyan: wrap("cyan"),
    };
}
