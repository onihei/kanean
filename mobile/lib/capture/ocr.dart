import '../contract/receipt_contract.dart';

/// 端末内の文字認識から日付と金額を拾う（receipt-capture spec「日付と金額をその場で見せる」）。
///
/// **これは目視確認の補助であって、読み取りの正ではない。**
/// 正は Mac 側（Claude が画像を読む）にあるので、拾えなければ空のまま送ってよい。
/// ここで無理に推測すると、利用者が「合っている」と思い込んだまま誤った値が流れる。
///
/// 認識エンジン（ML Kit）に依存するのは文字列を得るところまでで、
/// **そこから先の解釈は純粋な文字列処理**なのでテストできる。

/// 認識された行。エンジンを差し替えても、ここから先は変わらない。
typedef OcrLines = List<String>;

/// 合計金額が書かれている行を指す語。上にあるものほど強く信じる。
const _totalKeywords = <String>[
  '合計',
  '合 計',
  'お買上げ計',
  'お買い上げ計',
  '計',
  '税込',
  'total',
  'Total',
  'TOTAL',
];

/// 合計ではないのに金額が並ぶ行。ここを合計と取り違えると額がずれる。
const _notTotalKeywords = <String>[
  'お預り',
  'お預かり',
  '預り',
  'おつり',
  'お釣り',
  '釣銭',
  '現金',
  '小計',
  '内税',
  '外税',
  '消費税',
  'ポイント',
  '対象計',
];

/// 和暦（令和）の開始年。`R8` → 2026。
const _reiwaBaseYear = 2018;

/// 認識結果から日付と金額を拾う。拾えなかった側は null のまま返す。
ReceiptOcr readReceipt(OcrLines lines, {required DateTime reference}) {
  return ReceiptOcr(
    date: _findDate(lines, reference: reference),
    totalAmount: _findTotal(lines),
  );
}

/// 日付。複数見つかったら**参照日に最も近いもの**を採る（発行日より後の日付は普通レシートに無い）。
String? _findDate(OcrLines lines, {required DateTime reference}) {
  final found = <DateTime>[];
  for (final line in lines) {
    // 全角を寄せてから見る（OCR は「２０２６／０８／１４」のように返すことがある）。
    found.addAll(_datesIn(_toHalfWidth(line), reference: reference));
  }
  if (found.isEmpty) {
    // 行の中で完結していないことがある。行単位で見つからなかったときだけ繋げて見る。
    found.addAll(_datesIn(_toHalfWidth(lines.join(' ')), reference: reference));
  }
  if (found.isEmpty) {
    // 年を印字しないレシートは珍しくない（「2/21」「2月21日」だけ）。
    // レシートの日付が未来になることはないので、**参照日を越えない直近の年**を当てる。
    found.addAll(_monthDayDates(lines, reference: reference));
  }
  if (found.isEmpty) return null;
  found.sort((a, b) {
    final da = (a.difference(reference)).abs();
    final db = (b.difference(reference)).abs();
    return da.compareTo(db);
  });
  final d = found.first;
  return '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';
}

final _wareki = RegExp(r'(?:令和|令|R|Ｒ)\s*(\d{1,2})\s*[年\.\-/]\s*(\d{1,2})\s*[月\.\-/]\s*(\d{1,2})');
final _seireki = RegExp(r'(\d{4})\s*[年\.\-/]\s*(\d{1,2})\s*[月\.\-/]\s*(\d{1,2})');
final _shortYear = RegExp(r'(?<!\d)(\d{2})\s*[\.\-/]\s*(\d{1,2})\s*[\.\-/]\s*(\d{1,2})(?!\d)');

