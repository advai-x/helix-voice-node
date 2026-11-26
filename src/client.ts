import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
    Capabilities, CapabilitiesFromJSON, Generation, GenerationFromJSON, Transcription,
    TranscriptionFromJSON, Voice, VoiceFromJSON,
} from "./models";

export const HELIXVOICE_BASE_URL = "https://api.helixvoice.net";
const MAX_WAV = 16 * 1024 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;

export interface ClientOptions {
    baseUrl?: string;
    timeoutMs?: number;
}

export interface ServerClientOptions extends ClientOptions {
    apiKey?: string;
}

export interface SpeechInput {
    input: string;
    voice: string;
}

export interface CloneVoiceInput {
    file: string;
    name: string;
    language: "zh-CN" | "en-US";
    transcript: string;
    consent: boolean;
}

export interface TranscriptionInput {
    file: string;
    language?: "zh-CN" | "auto";
}

export class HelixVoiceError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string,
        readonly requestId?: string, readonly retryAfter?: string) {
        super(message);
        this.name = "HelixVoiceError";
    }
}

export class SpeechSaveError extends Error {
    readonly cause: unknown;

    constructor(readonly generation: Generation, cause: unknown) {
        super("Speech was generated but its WAV could not be saved");
        this.name = "SpeechSaveError";
        this.cause = cause;
    }
}

async function readBytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new RangeError("Response exceeds SDK size limit");
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, position);
        position += chunk.length;
    }
    return bytes;
}

class Transport {
    private readonly url: string;
    private readonly timeoutMs: number;

    constructor(options: ClientOptions, private readonly key: string) {
        const url = new URL(options.baseUrl ?? HELIXVOICE_BASE_URL);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new TypeError("baseUrl must be an HTTP(S) base URL");
        }
        this.url = url.href.replace(/\/+$/, "");
        this.timeoutMs = options.timeoutMs ?? 180_000;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
            throw new RangeError("timeoutMs must be a positive 32-bit integer");
        }
    }

    private async send(method: string, route: string, accept: string, body?: string | FormData) {
        const headers = new Headers({ Accept: accept, Authorization: "Bearer " + this.key });
        if (typeof body === "string") headers.set("Content-Type", "application/json");
        const response = await fetch(this.url + route, {
            method, headers, body, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) return response;

        let details: { message?: string; code?: string | number; requestId?: string; transactionId?: string } = {};
        if (this.contentType(response) === "application/json") {
            try {
                const data = JSON.parse(new TextDecoder().decode(await readBytes(response, 64 * 1024)));
                details = data?.error ?? data ?? {};
            } catch {
                // Keep the HTTP status and headers if the upstream JSON could not be read.
            }
        } else {
            await response.body?.cancel();
        }
        throw this.error(response, details.message || `Helix Voice returned HTTP ${response.status}`,
            details.code == null ? undefined : String(details.code), details.requestId || details.transactionId);
    }

    private error(response: Response, message: string, code?: string, requestId?: string) {
        return new HelixVoiceError(message, response.status, code,
            requestId || response.headers.get("X-Request-ID") || undefined,
            response.headers.get("Retry-After") ?? undefined);
    }

    private contentType(response: Response) {
        return response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
    }

    async json<T>(method: string, route: string, decode: (data: unknown) => T, body?: string | FormData): Promise<T> {
        const response = await this.send(method, route, "application/json", body);
        if (this.contentType(response) === "application/json") {
            try {
                const result = JSON.parse(new TextDecoder().decode(await readBytes(response, MAX_JSON)));
                if (result && typeof result === "object" && result.data != null) return decode(result.data);
            } catch {
                // Report the response status and request ID for invalid payloads.
            }
        } else {
            await response.body?.cancel();
        }
        throw this.error(response, "Unexpected Helix Voice JSON response");
    }

    async wav(route: string): Promise<Uint8Array> {
        const response = await this.send("GET", route, "audio/wav");
        if (this.contentType(response) !== "audio/wav") {
            await response.body?.cancel();
            throw this.error(response, "Expected a WAV response");
        }
        try {
            return await readBytes(response, MAX_WAV);
        } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            throw this.error(response, "WAV exceeds the SDK response size limit");
        }
    }

    async remove(route: string): Promise<void> {
        const response = await this.send("DELETE", route, "application/json");
        await response.body?.cancel();
        if (response.status !== 204) throw this.error(response, "Expected HTTP 204");
    }
}

