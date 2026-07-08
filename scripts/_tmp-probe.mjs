import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const candidates = [
  "meta/llama-3.1-8b-instruct",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-70b-instruct",
  "google/gemma-2-9b-it",
  "microsoft/phi-3-mini-4k-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "mistralai/mixtral-8x7b-instruct-v0.1",
  "nv-mistralai/mistral-nemo-12b-instruct",
];

for (const model of candidates) {
  try {
    const res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body: JSON.stringify({ model, messages: [{role:"user",content:"say OK"}], max_tokens: 10, stream: false }),
    });
    const text = await res.text();
    console.log(`${model}: status=${res.status} ${text.slice(0, 120).replace(/\n/g," ")}`);
  } catch (err) {
    console.log(`${model}: ERROR ${err.message}`);
  }
}
