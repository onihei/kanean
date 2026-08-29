import 'dart:convert';

// drift も isNull / isNotNull を export するので、matcher と衝突する名前は隠す。
import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kanean/contract/receipt_contract.dart';
import 'package:kanean/data/database.dart';

/// 端末内の保存と、履歴に出す状態の導出（receipt-capture spec）。
void main() {
  late KaneanDatabase db;

  setUp(() => db = KaneanDatabase(NativeDatabase.memory()));
  tearDown(() => db.close());

  CapturesCompanion capture(
    String id, {
    String state = 'pending',
    String payment = 'cash',
    int? partySize,
    List<String>? participants,
    List<String>? flags,
    String? ocrDate,
    int? ocrTotal,
  }) =>
      CapturesCompanion.insert(
        id: id,
        capturedAt: '2026-08-14T12:00:00+09:00',
        imagePath: '/tmp/$id.jpg',
        imageFileName: '$id.jpg',
        imageContentType: 'image/jpeg',
        imageSizeBytes: 1000,
        imageSha256: 'a' * 64,
        paymentMethod: payment,
        deliveryState: Value(state),
        mealPartySize: Value(partySize),
        mealParticipants:
            Value(participants == null ? null : jsonEncode(participants)),
        qualityFlags: Value(flags == null ? null : jsonEncode(flags)),
        ocrDate: Value(ocrDate),
        ocrTotalAmount: Value(ocrTotal),
      );

  Future<void> putStatus(
    String id, {
    required bool registered,
    ReceiptSkipReason? reason,
  }) =>
      db.into(db.receiptStatuses).insert(ReceiptStatusesCompanion.insert(
            id: id,
            processedAt: '2026-08-14T21:00:00+09:00',
            registered: registered,
            reason: Value(reason?.wire),
            summaryEntryId: Value(registered ? 4821 : null),
            summaryDate: Value(registered ? '2026-08-14' : null),
            summaryTotalAmount: Value(registered ? 12800 : null),
            summaryAccountName: Value(registered ? '消耗品費' : null),
          ));

  group('送信キュー', () {
    test('未送信だけが列に並ぶ', () async {
      await db.into(db.captures).insert(capture('01A'));
      await db.into(db.captures).insert(capture('01B', state: 'sent'));
      final queue = await db.pendingQueue();
      expect(queue.map((c) => c.id), ['01A']);
    });

    test('圏外で撮ったものも受理されて残る', () async {
      await db.into(db.captures).insert(capture('01A'));
      expect((await db.pendingQueue()), hasLength(1));
    });

    test('繰り返し失敗した件を消さず理由を残す', () async {
      await db.into(db.captures).insert(capture('01A'));
      await (db.update(db.captures)..where((t) => t.id.equals('01A'))).write(
        const CapturesCompanion(
          deliveryState: Value('failed'),
          attempts: Value(5),
          lastError: Value('iCloud が使えない'),
        ),
      );
      final row = (await db.history()).single;
      expect(row.state, CaptureState.needsAttention);
      expect(row.capture.lastError, 'iCloud が使えない');
    });
  });

  group('履歴の状態', () {
    test('status が返るまで「登録済み」にしない', () async {
      await db.into(db.captures).insert(capture('01A', state: 'sent'));
      expect((await db.history()).single.state, CaptureState.sent);
    });

    test('登録できたら登録済みと要約を持つ', () async {
      await db.into(db.captures).insert(capture('01A', state: 'sent'));
      await putStatus('01A', registered: true);
      final row = (await db.history()).single;
      expect(row.state, CaptureState.registered);
      expect(row.status!.summary!.accountName, '消耗品費');
      expect(row.status!.summary!.totalAmount, 12800);
    });

    test('重複は既に本体側に証憑があるので登録済み扱い', () async {
      await db.into(db.captures).insert(capture('01A', state: 'sent'));
      await putStatus('01A', registered: false, reason: ReceiptSkipReason.duplicate);
      expect((await db.history()).single.state, CaptureState.registered);
    });

    test('登録されなかった件は要対応として理由を持つ', () async {
      await db.into(db.captures).insert(capture('01A', state: 'sent'));
      await putStatus('01A', registered: false, reason: ReceiptSkipReason.unmatchedCard);
      final row = (await db.history()).single;
      expect(row.state, CaptureState.needsAttention);
      expect(row.status!.reason, ReceiptSkipReason.unmatchedCard);
    });

    test('新しい順に並ぶ', () async {
      await db.into(db.captures).insert(capture('01A'));
      await db.into(db.captures).insert(
            capture('01B').copyWith(capturedAt: const Value('2026-08-15T09:00:00+09:00')),
          );
      expect((await db.history()).map((r) => r.capture.id), ['01B', '01A']);
    });
  });

  group('inbox へ書くメタの組み立て', () {
    test('撮影時の文脈がそのままメタになる', () async {
      await db.into(db.captures).insert(capture(
            '01JZQK8F3M4N5P6R7S8T9VWXYZ',
            partySize: 3,
            participants: ['山田', '鈴木'],
            flags: ['glare'],
            ocrDate: '2026-08-14',
            ocrTotal: 12800,
          ));
      final meta = KaneanDatabase.metaOf((await db.select(db.captures).get()).single);
      expect(meta.paymentMethod, PaymentMethod.cash);
      expect(meta.meal!.partySize, 3);
      expect(meta.meal!.participants, ['山田', '鈴木']);
      expect(meta.qualityFlags, [QualityFlag.glare]);
      expect(meta.ocr!.totalAmount, 12800);
      expect(meta.metaFileName, '01JZQK8F3M4N5P6R7S8T9VWXYZ.json');
    });

    test('読み取れなかったものは空のまま運ぶ', () async {
      await db.into(db.captures).insert(capture('01A'));
      final meta = KaneanDatabase.metaOf((await db.select(db.captures).get()).single);
      expect(meta.ocr, isNull);
      expect(meta.meal, isNull);
      // 支払手段だけは欠けない。
      expect(meta.paymentMethod, PaymentMethod.cash);
    });
  });
}
