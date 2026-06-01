// app/api/chat/route.ts
// 埋め込み: OpenAI text-embedding-3-small
// 回答生成: Claude claude-sonnet-4-6
// 対象: asahikawa-gas.co.jp（クライアント設定ファイルで切替可）

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import {
  startConversation,
  logUserMessage,
  logAssistantMessage,
  escalateConversation,
} from "@/lib/log";
import { getClientConfig } from "@/lib/getClientConfig";
import type { ConversationMode, ClientConfig, ChatRequest, ChatResponse } from "@/types/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function mustEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`${name} is missing`);
  return v;
}

type ClientMsg = { role: "user" | "assistant"; content: string };

// リクエストボディ（後方互換のため既存フィールドも残す）
type ChatBody = Partial<ChatRequest> & {
  question?: string;
  message?: string;
  top_k?: number;
  messages?: ClientMsg[];
};

// ---- OpenAI（埋め込みのみ）----
const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });

// ---- Anthropic（回答生成）----
const anthropic = new Anthropic({ apiKey: mustEnv("ANTHROPIC_API_KEY") });

// ---- Supabase（ベクター検索）----
const SUPABASE_URL = env("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL") ?? "";
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is missing");

const SUPABASE_KEY =
  env("SUPABASE_SERVER_KEY") ??
  env("SUPABASE_SERVICE_ROLE_KEY") ??
  env("SUPABASE_ANON_KEY") ??
  env("NEXT_PUBLIC_SUPABASE_ANON_KEY") ??
  "";
if (!SUPABASE_KEY) throw new Error("SUPABASE key is missing");

console.log("[debug] SUPABASE_URL:", SUPABASE_URL);
console.log("[debug] SUPABASE_KEY prefix:", SUPABASE_KEY.slice(0, 30));

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const RPC_NAME = env("SUPABASE_MATCH_RPC") ?? "match_documents";
const MATCH_THRESHOLD = Number(env("SUPABASE_MATCH_THRESHOLD") ?? "0");

// ============================================================
// RAGコア（埋め込み・検索）
// ============================================================

async function embedQuery(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding as unknown as number[];
}

type Retrieved = {
  id: string;
  text: string;
  source: string;
  title: string;
  similarity: number;
};

// モードに応じてcategoryフィルタを切り替えてベクター検索
async function searchSupabase(
  query: string,
  topK: number,
  mode: ConversationMode
): Promise<Retrieved[]> {
  const qEmb = await embedQuery(query);

  const args: Record<string, unknown> = {
    query_embedding: qEmb,
    match_count: topK,
  };
  if (MATCH_THRESHOLD > 0) args.match_threshold = MATCH_THRESHOLD;

  // emergencyモードは緊急カテゴリのドキュメントのみ検索
  if (mode === "emergency") {
    args.filter_category = "emergency";
  }

  const { data, error } = await supabase.rpc(RPC_NAME, args);
  if (error) throw new Error(`supabase.rpc(${RPC_NAME}) failed: ${error.message}`);

  const rows = (data ?? []) as Record<string, unknown>[];
  return rows
    .map((row) => {
      const text = String(
        row.content ?? row.text ?? row.chunk ?? row.body ?? ""
      ).trim();
      const source = String(
        row.source ?? row.url ?? row.source_url ?? row.path ?? ""
      ).trim();
      const title = String(row.title ?? source).trim();
      const id = String(row.id ?? "");
      const similarity = Number(row.similarity ?? row.score ?? 0);
      return { id, text, source, title, similarity };
    })
    .filter((r) => r.text.length > 0);
}

function lastUserFromHistory(body: ChatBody): string {
  const direct = String(body.message ?? body.question ?? "").trim();
  if (direct) return direct;
  if (Array.isArray(body.messages) && body.messages.length) {
    const lastUser = [...body.messages].reverse().find((m) => m?.role === "user");
    return String(lastUser?.content ?? "").trim();
  }
  return "";
}

function normalizeHistory(body: ChatBody, maxTurns = 60): ClientMsg[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  return raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 4000) }))
    .filter((m) => m.content.trim().length > 0)
    .slice(-maxTurns);
}

// ============================================================
// システムプロンプト生成（クライアント設定・モード対応）
// ============================================================

function buildSystemPrompt(
  categoryId: string | null,
  mode: ConversationMode,
  config: ClientConfig
): string {
  const base = `あなたは${config.clientId}のカスタマーサポートAIです。
提供された資料をもとに回答してください。
資料に根拠がない場合は「お電話でご確認ください」と案内してください。
回答の末尾には「この回答は解決の参考になりましたか？」を記載してください。
お電話での案内が必要な場合：${config.phoneNumbers.normal}（${config.businessHours}）

【回答形式の注意】
- マークダウン記法（##、**、---、|テーブル|など）は使わないでください
- 絵文字は使わないでください
- 箇条書きは「・」を使ってください
- 自然な日本語の文章で回答してください`;

  const categoryContext = categoryId
    ? `\nこのユーザーは「${categoryId}」に関心があります。`
    : "";

  const emergencyContext =
    mode === "emergency"
      ? `\n\n【緊急事態対応モード】
現在、緊急事態が発生している可能性があります。
避難・安全確保に関する情報を最優先で案内してください。
緊急連絡先：${config.phoneNumbers.emergency}（24時間対応）`
      : mode === "notice"
      ? `\n\n【注意報モード】
現在、注意報が発令されています。
通常の案内に加え、安全に関する情報も合わせて案内してください。`
      : "";

  return base + categoryContext + emergencyContext;
}

