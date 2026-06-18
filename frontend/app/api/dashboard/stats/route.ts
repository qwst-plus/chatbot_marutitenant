// app/api/dashboard/stats/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const CLIENT_ID = process.env.NEXT_PUBLIC_CLIENT_ID ?? "default";

// GET /api/dashboard/stats?year=2026&month=3
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const now = new Date();
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()));
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1));

    const startDate = new Date(year, month - 1, 1).toISOString();
    const endDate = new Date(year, month, 1).toISOString();
    // 月別トレンドは選択月を含む過去6ヶ月
    const trendStartDate = new Date(year, month - 6, 1).toISOString();

    const [
      monthlyConvs,
      trendConvs,
      heatmap,
      topQuestions,
      topDocs,
      unusedDocs,
      keywords,
      categories,
      modeHistory,
    ] = await Promise.all([
      // 1. 選択月の会話（サマリー用）
      getSupabaseAdmin()
        .from("conversations")
        .select("id, escalated, resolved")
        .eq("client_id", CLIENT_ID)
        .gte("started_at", startDate)
        .lt("started_at", endDate),

      // 2. 月別対話件数推移（過去6ヶ月）
      getSupabaseAdmin()
        .from("conversations")
        .select("started_at")
        .eq("client_id", CLIENT_ID)
        .gte("started_at", trendStartDate)
        .lt("started_at", endDate)
        .order("started_at"),

      // 3. ヒートマップ（選択月のユーザーメッセージ）
      getSupabaseAdmin()
        .from("messages")
        .select("created_at")
        .eq("role", "user")
        .gte("created_at", startDate)
        .lt("created_at", endDate),

      // 4. よく聞かれた質問（選択月）
      getSupabaseAdmin()
        .from("messages")
        .select("content")
        .eq("role", "user")
        .gte("created_at", startDate)
        .lt("created_at", endDate),

      // 5. 参照ドキュメント（選択月）
      getSupabaseAdmin()
        .from("messages")
        .select("retrieved_doc_titles, retrieved_doc_sources, created_at")
        .eq("role", "assistant")
        .not("retrieved_doc_titles", "is", null)
        .gte("created_at", startDate)
        .lt("created_at", endDate),

      // 6. 未参照ドキュメント（全ドキュメント取得 → 選択月に参照されなかったものをフィルタ）
      getSupabaseAdmin()
        .from("documents")
        .select("id, title, url, source_url, updated_at"),

      // 7. 緊急ワード（選択月）
      getSupabaseAdmin()
        .from("messages")
        .select("keyword_matched, created_at")
        .not("keyword_matched", "is", null)
        .gte("created_at", startDate)
        .lt("created_at", endDate),

      // 8. カテゴリ分布（選択月）
      getSupabaseAdmin()
        .from("conversations")
        .select("category_id")
        .eq("client_id", CLIENT_ID)
        .gte("started_at", startDate)
        .lt("started_at", endDate),

      // 9. モード履歴（選択月の normal 以外の会話）
      getSupabaseAdmin()
        .from("conversations")
        .select("id, mode, started_at, ended_at")
        .eq("client_id", CLIENT_ID)
        .neq("mode", "normal")
        .gte("started_at", startDate)
        .lt("started_at", endDate)
        .order("started_at", { ascending: false }),
    ]);

    // ── サマリー集計 ──────────────────────────────────────────
    const convData = monthlyConvs.data ?? [];
    const totalCount = convData.length;
    const escalatedCount = convData.filter((r) => r.escalated).length;
    const resolvedCount = convData.filter((r) => r.resolved).length;
    const escalationRate = totalCount > 0 ? (escalatedCount / totalCount) * 100 : 0;
    const resolutionRate = totalCount > 0 ? (resolvedCount / totalCount) * 100 : 0;

    // ── 月別推移 ──────────────────────────────────────────────
    const monthlyMap: Record<string, number> = {};
    for (const row of trendConvs.data ?? []) {
      const m = row.started_at.slice(0, 7); // YYYY-MM
      monthlyMap[m] = (monthlyMap[m] ?? 0) + 1;
    }
    const monthlyTrend = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, count]) => ({ month: m, count }));

    // ── ヒートマップ ──────────────────────────────────────────
    const heatmapMap: Record<string, number> = {};
    for (const row of heatmap.data ?? []) {
      const d = new Date(row.created_at);
      const key = `${d.getDay()}-${d.getHours()}`;
      heatmapMap[key] = (heatmapMap[key] ?? 0) + 1;
    }
    const heatmapArray = Object.entries(heatmapMap).map(([key, count]) => {
      const [dow, hour] = key.split("-");
      return { day_of_week: Number(dow), hour: Number(hour), count };
    });

    // ── よく聞かれた質問 ──────────────────────────────────────
    const questionMap: Record<string, number> = {};
    for (const row of topQuestions.data ?? []) {
      questionMap[row.content] = (questionMap[row.content] ?? 0) + 1;
    }
    const topQuestionsRanking = Object.entries(questionMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([content, count]) => ({ content, count }));

    // ── 参照ドキュメント ──────────────────────────────────────
    const docMap: Record<string, { title: string; source_url: string; count: number; last: string }> = {};
    for (const row of topDocs.data ?? []) {
      const titles: string[] = row.retrieved_doc_titles ?? [];
      const sources: string[] = row.retrieved_doc_sources ?? [];
      titles.forEach((title, i) => {
        const src = sources[i] ?? "";
        const key = `${title}__${src}`;
        if (!docMap[key]) docMap[key] = { title, source_url: src, count: 0, last: row.created_at };
        docMap[key].count++;
        if (row.created_at > docMap[key].last) docMap[key].last = row.created_at;
      });
    }
    const topDocsRanking = Object.values(docMap)
      .sort((a, b) => b.count - a.count)
      .map(({ title, source_url, count, last }) => ({
        title,
        source_url,
        reference_count: count,
        last_referenced_at: last,
      }));

    // ── 未参照ドキュメント ────────────────────────────────────
    const referencedSources = new Set(
      (topDocs.data ?? []).flatMap((r) => r.retrieved_doc_sources ?? [])
    );
    const unusedDocList = (unusedDocs.data ?? []).filter((d) => {
      const docUrl = (d.url ?? d.source_url ?? "").trim();
      return docUrl && !referencedSources.has(docUrl);
    });

    // ── 緊急ワード集計 ＋ 日別推移 ───────────────────────────
    const keywordMap: Record<string, number> = {};
    const dailyMap: Record<string, number> = {};
    for (const row of keywords.data ?? []) {
      const kw = row.keyword_matched as string;
      keywordMap[kw] = (keywordMap[kw] ?? 0) + 1;
      const date = (row.created_at as string).slice(0, 10); // YYYY-MM-DD
      dailyMap[date] = (dailyMap[date] ?? 0) + 1;
    }
    const keywordStats = Object.entries(keywordMap)
      .sort(([, a], [, b]) => b - a)
      .map(([keyword, count]) => ({ keyword, count }));
    const dailyEmergencyTrend = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => {
        const d = new Date(date);
        return { date: `${d.getMonth() + 1}/${d.getDate()}`, count };
      });

    // ── カテゴリ分布 ──────────────────────────────────────────
    const catMap: Record<string, number> = {};
    for (const row of categories.data ?? []) {
      const cat = (row.category_id as string | null) ?? "未選択";
      catMap[cat] = (catMap[cat] ?? 0) + 1;
    }
    const categoryDist = Object.entries(catMap)
      .sort(([, a], [, b]) => b - a)
      .map(([category, count]) => ({
        category,
        count,
        percentage: totalCount > 0 ? (count / totalCount) * 100 : 0,
      }));

    // ── モード履歴 ────────────────────────────────────────────
    const modeHistoryData = (modeHistory.data ?? []).map((row) => ({
      mode: row.mode as string,
      started_at: row.started_at as string,
      ended_at: row.ended_at as string | null,
    }));

    return NextResponse.json({
      summary: {
        total_count: totalCount,
        escalated_count: escalatedCount,
        resolved_count: resolvedCount,
        escalation_rate: Math.round(escalationRate * 10) / 10,
        resolution_rate: Math.round(resolutionRate * 10) / 10,
      },
      monthly_trend: monthlyTrend,
      heatmap: heatmapArray,
      top_questions: topQuestionsRanking,
      top_docs: topDocsRanking,
      unused_docs: unusedDocList,
      keyword_stats: keywordStats,
      category_distribution: categoryDist,
      mode_history: modeHistoryData,
      daily_emergency_trend: dailyEmergencyTrend,
    });
  } catch (e: unknown) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message ?? String(e) }, { status: 500 });
  }
}
