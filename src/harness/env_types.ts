export type EnvironmentType =
    | "node"
    | "python"
    | "node-python"
    | "unknown";

export type DetectedEnvironment = {
    type: EnvironmentType;
    node: boolean;
    python: boolean;
};