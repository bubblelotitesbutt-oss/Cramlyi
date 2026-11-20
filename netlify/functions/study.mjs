// Netlify function: keeps your Gemini key secret and calls Google, with retries.
const SPECS = {
  keynotes: "keynotes: array of 6-10 strings. Each is one complete, clear point (under 30 words).",
  vocab: "vocab: array of {term, definition} (short, clear definitions).",
  flashcards: "flashcards: array of 8-15 {front, back} cards.",
  mindmap: "mindmap: {center: string, branches: array of 3-6 {label, children: array of 2-3 short strings}}. Keep every label under 24 characters.",
  bullets: "bullets: array of {heading, points: array of 3-6 strings}. Group the material into a clean outline; each point is a complete, clear sentence under 30 words.",
};
const quizSpec = jamb =>
  "quiz: {objective: array of 10 multiple-choice {q, options: array of exactly 4 strings with NO letter prefixes, answer: index 0-3, why: short explanation}, " +
  "theory: array of 3-4 theory/essay questions {q, marks: number, answer: a full model answer in clear short lines}}. The theory part is REQUIRED." +
  (jamb ? " Objective questions must follow the JAMB UTME style: concise stems, four plausible options (A-D), one correct answer, testing understanding, application and calculations where relevant." : "");

const hits = new Map();
const LIMIT = 8, WINDOW = 60000;
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > LIMIT;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (limited(context.ip || "unknown")) return json({ error: "Too many requests" }, 429);

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const { text = "", pq = "", style = "jamb", modes = [], images = [], pqImages = [] } = body;
  const valid = m => m === "quiz" || SPECS[m];
  const picked = [...new Set(modes)].filter(valid).slice(0, 3);
  if (!picked.length) return json({ error: "Pick 1-3 study tools." }, 400);
  if (!text.trim() && !images.length) return json({ error: "No material provided." }, 400);

  let prompt =
    "You are a study assistant helping a student cram. Use ONLY the material below (text and any attached note images; read all text in the images). " +
    "Respond with ONLY a JSON object with exactly these keys:\n" +
    picked.map(k => "- " + (k === "quiz" ? quizSpec(style !== "standard") : SPECS[k])).join("\n") +
    "\n\nMATERIAL:\n" + (text.trim().slice(0, 30000) || "(see attached note images)");
  if (picked.includes("quiz") && (pq.trim() || pqImages.length)) {
    prompt += "\n\nPAST QUESTIONS (study their format, difficulty and wording style, then write NEW questions from the material; never copy them):\n" +
      (pq.trim().slice(0, 15000) || "(see the attached past question images, listed after the note images)");
  }

  const parts = [{ text: prompt }];
  for (const im of images.slice(0, 5)) parts.push({ inline_data: { mime_type: im.mime || "image/jpeg", data: im.data } });
  if (pqImages.length) parts.push({ text: "The following images are PAST QUESTIONS:" });
  for (const im of pqImages.slice(0, 3)) parts.push({ inline_data: { mime_type: im.mime || "image/jpeg", data: im.data } });

  const main = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const backup = process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-lite-latest";
  const attempts = [main, main, backup];
  const payload = JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json" } });

  for (let i = 0; i < attempts.length; i++) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${attempts[i]}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
          body: payload,
        }
      );
      if (r.status === 429) return json({ error: "Rate limit reached" }, 429);
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        return json({ error: "The AI key or request was rejected (" + r.status + ")." }, 502);
      }
      if (r.ok) {
        const data = await r.json();
        const out = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
        try { return json(JSON.parse(out.replace(/```json|```/g, "").trim())); } catch (e) {}
      }
    } catch (e) {}
    if (i < attempts.length - 1) await sleep(1200);
  }
  return json({ error: "Google's AI is busy right now. Please try again in a minute." }, 503);
};

export const config = { path: "/api/study" };