// ============================================================
// Claude向けメッセージ構築
// ============================================================

function buildClaudeMessages(opts: {
  question: string;
  history: ClientMsg[];
  contexts: { text: string; source: string }[];
}): Array<{ role: "user" | "assistant"; content: string }> {
  const { question, history, contexts } = opts;

  const ctx = contexts
    .map((c) => `source: ${c.source}\n${c.text}`.trim())
    .join("\n\n");

  const finalUser = `# 資料
${ctx || "(資料なし)"}

# 今回の質問
${question}

# 回答（日本語）
`;

  return [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: finalUser },
  ];
}

// ============================================================
// POST /api/chat
// ============================================================
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChatBody;

    const q = lastUserFromHistory(body);
    if (!q) {
      return NextResponse.json(
        { error: "message (or question) is required" },
        { status: 400 }
      );
    }

    const topK = Math.max(1, Math.min(Number(body.top_k ?? 20), 60));
    const clientId = body.client_id ?? env("NEXT_PUBLIC_CLIENT_ID") ?? "asahikawa-gas";
    const mode: ConversationMode = body.mode ?? "normal";
    const sessionId = body.session_id ?? crypto.randomUUID();

    // ── クライアント設定取得 ──────────────────────────────────
    const config = await getClientConfig(clientId);

    // ── 1) RAG検索（モードによってカテゴリフィルタを切替）────
    const retrieved = await searchSupabase(q, topK, mode);

    // ── 2) 会話履歴 ──────────────────────────────────────────
    const history = normalizeHistory(body, 60);

    // ── 3) エスカレーション判定（クライアント設定のキーワード使用）──
    const matchedKeyword =
      config.emergencyKeywords.find((kw) => q.includes(kw)) ?? null;
    const confidenceScore = retrieved.length > 0 ? retrieved[0].similarity : 0;
    const isLowConfidence = confidenceScore < 0.5 && retrieved.length > 0;

    // ── カテゴリ自動判定 ──────────────────────────────────────
    // 緊急キーワードにマッチ → キーワード名をそのままカテゴリに（例: "ガス漏れ"）
    // それ以外 → topicKeywords でトピック分類（例: "料金・請求"）
    // どれにも該当しない → "その他"
    let autoCategory: string;
    if (matchedKeyword) {
      autoCategory = matchedKeyword;
    } else {
      const matchedTopic = config.topicKeywords.find((t) =>
        t.keywords.some((kw) => q.includes(kw))
      );
      autoCategory = matchedTopic?.label ?? "その他";
    }
    const categoryId = body.category_id ?? autoCategory;

    // ── 4) システムプロンプト生成 ─────────────────────────────
    const systemPrompt = buildSystemPrompt(categoryId, mode, config);

    // ── 5) 回答生成（Claude・プロンプトキャッシュ対応）──────
    const claudeMessages = buildClaudeMessages({
      question: q,
      history,
      contexts: retrieved.map((r) => ({ text: r.text, source: r.source })),
    });

    const startMs = Date.now();
    const chat = await anthropic.messages.create({
      model: env("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6",
      max_tokens: 2048,
      // システムプロンプトをキャッシュ（5分TTL）
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: claudeMessages,
    });
    const responseMs = Date.now() - startMs;

    const rawAnswer =
      chat.content[0]?.type === "text" ? chat.content[0].text : "";
    const answer = rawAnswer.replace(/\[#\d+\]/g, "").replace(/\s{2,}/g, " ").trim();

    // ── 6) ログ書き込み ───────────────────────────────────────
    let conversationId = body.conversation_id ?? null;
    let messageId = "";

    try {
      if (!conversationId) {
        conversationId = await startConversation({
          sessionId,
          clientId,
          categoryId,
          mode,
        });
      }

      await logUserMessage({ conversationId, content: q });

      if (matchedKeyword) {
        await escalateConversation({ conversationId, escalateType: "keyword" });
      } else if (isLowConfidence) {
        await escalateConversation({
          conversationId,
          escalateType: "low_confidence",
        });
      }

      messageId = await logAssistantMessage({
        conversationId,
        content: answer,
        confidenceScore,
        keywordMatched: matchedKeyword,
        retrievedDocIds: retrieved.map((r) => r.id).filter(Boolean),
        retrievedDocTitles: retrieved.map((r) => r.title),
        retrievedDocSources: retrieved.map((r) => r.source),
        responseMs,
        unresolved: isLowConfidence && !matchedKeyword,
      });
    } catch (logErr) {
      console.error("[log] failed:", logErr);
    }

    // ── 7) レスポンス ─────────────────────────────────────────
    const response: ChatResponse = {
      message_id: messageId,
      conversation_id: conversationId ?? "",
      answer,
      confidence_score: confidenceScore,
      retrieved_docs: retrieved.map((r) => ({
        id: r.id,
        title: r.title,
        source: r.source,
      })),
      escalated: !!(matchedKeyword || isLowConfidence),
      keyword_matched: matchedKeyword,
      response_ms: responseMs,
    };

    return NextResponse.json({
      ...response,
      // デバッグ用メタ情報
      meta: {
        top_k: topK,
        rpc: RPC_NAME,
        hits: retrieved.length,
        mode,
        client_id: clientId,
        model: env("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6",
        cache_tokens: chat.usage.cache_read_input_tokens ?? 0,
      },
    });
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    const msg = `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