function segment(id: string): string {
    if (!id || id === "." || id === "..") throw new TypeError("A resource ID is required");
    return encodeURIComponent(id);
}

async function upload(path: string, fields: Record<string, string>): Promise<FormData> {
    const source = await open(path, "r");
    try {
        const info = await source.stat();
        if (!info.isFile()) throw new TypeError("Upload must be a regular file");
        const { size } = info;
        if (size > MAX_UPLOAD) throw new RangeError("Upload exceeds 20 MiB");
        const bytes = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
            const { bytesRead } = await source.read(bytes, offset, size - offset, null);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset !== size || (await source.stat()).size !== size) {
            throw new Error("Upload changed while being read");
        }
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: "application/octet-stream" }), basename(path));
        for (const [name, value] of Object.entries(fields)) form.append(name, value);
        return form;
    } finally {
        await source.close();
    }
}

async function saveWav(path: string, audio: Uint8Array): Promise<void> {
    const temp = join(dirname(path), ".helixvoice-" + randomUUID());
    await writeFile(temp, audio, { flag: "wx", mode: 0o600 }).catch(async (error) => {
        if (error.code !== "EEXIST") await rm(temp, { force: true });
        throw error;
    });
    try {
        await rename(temp, path);
    } finally {
        await rm(temp, { force: true });
    }
}

function decodeList<T>(decode: (value: unknown) => T): (value: unknown) => T[] {
    return (value) => {
        if (!Array.isArray(value)) throw new TypeError("Expected an array");
        return value.map(decode);
    };
}

export class HelixVoiceClient {
    readonly capabilities: { get(): Promise<Capabilities> };
    readonly voices: {
        list(): Promise<Voice[]>;
        clone(options: CloneVoiceInput): Promise<Voice>;
        delete(id: string): Promise<void>;
    };
    readonly generations: {
        list(): Promise<Generation[]>;
        download(id: string): Promise<Uint8Array>;
        delete(id: string): Promise<void>;
    };
    readonly speech: {
        generate(options: SpeechInput): Promise<Generation>;
        save(options: SpeechInput & { output: string }): Promise<Generation>;
    };
    readonly transcriptions: { create(options: TranscriptionInput): Promise<Transcription> };

    constructor(options: ServerClientOptions = {}) {
        const key = (options.apiKey ?? process.env.HELIXVOICE_API_KEY ?? "").trim();
        if (!key) throw new TypeError("A Helix Voice API key is required");
        const http = new Transport(options, key);
        this.capabilities = { get: () => http.json("GET", "/v1/capabilities", CapabilitiesFromJSON) };
        this.voices = {
            list: () => http.json("GET", "/v1/voices", decodeList(VoiceFromJSON)),
            clone: async ({ file, name, language, transcript, consent }) => {
                if (consent !== true) throw new TypeError("Explicit consent is required to clone a voice");
                return http.json("POST", "/v1/voices", VoiceFromJSON,
                    await upload(file, { name, language, transcript, consent: "true" }));
            },
            delete: (id) => http.remove("/v1/voices/" + segment(id)),
        };
        this.generations = {
            list: () => http.json("GET", "/v1/generations", decodeList(GenerationFromJSON)),
            download: async (id) => http.wav("/v1/generations/" + segment(id) + "/audio"),
            delete: (id) => http.remove("/v1/generations/" + segment(id)),
        };
        const generate = ({ input, voice }: SpeechInput) =>
            http.json("POST", "/v1/audio/speech", GenerationFromJSON, JSON.stringify({ input, voice }));
        this.speech = {
            generate,
            save: async ({ output, ...options }) => {
                const generation = await generate(options);
                try {
                    const audio = await this.generations.download(generation.id);
                    await saveWav(output, audio);
                } catch (error) {
                    throw new SpeechSaveError(generation, error);
                }
                return generation;
            },
        };
        this.transcriptions = {
            create: async ({ file, language }) => http.json("POST", "/v1/audio/transcriptions", TranscriptionFromJSON,
                await upload(file, language === undefined ? {} : { language })),
        };
    }
}
