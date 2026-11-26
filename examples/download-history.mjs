import { writeFile } from "node:fs/promises";
import { HelixVoiceClient } from "@advai-x/helix-voice";

const args = process.argv.slice(2);
if (args.length > 1) {
    throw new Error("Usage: node download-history.mjs [generation-id]");
}

const client = new HelixVoiceClient({ baseUrl: process.env.HELIXVOICE_BASE_URL });
if (args.length === 0) {
    for (const generation of await client.generations.list()) {
        console.log(generation.id);
    }
} else {
    const audio = await client.generations.download(args[0]);
    await writeFile("history.wav", audio);
    console.log("Saved history.wav");
}
