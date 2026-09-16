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

出撃枠・参加者は **GitHub Gist（無料）** に保存され、同じ URL を開いた人同士で同期されます（約20秒ごと＋タブ再表示時）。
メンバー名簿やマップ／イベントの個人設定は、各ブラウザの localStorage のままです。

Upstash などの従量課金ストレージは使いません。Vercel の Hobby 無料枠＋ GitHub の無料 Gist だけで動きます。

ローカル開発で Gist 設定が無いときは `data/shared-sorties.json` に保存します。
