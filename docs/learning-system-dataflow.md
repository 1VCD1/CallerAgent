# CallerAgent 學習系統資料流

> AI 如何從每一次通話中學習。
> 本質：**結構化記憶 + RAG 式 prompt 注入**，模型權重不變，變的是餵給模型的脈絡。

## 資料流圖

```
╔══════════════════════════════════════════════════════════════════════════╗
║                          通話進行中 (LIVE CALL)                            ║
╚══════════════════════════════════════════════════════════════════════════╝

   IVR 說話 ──► Deepgram STT ──► CallStateMachine / call-orchestrator
                                          │
                                          ▼
                              ┌───────────────────────┐
                              │   decideLLMAction()    │  gpt-4o-mini
                              │     (llm-engine.ts)    │◄──┐
                              └───────────┬───────────┘   │  注入記憶 (見下方消費端)
                                          │               │
                          ┌───────────────┼───────────────┘
                          │ persistAction()  (dryRun=false 時才寫)
                          ▼
                ┌──────────────────┐      ┌──────────────────────┐
                │  action_history  │      │   call_debug_logs    │
                │ (每個成功動作)    │      │ (每個 llm_decision)   │
                └────────┬─────────┘      └──────────┬───────────┘
                         │                           │
                         │     ※ 即時 warning(loop/stuck) 只在記憶體，不持久化
                         │                           │
═════════════════════════╪═══════════════════════════╪══════════════════════
        通話結束 webhook 觸發 (webhooks.ts:93-114) — 背景並行，僅真實通話
═════════════════════════╪═══════════════════════════╪══════════════════════
                         │                           │
         ┌───────────────┴──────┐         ┌──────────┴───────────┐
         ▼                      ▼         ▼                      ▼
┌─────────────────┐   ┌──────────────────────┐      ┌──────────────────────┐
│ recordCallOutcome│   │ recordIvrDecisionNodes│      │  generateCallSummary  │
│  (memory.ts)    │   │     (memory.ts)       │      │  (call-summarizer.ts) │
│                 │   │                       │      │      gpt-4o-mini       │
│ 串成功動作為路徑 │   │ 逐句: IVR→動作→成敗    │      │ 逐字稿+失敗分析→筆記   │
│ 增量平均成功率   │   │ DTMF指紋 / Jaccard比對 │      │ 舊筆記則 consolidate   │
└────────┬────────┘   └───────────┬──────────┘      └───────────┬──────────┘
         ▼                        ▼                              ▼
┌─────────────────┐   ┌──────────────────────┐      ┌──────────────────────┐
│ memory_patterns │   │  ivr_decision_nodes  │      │   company_ivr_notes   │
│                 │   │                      │      │                       │
│ key: phone+goal │   │ key: phone+ivr_text  │      │ key: company          │
│      +path      │   │      +action+value   │      │ (自然語言文字筆記)     │
│ +strategy_embed │   │ calls_success/total  │      │                       │
└─────────────────┘   └──────────────────────┘      └──────────────────────┘
   第1層: 整段路徑         第2層: 逐句決策              第3層: LLM 文字筆記
                                                              ▲
                                                              │ 使用者標記誤判
                                                    ┌─────────┴──────────┐
                                                    │generateFeedback-   │
                                                    │ Correction()       │
                                                    │ "⚠️ 其實是 bot"     │
                                                    └────────────────────┘

         ┌──────────────────────┐
         │  user_company_notes  │  ◄── 第4層: 使用者手寫提示 (calls.ts，純人工)
         └──────────────────────┘


╔══════════════════════════════════════════════════════════════════════════╗
║              下一通開始 — 消費端 (buildContextMessage, llm-engine.ts)       ║
╚══════════════════════════════════════════════════════════════════════════╝

   memory_patterns ──────────► 📜 HISTORICAL SUCCESSFUL PATHS (top 3 by strategy_score)
                               strategy_score = laplace(success)/(1+wait/120)
                               laplace = (success+1)/(total+2)  ← 壓制小樣本假高分
                               公式集中在 STRATEGY_SCORE_SQL 常數 (memory.ts)

   ivr_decision_nodes ───────► 📊 IVR DECISION TREE
                               ✅/⚠️/❌ 成功率, <30%&樣本≥3 標 AVOID

   company_ivr_notes ────────► 📋 PRIOR CALL NOTES

   user_company_notes ───────► 💬 USER TIP
                                          │
                                          ▼
                               全部組進 gpt-4o-mini system/user prompt
                               （非 fine-tuning，是結構化記憶 + RAG 注入）
```

## 四個學習資料層

| 層 | 資料表 | 寫入函式 | Key | 內容 |
|---|---|---|---|---|
| 1 | `memory_patterns` | `recordCallOutcome` (memory.ts) | phone_number + goal + path | 整段成功路徑、增量平均成功率、avg_wait、strategy_embedding |
| 2 | `ivr_decision_nodes` | `recordIvrDecisionNodes` (memory.ts) | phone_number + ivr_text + action + value | 逐句「這句 IVR 該按什麼」、calls_success/total、`recent_outcomes`（近 20 筆 {t,s} 滾動紀錄，用於 7 天翻案） |
| 3 | `company_ivr_notes` | `generateCallSummary` / `generateFeedbackCorrection` (call-summarizer.ts) | company | LLM 生成的自然語言筆記、誤判修正 |
| 4 | `user_company_notes` | calls.ts (純人工) | user + company | 使用者手寫提示 |

## 三個關鍵點

| 點 | 說明 |
|---|---|
| 🔒 **dryRun 閘門** | 模擬測試 `dryRun=true` → 不執行 `persistAction`，也不呼叫任何 record/summary → 學習表永不被假資料污染 |
| 🔑 **key 用 phone_number** | 第 1、2 層都以電話號碼為主 key（同公司不同號碼 = 不同 IVR 樹），第 3 層才退回 company |
| ⚡ **即時 ≠ 學習** | 通話中的 loop/stuck warning 只活在記憶體裡導引當下決策，**不會**進任何學習表 |
| ✅ **單一成功定義** | `isNavigationSuccess()` = `human_reached \|\| callback_number_given`。L1、L2、live agent、dashboard North Star 全部共用，永不互相矛盾。`callback_offered`（暫態未細分）不算成功 |
| 🌳 **中性閘門 (L1+L2)** | `outside_hours`/`busy`/`dial_failed`（環境因素）+ `callback_caller_id`（回撥打到 Twilio 號碼、到不了使用者；導航其實成功，只是投遞失敗）→ 兩層都**跳過不記**，不算成功也不算失敗（避免放假/非營業/投遞問題把好節點誤判 AVOID） |
| 🧪 **AVOID 翻案** | 節點全時段 <30% 且 ≥3 樣本 = AVOID，但有兩條翻案路：① 近 7 天滾動成功率 ≥50%（≥2 樣本）= ↻ RECOVERED；② 2% ε 隨機 RE-TEST。偵測 IVR 改版後的靜默復活 |

## 觸發時機

- **寫入**：Twilio call status webhook 收到通話結束時（`webhooks.ts:93-114`），背景並行觸發三個學習函式。
- **消費**：下一通開始時，`buildContextMessage`（`llm-engine.ts`）將四層記憶注入 gpt-4o-mini 的 prompt。
- 學習**只發生在通話結束的批次寫入**，不是即時、也不是 fine-tuning。
