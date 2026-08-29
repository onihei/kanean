import 'package:flutter_test/flutter_test.dart';
import 'package:kanean/capture/ocr.dart';

/// 端末内の下読み（receipt-capture spec「日付と金額をその場で見せる」）。
/// **拾えないことは失敗ではない。** 推測で埋める方が害が大きい（正は Mac 側）。
void main() {
  final reference = DateTime(2026, 8, 14);

  group('日付', () {
    test('西暦のスラッシュ区切り', () {
      expect(readReceipt(['2026/08/14 12:34'], reference: reference).date, '2026-08-14');
    });

    test('年月日', () {
      expect(readReceipt(['2026年8月14日'], reference: reference).date, '2026-08-14');
    });

    test('令和', () {
      expect(readReceipt(['令和8年8月14日'], reference: reference).date, '2026-08-14');
      expect(readReceipt(['R8.8.14'], reference: reference).date, '2026-08-14');
    });

    test('2桁年', () {
      expect(readReceipt(['26.08.14'], reference: reference).date, '2026-08-14');
    });

    test('全角', () {
      expect(readReceipt(['２０２６／０８／１４'], reference: reference).date, '2026-08-14');
    });

    test('複数あれば参照日に近いものを採る', () {
      // 有効期限やキャンペーン告知が混ざっても、発行日を選ぶ。
      final ocr = readReceipt(
        ['クーポン有効期限 2027/03/31', '2026/08/14 19:02', 'ご来店ありがとうございます'],
        reference: reference,
      );
      expect(ocr.date, '2026-08-14');
    });

    test('あり得ない日付は拾わない', () {
      expect(readReceipt(['2026/02/31'], reference: reference).date, isNull);
      expect(readReceipt(['2026/13/01'], reference: reference).date, isNull);
    });

    test('日付が無ければ null（撮影は成立する）', () {
      expect(readReceipt(['ありがとうございました'], reference: reference).date, isNull);
    });
  });

  group('合計金額', () {
    test('合計の行を採る', () {
      final ocr = readReceipt(
        ['小計 ¥11,636', '消費税 ¥1,164', '合計 ¥12,800'],
        reference: reference,
      );
      expect(ocr.totalAmount, 12800);
    });

    test('お預り・おつりを合計と取り違えない', () {
      // ここを間違えると預り金が仕訳の額になる。
      final ocr = readReceipt(
        ['合計 1,200円', 'お預り 5,000円', 'おつり 3,800円'],
        reference: reference,
      );
      expect(ocr.totalAmount, 1200);
    });

    test('現金の行を合計と取り違えない', () {
      final ocr = readReceipt(
        ['合計 ¥980', '現金 ¥1,000', '釣銭 ¥20'],
        reference: reference,
      );
      expect(ocr.totalAmount, 980);
    });

    test('合計語が無ければ最大額を採る', () {
      final ocr = readReceipt(['コーヒー ¥450', 'サンド ¥680', '¥1,130'], reference: reference);
      expect(ocr.totalAmount, 1130);
    });

    test('全角と￥', () {
      expect(readReceipt(['合計 ￥１，２００'], reference: reference).totalAmount, 1200);
    });

    test('裸の数字は金額として拾わない', () {
      // レシート番号・電話番号を金額にしない。
      expect(readReceipt(['レシート番号 123456', 'TEL 03 1234 5678'], reference: reference).totalAmount, isNull);
    });

    test('金額が無ければ null', () {
      expect(readReceipt(['ありがとうございました'], reference: reference).totalAmount, isNull);
    });
  });

  test('何も読めなくても空の結果を返す（例外にしない）', () {
    final ocr = readReceipt([], reference: reference);
    expect(ocr.isEmpty, isTrue);
  });
}