List<DateTime> _datesIn(String line, {required DateTime reference}) {
  final out = <DateTime>[];
  void add(int y, int m, int d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    final dt = DateTime(y, m, d);
    // 月末を越えた指定（2月31日など）は DateTime が繰り上げるので、元の値と一致するものだけ採る。
    if (dt.month != m || dt.day != d) return;
    out.add(dt);
  }

  for (final m in _wareki.allMatches(line)) {
    add(_reiwaBaseYear + int.parse(m.group(1)!), int.parse(m.group(2)!), int.parse(m.group(3)!));
  }
  for (final m in _seireki.allMatches(line)) {
    add(int.parse(m.group(1)!), int.parse(m.group(2)!), int.parse(m.group(3)!));
  }
  if (out.isEmpty) {
    // 4桁年が無いときだけ 2桁年を見る（「12/25 1,200円」のような行を日付と誤読しないため、
    // 3つ組になっているものに限る）。
    for (final m in _shortYear.allMatches(line)) {
      final yy = int.parse(m.group(1)!);
      final century = (reference.year ~/ 100) * 100;
      add(century + yy, int.parse(m.group(2)!), int.parse(m.group(3)!));
    }
  }
  return out;
}

/// 年の無い「2月21日」「2/21」。年つきの解釈が先に効くので、ここへ来るのは
/// 年がどこにも無かったときだけ。
final _monthDay = RegExp(r'(?<!\d)(\d{1,2})\s*[月/\-\.]\s*(\d{1,2})\s*日?(?!\d)');

List<DateTime> _monthDayDates(OcrLines lines, {required DateTime reference}) {
  final out = <DateTime>[];
  for (final line in lines) {
    for (final m in _monthDay.allMatches(_toHalfWidth(line))) {
      final mm = int.parse(m.group(1)!);
      final dd = int.parse(m.group(2)!);
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
      // 今年で解釈して未来になるなら前年（12月のレシートを1月に撮る場合）。
      for (final year in [reference.year, reference.year - 1]) {
        final dt = DateTime(year, mm, dd);
        if (dt.month != mm || dt.day != dd) continue;
        if (dt.isAfter(reference)) continue;
        out.add(dt);
        break;
      }
    }
  }
  return out;
}

final _amount = RegExp(r'[¥￥]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*円?');

/// 合計。合計語のある行を優先し、無ければ**最大の金額**を採る
/// （レシートで最大額はたいてい合計。ただし当てにならないので Mac 側が正）。
int? _findTotal(OcrLines lines) {
  final candidates = <int>[];
  for (final line in lines) {
    final normalized = _toHalfWidth(line);
    if (_notTotalKeywords.any(normalized.contains)) continue;
    if (!_totalKeywords.any(normalized.contains)) continue;
    candidates.addAll(_amountsIn(normalized));
  }
  if (candidates.isNotEmpty) return candidates.reduce((a, b) => a > b ? a : b);

  final all = <int>[];
  for (final line in lines) {
    final normalized = _toHalfWidth(line);
    if (_notTotalKeywords.any(normalized.contains)) continue;
    all.addAll(_amountsIn(normalized));
  }
  if (all.isEmpty) return null;
  return all.reduce((a, b) => a > b ? a : b);
}

List<int> _amountsIn(String line) {
  final out = <int>[];
  for (final m in _amount.allMatches(line)) {
    final raw = m.group(1)!.replaceAll(',', '');
    // 桁が異常なものは金額ではない（電話番号・登録番号など）。
    if (raw.length > 9) continue;
    final v = int.tryParse(raw);
    // 区切りも通貨記号も無い裸の数字は、レシート番号等と区別できないので拾わない。
    final decorated = m.group(0)!.contains(RegExp(r'[¥￥,円]'));
    if (v != null && v > 0 && decorated) out.add(v);
  }
  return out;
}

/// 全角の数字・記号を半角に寄せる（OCR は全角で返すことがある）。
String _toHalfWidth(String s) {
  final buf = StringBuffer();
  for (final rune in s.runes) {
    if (rune >= 0xFF10 && rune <= 0xFF19) {
      buf.writeCharCode(rune - 0xFF10 + 0x30); // ０-９
    } else if (rune == 0xFF0C) {
      buf.write(','); // ，
    } else if (rune == 0xFF0E) {
      buf.write('.'); // ．
    } else if (rune == 0xFF0F) {
      buf.write('/'); // ／
    } else {
      buf.writeCharCode(rune);
    }
  }
  return buf.toString();
}

/// 文字認識そのもの。プラグインを差し替えられるよう1枚挟む
/// （iOS の品質が足りなければ platform channel で Vision を呼ぶ余地を残す）。
abstract interface class ReceiptTextRecognizer {
  Future<OcrLines> recognize(String imagePath);
}
