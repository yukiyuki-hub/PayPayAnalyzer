import { useState } from 'react';
import Papa from 'papaparse';

// -----------------------------------------------
// 列名の候補（PayPayはバージョンによって列名が変わる可能性があるため複数持つ）
// -----------------------------------------------
const COLUMN_CANDIDATES = {
  date:   ['取引日', '取引日時', '日付', 'date'],
  amount: ['出金金額', '支払い金額', '出金金額(円)', '支払い金額(円)', 'amount', 'payment'],
  vendor: ['取引先', '店舗名', '支払先', 'vendor', 'store'],
  type:   ['取引種別', '取引内容', '種別', 'type'],
};

// ヘッダー行（文字列配列）から対象フィールドの列インデックスを返す
// 完全一致のほか、列名が候補文字列を"含む"場合も一致とみなす（例: "出金金額(円)" → "出金金額" にマッチ）
function detectColIndex(headers, candidates) {
  const normalized = headers.map(h => String(h ?? '').trim().toLowerCase());
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const idx = normalized.findIndex(h => h === lower || h.includes(lower));
    if (idx !== -1) return idx;
  }
  return -1;
}

// CSVの全行を走査してヘッダー行のインデックスを特定する
// PayPayのCSVは先頭に「出力期間」などのメタ行が含まれる場合があるため
function findHeaderRowIndex(rows) {
  const allCandidates = Object.values(COLUMN_CANDIDATES)
    .flat()
    .map(c => c.toLowerCase());

  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(cell => String(cell ?? '').trim().toLowerCase());
    // 候補列名が2つ以上含まれる行をヘッダーとみなす
    const matchCount = allCandidates.filter(c => cells.some(cell => cell === c || cell.includes(c))).length;
    if (matchCount >= 2) return i;
  }
  return 0; // 見つからなければ先頭行をヘッダーとして扱う
}

