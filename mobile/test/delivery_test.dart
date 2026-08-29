import 'dart:convert';
import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:kanean/capture/capture_service.dart';
import 'package:kanean/capture/ocr.dart';
import 'package:kanean/contract/receipt_contract.dart';
import 'package:kanean/data/database.dart';
import 'package:kanean/transport/delivery_service.dart';
import 'package:kanean/transport/transport.dart';

/// 撮影 → 受理 → 送信 → status 取り込み、を実ファイルで通す
/// （receipt-capture / receipt-inbox spec）。搬送だけ差し替えて iCloud の代わりに
/// ローカルディレクトリを使う — インタフェースを1枚挟んである意味がここに出る。
class FakeTransport extends DirectoryTransport {
  FakeTransport(this.root, {this.available = true, this.failWrites = false});

  final Directory root;
  bool available;
  bool failWrites;

  @override
  Future<Directory?> resolveRoot() async => available ? root : null;

  @override
  Future<void> putPair({required ReceiptMeta meta, required File image}) {
    if (failWrites) throw const TransportUnavailable();
    return super.putPair(meta: meta, image: image);
  }
}

class FakeRecognizer implements ReceiptTextRecognizer {
  FakeRecognizer(this.lines);
  final OcrLines lines;
  @override
  Future<OcrLines> recognize(String imagePath) async => lines;
}

/// 認識が壊れても撮影は成立する、を確かめるための壊れた実装。
class ThrowingRecognizer implements ReceiptTextRecognizer {
  @override
  Future<OcrLines> recognize(String imagePath) async => throw StateError('認識器が落ちた');
}

