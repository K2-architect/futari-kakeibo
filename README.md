# futari-kakeibo（共同家計簿）

2人で使う共同家計簿のスマホ向け画面です。

## 構成

- 画面：このリポジトリの `index.html`（GitHub Pages で公開。`main` のルート）
- データ：スプレッドシート「共同家計簿」にひも付いた Apps Script（`kyodo_webapp.gs` の `doPost`）。画面からは JSON `{ action, args, key }` を POST して読み書きします
- 認証：1人ずつの専用リンク（`?key=…`）。合言葉は Apps Script のスクリプトプロパティ `KW_KEYS` にだけ保存し、このリポジトリには置きません

## API_URL の差し替え方

Apps Script を新しくデプロイして URL が変わったら、`index.html` の次の1行を書き換えて push します。

```js
const API_URL = 'https://script.google.com/macros/s/…/exec';
```

デプロイの設定は「種類：ウェブアプリ」「次のユーザーとして実行：自分」「アクセスできるユーザー：全員」。
コードだけ直したときは、既存のデプロイを「デプロイを管理 → 編集 → 新しいバージョン」で更新すれば URL は変わりません。

## 合言葉の作り直し方

Apps Script のエディタで `kw_issueKeys` を実行すると、2人分の合言葉が作り直され、新しい専用リンクが実行ログに出ます。
それまでのリンクは使えなくなるので、新しいリンクをそれぞれに直接渡し、ホーム画面のアイコンも追加し直します。
