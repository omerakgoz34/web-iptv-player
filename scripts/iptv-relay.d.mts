export function attachIptvRelay(middlewares: { use: (handler: (...args: never[]) => void) => void }): void;
export function relayRequest(request: Request): Promise<Response>;
