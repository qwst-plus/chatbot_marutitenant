"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

type Msg = { role: "user" | "assistant"; content: string };

type Props = {
  /** 最初から開いた状態にしたい場合 true（iframe内で常時表示など） */
  defaultOpen?: boolean;
  /** タイトル表示 */
  title?: string;
};

export default function ChatWidget({
  defaultOpen = false,
  title = "チャットサポート",
}: Props) {
  // ===== Theme（ロボット色味に合わせた）=====
  const THEME = {
    // ロボット外枠系のシアン（少しだけ幅を持たせる）
    brand1: "#2EC5F4",
    brand2: "#38BDF8",
    // ロボットの顔面（濃いネイビー）
    ink: "#1F2933",
    // 背景
    bg: "#FFFFFF",
    // 罫線
    line: "rgba(0,0,0,0.10)",
    // 影
    shadow: "0 18px 40px rgba(0,0,0,0.22)",
    // ユーザー吹き出し背景（ブランド）
    userGrad: "linear-gradient(135deg, #2EC5F4, #38BDF8)",
    // Bot吹き出し背景（薄いブランド）
    botBg: "rgba(46,197,244,0.08)",
    // Bot吹き出し枠
    botBorder: "rgba(46,197,244,0.25)",
  } as const;

  const [open, setOpen] = useState(defaultOpen);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // open時/更新時に最下部へ
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, messages, thinking]);

  const send = async () => {
    const q = input.trim();
    if (!q || thinking) return;

    setInput("");
    setMessages((m) => [...m, { role: "user", content: q }]);
    setThinking(true);

    try {
      // 既存のAPIルートに合わせる（あなたのプロジェクトが /api/embed で動いている前提）
      const res = await fetch("/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API error: ${res.status}\n${text}`);
      }

      const data: any = await res.json().catch(() => ({}));

      // 応答フィールドがどれでも拾えるようにする
      const answer =
        data?.answer ??
        data?.message ??
        data?.text ??
        data?.result ??
        "（応答形式を確認できませんでした）";

      setMessages((m) => [
        ...m,
        { role: "assistant", content: String(answer) },
      ]);
    } catch (e: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `エラー：${e?.message ?? e}` },
      ]);
    } finally {
      setThinking(false);
    }
  };

  // ===== 共通スタイル（必要に応じて調整）=====
  const Z = 999999;

  const widgetBox: React.CSSProperties = {
    position: "fixed",
    right: 16,
    bottom: 16,
    width: 360,
    height: 520,
    maxWidth: "calc(100vw - 32px)",
    maxHeight: "calc(100vh - 32px)",
    borderRadius: 18,
    border: `1px solid ${THEME.line}`,
    background: THEME.bg,
    boxShadow: THEME.shadow,
    overflow: "hidden",
    zIndex: Z,
    display: "flex",
    flexDirection: "column",
  };

  const header: React.CSSProperties = {
    height: 54,
    padding: "0 12px",
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
    color: "#fff",
    background: `linear-gradient(135deg, ${THEME.brand1}, ${THEME.brand2})`,
    borderBottom: `1px solid rgba(255,255,255,0.25)`,
  };

  const headerTitle: React.CSSProperties = {
    fontWeight: 800,
    fontSize: 14,
    letterSpacing: "0.02em",
    textShadow: "0 1px 0 rgba(0,0,0,0.10)",
  };

  const headerBtn: React.CSSProperties = {
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.55)",
    background: "rgba(255,255,255,0.14)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 700,
  };

  const body: React.CSSProperties = {
    flex: 1,
    padding: 12,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    // うっすら背景
    background:
      "radial-gradient(1000px 400px at 100% 0%, rgba(46,197,244,0.12), transparent 60%), #fff",
  };

  const inputBar: React.CSSProperties = {
    padding: 10,
    borderTop: `1px solid ${THEME.line}`,
    display: "flex",
    gap: 8,
    flexShrink: 0,
    background: "#fff",
  };

  const inputStyle: React.CSSProperties = {
    flex: 1,
    height: 40,
    padding: "0 12px",
    borderRadius: 14,
    border: `1px solid rgba(46,197,244,0.40)`,
    outline: "none",
    fontSize: 14,
    color: THEME.ink,
    boxShadow: "inset 0 1px 0 rgba(0,0,0,0.03)",
  };

  const sendBtn = (disabled: boolean): React.CSSProperties => ({
    height: 40,
    padding: "0 14px",
    borderRadius: 14,
    border: "0",
    background: disabled
      ? "rgba(46,197,244,0.45)"
      : `linear-gradient(135deg, ${THEME.brand1}, ${THEME.brand2})`,
    color: "#fff",
    fontWeight: 800,
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: disabled ? "none" : "0 10px 22px rgba(46,197,244,0.35)",
  });

  const bubbleBase: React.CSSProperties = {
    maxWidth: "88%",
    padding: "10px 12px",
    borderRadius: 16,
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  const userBubble: React.CSSProperties = {
    ...bubbleBase,
    alignSelf: "flex-end",
    color: "#fff",
    background: THEME.userGrad,
    boxShadow: "0 10px 22px rgba(46,197,244,0.25)",
  };

  const botBubble: React.CSSProperties = {
    ...bubbleBase,
    alignSelf: "flex-start",
    color: THEME.ink,
    background: THEME.botBg,
    border: `1px solid ${THEME.botBorder}`,
  };

  // =========================
  // ロボットボタン（閉じている状態）
  // 「白背景＋水色の円枠＋中央に画像」デザイン
  // =========================
  const fabBtn: React.CSSProperties = {
    position: "fixed",
    right: 16,
    bottom: 16,
    width: 56,
    height: 56,
    borderRadius: "50%",
    background: "#ffffff",
    border: `3px solid ${THEME.brand1}`,
    boxShadow: "0 12px 30px rgba(46,197,244,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    zIndex: Z,
    padding: 0,
  };

  // 画像の「■感」を減らすための保険（角を丸く＋収まりを良くする）
  // ※ 元画像が白背景JPEGでも「円枠＋白背景」に吸収されるので、見た目は整います
  const fabImgWrap: React.CSSProperties = {
    width: 30,
    height: 30,
    borderRadius: 9999,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  return (
    <>
      {/* 右下のロボットボタン */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="チャットを開く"
          style={fabBtn}
          onMouseEnter={(e) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.style.transform = "translateY(-1px)";
            btn.style.boxShadow = "0 14px 34px rgba(46,197,244,0.40)";
            btn.style.transition = "all 120ms ease";
          }}
          onMouseLeave={(e) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.style.transform = "translateY(0)";
            btn.style.boxShadow = "0 12px 30px rgba(46,197,244,0.35)";
          }}
        >
          <span style={fabImgWrap}>
            <Image
              src="/chatbot_icon2.jpg"
              alt="robot"
              width={30}
              height={30}
              priority
              style={{ objectFit: "contain" }}
            />
          </span>
        </button>
      )}

      {/* チャットパネル */}
      {open && (
        <div style={widgetBox}>
          {/* ヘッダー */}
          <div style={header}>
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "rgba(255,255,255,0.18)",
                border: "1px solid rgba(255,255,255,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}
            >
              <Image
                src="/chatbot_icon2.jpg"
                alt="robot"
                width={26}
                height={26}
                priority
                style={{ objectFit: "cover" }}
              />
            </span>

            <div style={headerTitle}>{title}</div>

            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setMessages([])}
                style={headerBtn}
                title="会話をリセット"
              >
                リセット
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={headerBtn}
                title="閉じる"
              >
                閉じる
              </button>
            </div>
          </div>

          {/* メッセージ */}
          <div ref={listRef} style={body}>
            {messages.length === 0 && (
              <div
                style={{
                  fontSize: 13,
                  color: THEME.ink,
                  opacity: 0.75,
                  border: `1px dashed rgba(46,197,244,0.35)`,
                  background: "rgba(46,197,244,0.06)",
                  borderRadius: 14,
                  padding: 10,
                }}
              >
                こんにちは！何でも聞いてください。
              </div>
            )}

            {messages.map((m, i) => {
              const isUser = m.role === "user";
              return (
                <div key={i} style={isUser ? userBubble : botBubble}>
                  {m.content}
                </div>
              );
            })}

            {thinking && (
              <div
                style={{
                  ...botBubble,
                  opacity: 0.75,
                }}
              >
                返信中…
              </div>
            )}
          </div>

          {/* 入力 */}
          <div style={inputBar}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
              placeholder="メッセージを入力…"
              style={inputStyle}
            />
            <button
              type="button"
              onClick={send}
              disabled={thinking || !input.trim()}
              style={sendBtn(thinking || !input.trim())}
            >
              送信
            </button>
          </div>
        </div>
      )}
    </>
  );
}
