# 出撃備忘録（ARC Raiders）

タイマー本体とは別の、**出撃の備忘録**アプリです。

## 使い方

1. **スケジュール**タブで今週のトライアルカードを見る
2. 時間枠の **「この枠で出撃」** を押す
3. **出撃メモ**タブで参加者をドラッグして付ける
4. 必要なら **Discord用コピー**

メンバーはアイコン画像のドロップ、または（任意）Discord Bot からの取り込みです。

## 起動

```bash
cd C:\Users\kaze8\Documents\project\ArcRaidersSortieMemo
npm install
npm run dev
```

http://localhost:5174

スケジュールは `/api/metaforge` 経由で MetaForge から取得します（開発は Vite、本番は Vercel Function）。
`dist/index.html` を直接開いても API が動かないので、必ず `npm run dev` かデプロイ先 URL を使ってください。

本番 URL: https://arc-raiders-sortie-memo.vercel.app


## Discord 取込（任意）

`.env.local` に Bot トークンとサーバー ID を置くと「Discord取込」が使えます。詳細は以前の README と同じです。

## 出撃予定の共有

出撃枠・参加者・名簿は **Supabase（無料枠・カード不要）** に保存され、同じ URL を開いた端末同士で同期されます（約30秒ごと＋タブ再表示時）。

### セットアップ（初回・約3分）

1. [Supabase](https://supabase.com/) でアカウント作成 → **New project**（Free）
2. 左メニュー **SQL Editor** → New query → リポジトリの `supabase/sortie_board.sql` を貼って **Run**
3. **Project Settings → API** から次をコピー  
   - Project URL → `SUPABASE_URL`  
   - `service_role`（secret）→ `SUPABASE_SERVICE_ROLE_KEY`  
   ※ `anon` public ではなく **service_role** を使ってください（サーバ専用）
4. ローカルは `.env.local`、本番は Vercel Environment Variables に設定
5. `npm run dev` を再起動。必要なら `npm run migrate:supabase`

旧 Gist 設定が残っていて Supabase が空なら、起動時に **一度だけ自動移行**します。

未設定のローカル開発では `data/shared-sorties.json` に保存します（端末間同期なし）。
