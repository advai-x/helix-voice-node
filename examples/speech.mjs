import { HelixVoiceClient } from "@advai-x/helix-voice";

const client = new HelixVoiceClient({ baseUrl: process.env.HELIXVOICE_BASE_URL });
const voices = await client.voices.list();
if (voices.length === 0) {
    throw new Error("No voices are available to this account.");
}

const voice = voices[0];
const generation = await client.speech.save({
    input: "Hello from Helix Voice.",
    voice: voice.id,
    output: "speech.wav",
});

console.log(`Saved speech.wav with voice ${voice.id} (generation ${generation.id})`);
