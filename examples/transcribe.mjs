import { HelixVoiceClient } from "@advai-x/helix-voice";

const args = process.argv.slice(2);
if (args.length !== 1) {
    throw new Error("Usage: node transcribe.mjs <audio-file>");
}

const client = new HelixVoiceClient({ baseUrl: process.env.HELIXVOICE_BASE_URL });
const result = await client.transcriptions.create({ file: args[0], language: "zh-CN" });
console.log(result.text);
