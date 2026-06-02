import { fetch as expoFetch } from 'expo/fetch';
import Constants from 'expo-constants';
import { getToken, refreshAccessToken } from './auth';

// Standalone mobile assistant: the phone is its own thin agent runtime, calling
// the same Cloud MAX endpoint the desktop uses (/v1/chat/max) DIRECTLY. No
// desktop, no relay, no crypto. Mirrors core/agent_loop.py's request shape.
//
// v1a is "ask + search": we send `use_grounding` and NO `tools[]`. With no
// function declarations the model cannot emit a functionCall (Gemini requires
// declarations), so it can only stream text + Google Search grounding sources.
// That sidesteps the whole "phone can't run desktop tools" problem entirely.
// Billing is server-side, per-user, on the JWT (same as desktop) — this is
// also a Nepheline (云晶) consumption surface by design.

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-aura';
const APP_VERSION = (Constants.expoConfig?.version as string | undefined) ?? '0.0.0';

export interface Source { uri: string; title: string; }

export interface ChatTurn { role: 'user' | 'assistant'; content: string; }

export interface AgentCallbacks {
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  onSources: (sources: Source[]) => void;        // de-duped new sources only
  onStamina: (cost: number, totalRemaining: number | null) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

// Server appends these HTML-comment markers to streamed text (sources/images/
// undo/progress); the desktop strips them for display. We do the same on render
// — exported so the UI can clean accumulated text.
export function stripMarkers(text: string): string {
  if (!text) return '';
  const stops = ['<!--SOURCES:', '<!--IMAGES:', '<!--UNDO:', '<!--PROGRESS:']
    .map((m) => text.indexOf(m))
    .filter((i) => i !== -1);
  if (stops.length === 0) return text;
  return text.slice(0, Math.min(...stops)).replace(/\s+$/, '');
}

/**
 * Stream one assistant turn from /v1/chat/max. `history` is the full
 * conversation (user/assistant turns); the latest user message is last.
 * Callbacks fire incrementally; resolves when the stream ends.
 */
export async function streamAssistant(
  history: ChatTurn[],
  max: boolean,
  signal: AbortSignal,
  cb: AgentCallbacks,
): Promise<void> {
  let token = await getToken();
  if (!token) { cb.onError('未登录'); return; }

  const messages = history.map((t) => ({ role: t.role, content: t.content }));

  // MAX → /v1/chat/max: server_orchestrate (skills) + server-side tool loop;
  //   no token streaming (consume→reconstruct), client typewriter smooths it.
  // Default → /v1/chat/completions: TRUE pass-through token streaming + grounding,
  //   billed cheaper ("chat"). Same Gemini SSE shape, so the parser below is shared.
  const endpoint = max ? '/v1/chat/max' : '/v1/chat/completions';
  const body = JSON.stringify(
    max
      ? { messages, server_orchestrate: true, use_grounding: true, max_output_tokens: 8192, thinking_budget: 2048 }
      : { messages, use_grounding: true },
  );

  const doFetch = (tok: string) =>
    expoFetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
        'X-Client-Type': CLIENT_TYPE,
        'X-App-Version': APP_VERSION,
      },
      body,
      signal,
    });

  try {
    let res = await doFetch(token);

    // 401 → refresh once, retry. Mirrors agent_loop's token-refresh path.
    if (res.status === 401) {
      const ok = await refreshAccessToken();
      const fresh = ok ? await getToken() : null;
      if (!fresh) { cb.onError('登录已过期，请重新登录'); return; }
      token = fresh;
      res = await doFetch(token);
    }
    if (!res.ok) { cb.onError(`请求失败 (${res.status})`); return; }

    // Stamina/credits live in response headers, not the stream.
    const cost = parseInt(res.headers.get('X-Stamina-Cost') || '0', 10);
    const remainRaw = res.headers.get('X-Total-Remaining') ?? res.headers.get('X-Stamina-Remaining');
    if (cost > 0 || remainRaw != null) {
      cb.onStamina(cost, remainRaw != null ? parseInt(remainRaw, 10) : null);
    }

    const reader = res.body?.getReader();
    if (!reader) { cb.onError('无响应流'); return; }
    const decoder = new TextDecoder();
    let buffer = '';
    const seen: Record<string, boolean> = {};

    // Gemini-style SSE: each `data: {json}` line carries candidates[0].content
    // .parts[] (text / {thought:true,text} for CoT) + optional groundingMetadata;
    // terminated by `data: [DONE]`.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }

        const cand = json.candidates?.[0];
        for (const p of cand?.content?.parts ?? []) {
          if (p.thought && p.text) cb.onThinking(p.text);
          else if (typeof p.text === 'string') cb.onText(p.text);
        }

        const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
        const fresh: Source[] = [];
        for (const c of chunks) {
          const uri = c.web?.uri;
          if (uri && !seen[uri]) { seen[uri] = true; fresh.push({ uri, title: c.web?.title || uri }); }
        }
        if (fresh.length) cb.onSources(fresh);
      }
    }
    cb.onDone();
  } catch (e: any) {
    if (e?.name === 'AbortError') { cb.onDone(); return; }
    cb.onError('网络错误，请重试');
  }
}
