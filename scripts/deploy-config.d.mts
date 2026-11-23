export function stripJsonc(text: string): string;
export function deployConfig(text: string, overrideName?: string): { name: string; containers?: { name?: string }[] } & Record<string, unknown>;