void main() {
  late Directory tmp;
  late KaneanDatabase db;
  late FakeTransport transport;
  var idSeq = 0;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('kanean-delivery-');
    db = KaneanDatabase(NativeDatabase.memory());
    transport = FakeTransport(Directory('${tmp.path}/cloud'));
    idSeq = 0;
  });
  tearDown(() async {
    await db.close();
    tmp.deleteSync(recursive: true);
  });

  String nextId() => '01JZQK8F3M4N5P6R7S8T9VWX${(++idSeq).toString().padLeft(2, '0')}';

  /// ピントの合った紙面を1枚作って保存する。
  File writeImage(String name) {
    final image = img.Image(width: 200, height: 340);
    img.fill(image, color: img.ColorRgb8(245, 245, 245));
    for (var row = 20; row < 320; row += 16) {
      img.fillRect(image, x1: 20, y1: row, x2: 160, y2: row + 6,
          color: img.ColorRgb8(20, 20, 20));
    }
    final file = File('${tmp.path}/$name')..writeAsBytesSync(img.encodeJpg(image));
    return file;
  }

  CaptureService captureService({ReceiptTextRecognizer? recognizer}) => CaptureService(
        db: db,
        recognizer: recognizer ?? FakeRecognizer(['合計 ¥1,200', '2026/08/14']),
        now: () => DateTime.utc(2026, 8, 14, 3),
        newId: nextId,
        // 実機では getApplicationSupportDirectory。テストでは一時領域に逃がす。
        storageDir: () async => Directory('${tmp.path}/store')..createSync(recursive: true),
      );

  DeliveryService delivery() => DeliveryService(
        db: db,
        transport: transport,
        now: () => DateTime.utc(2026, 8, 14, 4),
      );

  Future<String> captureOne({
    PaymentMethod payment = PaymentMethod.cash,
    ReceiptTextRecognizer? recognizer,
    String name = 'a.jpg',
  }) async {
    final service = captureService(recognizer: recognizer);
    final draft = await service.inspect(writeImage(name).path);
    return service.accept(
      draft: draft,
      context: CaptureContext(paymentMethod: payment, partySize: 3, participants: const ['山田']),
    );
  }

  group('撮影の受理', () {
    test('通信できなくても受理して残る', () async {
      transport.available = false;
      final id = await captureOne();
      expect((await db.pendingQueue()).map((c) => c.id), [id]);
    });

    test('一時ディレクトリを抱えず、永続領域へ写す', () async {
      // スキャナの出力は iOS が消しうる。消えても送れることを固定する。
      final service = captureService();
      final scanned = writeImage('scanned.jpg');
      final draft = await service.inspect(scanned.path);
      final id = await service.accept(
        draft: draft,
        context: const CaptureContext(paymentMethod: PaymentMethod.cash),
      );
      final row = (await db.select(db.captures).get()).single;
      expect(row.imagePath, isNot(scanned.path));
      expect(File(row.imagePath).existsSync(), isTrue);

      // 一時ファイルが消えても送信は通る。
      scanned.deleteSync();
      final outcome = await delivery().deliverPending();
      expect(outcome.sent, 1);
      expect(File('${transport.root.path}/inbox/$id.jpg').existsSync(), isTrue);
    });

    test('撮影時に SHA-256 とサイズが載る', () async {
      await captureOne();
      final row = (await db.select(db.captures).get()).single;
      expect(row.imageSha256, matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(row.imageSizeBytes, greaterThan(0));
    });

    test('端末 OCR の下読みが載る', () async {
      await captureOne();
      final row = (await db.select(db.captures).get()).single;
      expect(row.ocrDate, '2026-08-14');
      expect(row.ocrTotalAmount, 1200);
    });

    test('認識器が落ちても撮影は成立する', () async {
      await captureOne(recognizer: ThrowingRecognizer());
      final row = (await db.select(db.captures).get()).single;
      expect(row.ocrDate, isNull);
      expect(row.ocrTotalAmount, isNull);
      // 支払手段は欠けない。
      expect(row.paymentMethod, 'cash');
    });

    test('撮影時の文脈が残る', () async {
      await captureOne();
      final row = (await db.select(db.captures).get()).single;
      expect(row.mealPartySize, 3);
      expect(jsonDecode(row.mealParticipants!), ['山田']);
    });
  });

  group('送信', () {
    test('画像とメタを対で置く', () async {
      final id = await captureOne();
      final outcome = await delivery().deliverPending();
      expect(outcome.sent, 1);

      final inbox = Directory('${transport.root.path}/inbox');
      final names = inbox.listSync().map((e) => e.path.split('/').last).toSet();
      expect(names, containsAll(['$id.jpg', '$id.json']));

      // メタは契約どおりに読める。
      final meta = ReceiptMeta.fromJson(
        jsonDecode(File('${inbox.path}/$id.json').readAsStringSync()) as Map<String, dynamic>,
      );
      expect(meta.id, id);
      expect(meta.paymentMethod, PaymentMethod.cash);
      expect(meta.image.fileName, '$id.jpg');
    });

    test('カードもそのまま運ぶ（振り分けるのは Mac 側）', () async {
      final id = await captureOne(payment: PaymentMethod.card);
      await delivery().deliverPending();
      final meta = ReceiptMeta.fromJson(
        jsonDecode(File('${transport.root.path}/inbox/$id.json').readAsStringSync())
            as Map<String, dynamic>,
      );
      expect(meta.paymentMethod, PaymentMethod.card);
    });

    test('送信済みは列から外れるが「登録済み」にはならない', () async {
      await captureOne();
      await delivery().deliverPending();
      expect(await db.pendingQueue(), isEmpty);
      expect((await db.history()).single.state, CaptureState.sent);
    });

    test('搬送先が使えないときは手つかずで残す', () async {
      await captureOne();
      transport.available = false;
      final outcome = await delivery().deliverPending();
      expect(outcome.unavailable, isTrue);
      expect(await db.pendingQueue(), hasLength(1));
      // 試行回数も増やさない（使えないことは失敗ではない）。
      expect((await db.select(db.captures).get()).single.attempts, 0);
    });

    test('失敗しても件を消さず、上限で要対応に落とす', () async {
      await captureOne();
      transport.failWrites = true;
      for (var i = 0; i < 5; i++) {
        await delivery().deliverPending();
      }
      final row = (await db.select(db.captures).get()).single;
      expect(row.attempts, 5);
      expect(row.deliveryState, 'failed');
      expect(row.lastError, isNotNull);
      // 消えていない。
      expect((await db.history()).single.state, CaptureState.needsAttention);
    });

    test('1件の失敗で列を止めない', () async {
      await captureOne(name: 'a.jpg');
      await captureOne(name: 'b.jpg');
      // 1件目の画像だけ消して失敗させる。
      final first = (await db.pendingQueue()).first;
      File(first.imagePath).deleteSync();

      final outcome = await delivery().deliverPending();
      expect(outcome.sent, 1);
      expect(outcome.failed, 1);
    });
  });

  group('status の取り込み', () {
    Future<void> putStatus(String id, ReceiptStatus status) async {
      final dir = Directory('${transport.root.path}/status')..createSync(recursive: true);
      File('${dir.path}/$id.json').writeAsStringSync(jsonEncode(status.toJson()));
    }

    test('登録済みを取り込み、搬送上の status を片付ける', () async {
      final id = await captureOne();
      await delivery().deliverPending();
      await putStatus(
        id,
        ReceiptStatus(
          id: id,
          processedAt: '2026-08-14T21:00:00+09:00',
          registered: true,
          summary: const ReceiptSummary(
            entryId: 4821,
            date: '2026-08-14',
            totalAmount: 1200,
            accountName: '消耗品費',
          ),
        ),
      );

      expect(await delivery().ingestStatuses(), 1);
      final row = (await db.history()).single;
      expect(row.state, CaptureState.registered);
      expect(row.status!.summary!.accountName, '消耗品費');
      // 端末に保存できたので、搬送上の status は消えている。
      expect(File('${transport.root.path}/status/$id.json').existsSync(), isFalse);
    });

    test('未登録の理由を取り込む', () async {
      final id = await captureOne();
      await delivery().deliverPending();
      await putStatus(
        id,
        ReceiptStatus(
          id: id,
          processedAt: '2026-08-14T21:00:00+09:00',
          registered: false,
          reason: ReceiptSkipReason.unmatchedCard,
          detail: '一致するカード明細が無い',
        ),
      );

      await delivery().ingestStatuses();
      final row = (await db.history()).single;
      expect(row.state, CaptureState.needsAttention);
      expect(row.status!.reason, ReceiptSkipReason.unmatchedCard);
      expect(row.status!.detail, '一致するカード明細が無い');
    });

    test('壊れた status を捨てない（次の機会に読む）', () async {
      final id = await captureOne();
      await delivery().deliverPending();
      final dir = Directory('${transport.root.path}/status')..createSync(recursive: true);
      // 同期の途中で切れたファイル。
      File('${dir.path}/$id.json').writeAsStringSync('{"schemaVersion": 1, "id"');

      expect(await delivery().ingestStatuses(), 0);
      expect(File('${dir.path}/$id.json').existsSync(), isTrue);
    });

    test('status が無ければ何も変わらない', () async {
      await captureOne();
      await delivery().deliverPending();
      expect(await delivery().ingestStatuses(), 0);
      expect((await db.history()).single.state, CaptureState.sent);
    });
  });
}
