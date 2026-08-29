import 'dart:convert';
import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:json_schema/json_schema.dart';
import 'package:kanean/capture/capture_service.dart';
import 'package:kanean/capture/ocr.dart';
import 'package:kanean/capture/quality.dart';
import 'package:kanean/contract/receipt_contract.dart';
import 'package:kanean/data/database.dart';

/// **実機で撮った1枚**を素材にした回帰テスト（tasks 7.3 の較正）。
///
/// 合成画像では踏めなかったことが3つ出た。同じ穴に落ちないようここで固定する:
///   1. レシートは紙が白い。「明るい画素の割合」では白飛びを判定できない
///   2. ML Kit は「2026年」と「2月21日」を別の行で返すことがある
///   3. 端末が実際に吐くメタが、契約のスキーマを満たしていなかった
///      （ULID が小文字・日時にオフセットが無い）
void main() {
  final receipt = File('test/fixtures/real-receipt.png');

  group('実機の1枚（スエヒロ館・2026-02-21・¥5,346）', () {
    test('白飛びと指摘しない', () {
      // 輝度250以上が 78%、完全飽和でも 33% ある「普通のレシート」。
      // ここが false positive になると、毎回撮り直しを促して信用されなくなる。
      final report = inspectImage(receipt.readAsBytesSync());
      expect(report.flags, isNot(contains(QualityFlag.glare)),
          reason: 'blownTileRatio=${report.glareRatio}');
    });

    test('ブレとも見切れとも指摘しない', () {
      final report = inspectImage(receipt.readAsBytesSync());
      expect(report.isClean, isTrue, reason: report.flags.toString());
    });
  });

  group('行が割れた日付', () {
    test('「2026年」と「2月21日(土)…」が別の行でも読む', () {
      // 実機で日付が読めなかった原因。年と月の間が広く空いていて行が割れる。
      final ocr = readReceipt(
        ['2026年', '2月21日(土)17時37分000101', '合計 ¥5,346'],
        reference: DateTime(2026, 8, 23),
      );
      expect(ocr.date, '2026-02-21');
      expect(ocr.totalAmount, 5346);
    });

    test('1行に収まっていればそのまま読む', () {
      final ocr = readReceipt(
        ['2026年 2月21日(土)17時37分000101'],
        reference: DateTime(2026, 8, 23),
      );
      expect(ocr.date, '2026-02-21');
    });

    test('繋げて読むのは行単位で見つからなかったときだけ', () {
      // 行内に日付があるなら、行をまたいだ偶然の一致に負けない。
      final ocr = readReceipt(
        ['2026/08/20 のご利用', '2026年', '2月21日'],
        reference: DateTime(2026, 8, 23),
      );
      expect(ocr.date, '2026-08-20');
    });
  });

  group('Apple Vision の実出力', () {
    // Mac の Vision に同じ画像を読ませて得た実際の行（全角括弧に注意）。
    // ML Kit はこの受け取り方をせず「2026年」を落として日付が取れなかった。
    const visionLines = [
      '創業昭和八年',
      'スエヒロ館',
      '国産牛ステーキ・ハンバーグ',
      '本部神奈川県大和市上和田2667-2',
      '2026年 2月21日（土）17時37分000101',
      'バーグ＆赤身カットステーキ',
      '¥2,728内',
      '伝票No.',
      '合計',
      '¥5,346',
    ];

    test('日付と金額を読む', () {
      final ocr = readReceipt(visionLines, reference: DateTime(2026, 8, 23));
      expect(ocr.date, '2026-02-21');
      expect(ocr.totalAmount, 5346);
    });
  });

  group('年を印字しないレシート', () {
    test('参照日を越えない直近の年を当てる', () {
      final ocr = readReceipt(['2月21日 17:37', '合計 ¥5,346'], reference: DateTime(2026, 8, 23));
      expect(ocr.date, '2026-02-21');
    });

    test('年をまたぐときは前年にする', () {
      // 12月のレシートを1月に撮ると、今年で解釈すれば未来になる。
      final ocr = readReceipt(['12月28日', '合計 ¥1,000'], reference: DateTime(2026, 1, 5));
      expect(ocr.date, '2025-12-28');
    });

    test('年つきの解釈が優先される', () {
      final ocr = readReceipt(['2024年3月5日', '2月21日'], reference: DateTime(2026, 8, 23));
      expect(ocr.date, '2024-03-05');
    });
  });

  group('端末が実際に吐くメタ', () {
    test('契約のスキーマを満たす（ULID の大小・日時のオフセット）', () async {
      // ここが本題。フィクスチャは手で書いたので正しかったが、
      // **アプリの実際の出力**は ULID が小文字・日時にオフセット無しで弾かれていた。
      final db = KaneanDatabase(NativeDatabase.memory());
      addTearDown(db.close);
      final tmp = Directory.systemTemp.createTempSync('kanean-real-');
      addTearDown(() => tmp.deleteSync(recursive: true));

      final service = CaptureService(
        db: db,
        recognizer: _NoopRecognizer(),
        storageDir: () async => tmp,
      );
      final draft = await service.inspect(receipt.path);
      await service.accept(
        draft: draft,
        context: const CaptureContext(
          paymentMethod: PaymentMethod.cash,
          usage: ReceiptUsage.business,
          partySize: 2,
        ),
      );

      final meta = KaneanDatabase.metaOf((await db.select(db.captures).get()).single);
      final schema = JsonSchema.create(
        jsonDecode(
          File('../packages/shared/contract/receipt/receipt-meta.schema.json').readAsStringSync(),
        ) as Map<String, dynamic>,
      );
      final result = schema.validate(meta.toJson());
      expect(result.isValid, isTrue, reason: result.errors.join(' / '));
    });
  });
}

class _NoopRecognizer implements ReceiptTextRecognizer {
  @override
  Future<OcrLines> recognize(String imagePath) async => const [];
}