// 金額文字列を正の数値に変換する
// 「1,200」→ 1200、「-550」→ 550（マイナス表記も出金として扱う）、空欄 → 0
function parseAmount(value) {
  if (value === null || value === undefined || String(value).trim() === '') return 0;
  const cleaned = String(value).replace(/[,¥￥\s]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return Math.abs(num); // マイナス表記でも絶対値を出金額とする
}

// 日付文字列をDateオブジェクトに変換する
// 「2024/01/15」「2024/01/15 12:00:00」「2024-01-15」などに対応
function parseDate(value) {
  if (!value) return null;
  // 日付部分のみ抽出（時刻・スペースを除去してからスラッシュをハイフンへ）
  const dateOnly = String(value).trim().split(/[\s　T]/)[0].replace(/\//g, '-');
  const d = new Date(`${dateOnly}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

// 金額を「¥1,200」形式の日本円表記に変換する
function formatCurrency(amount) {
  return `¥${Math.round(amount).toLocaleString('ja-JP')}`;
}

// 1〜3位に対応するラベルを返す（それ以外は数字のみ）
function getRankLabel(rank) {
  if (rank === 1) return '1位';
  if (rank === 2) return '2位';
  if (rank === 3) return '3位';
  return `${rank}位`;
}

// -----------------------------------------------
// メインコンポーネント
// -----------------------------------------------
export default function App() {
  // CSVの生データ（{ headerRowIndex, rows } の形式）
  const [csvData, setCsvData] = useState(null);
  // アップロードされたファイル名（表示用）
  const [fileName, setFileName] = useState('');
  // 絞り込み期間
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate]     = useState('');
  // 分析結果（取引先ごとの集計 TOP30）
  const [results, setResults]         = useState(null);
  // 期間内の出金合計額
  const [totalAmount, setTotalAmount] = useState(0);
  // エラーメッセージ（空文字 = エラーなし）
  const [error, setError] = useState('');

  // -----------------------------------------------
  // CSVファイルがアップロードされたときの処理
  // -----------------------------------------------
  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    setFileName(file.name);
    setError('');
    setResults(null);
    setCsvData(null);

    Papa.parse(file, {
      header: false,       // 生の配列として取得（ヘッダー行を自力で検出するため）
      skipEmptyLines: true,
      complete: (result) => {
        if (result.errors.length > 0 && result.data.length === 0) {
          setError('CSVの読み込みに失敗しました。ファイルを確認してください。');
          return;
        }
        const rows = result.data;
        const headerRowIndex = findHeaderRowIndex(rows);
        setCsvData({ headerRowIndex, rows });
      },
      error: () => {
        setError('CSVの読み込みに失敗しました。ファイルを確認してください。');
      },
    });
  }

  // -----------------------------------------------
  // 「分析する」ボタンが押されたときの処理
  // -----------------------------------------------
  function handleAnalyze() {
    setError('');
    setResults(null);

    // バリデーション
    if (!csvData) {
      setError('CSVファイルを先にアップロードしてください。');
      return;
    }
    if (!startDate || !endDate) {
      setError('開始日と終了日を入力してください。');
      return;
    }
    if (startDate > endDate) {
      setError('開始日は終了日より前の日付を指定してください。');
      return;
    }

    const { headerRowIndex, rows } = csvData;
    const headers  = rows[headerRowIndex];  // ヘッダー行
    const dataRows = rows.slice(headerRowIndex + 1); // データ行

    // 各フィールドの列インデックスを検出
    const dateColIdx   = detectColIndex(headers, COLUMN_CANDIDATES.date);
    const amountColIdx = detectColIndex(headers, COLUMN_CANDIDATES.amount);
    const vendorColIdx = detectColIndex(headers, COLUMN_CANDIDATES.vendor);
    // 取引種別列（存在しない場合は -1 のまま → 全行を対象にする）
    const typeColIdx   = detectColIndex(headers, COLUMN_CANDIDATES.type);

    if (dateColIdx === -1) {
      setError(`取引日の列が見つかりませんでした。対応列名: ${COLUMN_CANDIDATES.date.join(' / ')}`);
      return;
    }
    if (amountColIdx === -1) {
      setError(`出金金額の列が見つかりませんでした。対応列名: ${COLUMN_CANDIDATES.amount.join(' / ')}`);
      return;
    }
    if (vendorColIdx === -1) {
      setError(`取引先の列が見つかりませんでした。対応列名: ${COLUMN_CANDIDATES.vendor.join(' / ')}`);
      return;
    }

    // 絞り込み期間（終了日は当日の終わりまで含める）
    const start = new Date(`${startDate}T00:00:00`);
    const end   = new Date(`${endDate}T23:59:59`);

    // -----------------------------------------------
    // データ集計：期間内の出金行を取引先ごとにまとめる
    // -----------------------------------------------
    const vendorMap = {}; // { 取引先名: { vendor, total, count } }
    let total = 0;

    for (const row of dataRows) {
      // 日付チェック：期間外の行はスキップ
      const date = parseDate(row[dateColIdx]);
      if (!date || date < start || date > end) continue;

      // 取引種別が取得できる場合、「支払い」を含む行のみ対象にする
      if (typeColIdx !== -1) {
        const txType = String(row[typeColIdx] ?? '').trim();
        if (!txType.includes('支払い')) continue;
      }

      // 出金金額を取得し、0または空欄の行はランキング対象外
      const amount = parseAmount(row[amountColIdx]);
      if (amount <= 0) continue;

      // 取引先名（空欄の場合は「不明」）
      const vendor = String(row[vendorColIdx] ?? '').trim() || '不明';

      // 取引先ごとに合算
      if (!vendorMap[vendor]) {
        vendorMap[vendor] = { vendor, total: 0, count: 0 };
      }
      vendorMap[vendor].total += amount;
      vendorMap[vendor].count += 1;
      total += amount;
    }

    // 合計金額の大きい順に並べてTOP30を取り出す
    const sorted = Object.values(vendorMap)
      .sort((a, b) => b.total - a.total)
      .slice(0, 30);

    if (sorted.length === 0) {
      setError('指定期間内に出金データが見つかりませんでした。期間を確認してください。');
      return;
    }

    setTotalAmount(total);
    setResults(sorted);
  }

  // アップロード済みデータ行数（ヘッダー行・メタ行を除く）
  const dataCount = csvData
    ? csvData.rows.length - csvData.headerRowIndex - 1
    : 0;

  return (
    <div className="container">
      <h1 className="title">PayPay 出金ランキング分析</h1>

      {/* ── CSVアップロード ── */}
      <section className="card">
        <h2 className="section-title">CSVファイルを選択</h2>
        <input
          type="file"
          accept=".csv"
          onChange={handleFileUpload}
          className="file-input"
        />
        {fileName && (
          <p className="file-name">読込済: {fileName}（{dataCount} 件）</p>
        )}
      </section>

      {/* ── 期間指定 & 分析ボタン ── */}
      <section className="card">
        <h2 className="section-title">分析期間を指定</h2>
        <div className="date-row">
          <label className="date-label">
            開始日
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="date-input"
            />
          </label>
          <span className="date-sep">〜</span>
          <label className="date-label">
            終了日
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="date-input"
            />
          </label>
        </div>
        <button className="analyze-btn" onClick={handleAnalyze}>
          分析する
        </button>
      </section>

      {/* ── エラー表示 ── */}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {/* ── 分析結果 ── */}
      {results && (
        <section className="card">
          {/* 出金合計 */}
          <div className="total-box">
            <span className="total-label">期間内の出金合計</span>
            <span className="total-value">{formatCurrency(totalAmount)}</span>
          </div>

          <h2 className="section-title">出金ランキング TOP{results.length}</h2>
          <div className="table-wrapper">
            <table className="ranking-table">
              <thead>
                <tr>
                  <th className="col-rank">順位</th>
                  <th className="col-vendor">取引先</th>
                  <th className="col-amount">合計出金額</th>
                  <th className="col-count">件数</th>
                </tr>
              </thead>
              <tbody>
                {results.map((item, index) => (
                  <tr
                    key={item.vendor}
                    className={index < 3 ? `row-top${index + 1}` : ''}
                  >
                    <td className="col-rank">{getRankLabel(index + 1)}</td>
                    <td className="col-vendor">{item.vendor}</td>
                    <td className="col-amount">{formatCurrency(item.total)}</td>
                    <td className="col-count">{item.count}件</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
