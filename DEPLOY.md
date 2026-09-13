# GitHub Pages デプロイ手順

CrossView は GitHub Actions を使って GitHub Pages（Project Pages）へ自動デプロイされます。
`.env` の Google Maps API キーはリポジトリへコミットせず、GitHub Secrets / Variables から Vite ビルドへ渡します。

## 1. リポジトリ設定

1. GitHub リポジトリの **Settings > Pages** を開く
2. **Source** を `GitHub Actions` に設定

## 2. Secret / Variable の登録

**Settings > Secrets and variables > Actions** で以下を登録します。

| 種別 | 名前 | 値 |
| --- | --- | --- |
| Secret | `VITE_GOOGLE_MAPS_API_KEY` | Google Maps API キー |
| Variable（または Secret でも可） | `VITE_GOOGLE_MAPS_MAP_ID` | Google Maps Map ID |

APIキー自体は workflow の yaml やソースコードに直書きしないこと。

## 3. デプロイ

`main` ブランチへ push すると `.github/workflows/deploy.yml` が実行され、
`npm ci` → `npm run build` → `dist` を GitHub Pages artifact としてアップロード → デプロイ、という流れで公開されます。

Actions の実行完了後、以下の形式の URL でアクセスできます。

```
https://<username>.github.io/crossview/
```

（現在のリポジトリは `ShuntaIshida/crossview` のため `https://shuntaishida.github.io/crossview/`）

## 4. Google Maps API キーの制限（Google Cloud Console）

API キーはブラウザ側に露出するため、「隠す」のではなく HTTP referrer 制限 と API 制限で保護します。

**Application restrictions: HTTP referrers**

以下を許可リストに追加してください。

```
http://localhost:*
http://localhost:5173/*
https://<username>.github.io/crossview/*
```

**API restrictions**

```
Maps JavaScript API
```

## 5. 補足

- CrossView は History API によるルーティングを使用しない単一ページアプリのため、GitHub Pages 用の `404.html` SPA フォールバックは不要（未追加）。
- Vite の `base` は `"./"`（相対パス）のままで、GitHub Pages のサブパス（`/crossview/`）配下でも asset は正しく解決されます。
- 動画ファイル（MP4）は GitHub へアップロードされず、ユーザーのブラウザ内（File API / Blob / Canvas / IndexedDB）でのみ処理されます。この挙動は変更していません。
