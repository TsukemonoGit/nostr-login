export interface Nip46Request {
    id: string;
    method: string;
    params: string[];
}

export interface Nip46Response {
    id: string;
    result?: string;
    error?: string;
}

export interface PendingRequest {
    resolve: (result: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    method: string;
}

export interface Nip46ClientOptions {
    localPrivateKey: string;
    remotePubkey: string;
    relays: string[];
    timeoutMs?: number;
    useNip44?: boolean;
}
