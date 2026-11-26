import { HelixVoiceClient } from "@advai-x/helix-voice";

const args = process.argv.slice(2);
if (args.length !== 5 || args[0] !== "--consent") {
    throw new Error("Usage: node clone-voice.mjs --consent <reference-audio> <name> <locale> <transcript>");
}

const [, file, name, language, transcript] = args;
const client = new HelixVoiceClient({ baseUrl: process.env.HELIXVOICE_BASE_URL });
const voice = await client.voices.clone({ file, name, language, transcript, consent: true });
console.log(voice.id);
